import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection as connectTcp } from "node:net";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConnection, runMigrations, runSeeds, type Sql } from "@aftertick/db";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "redis";
import { NodeControlService } from "../apps/api/src/node-control-service.js";
import { sendRcon } from "../apps/node-agent/src/rcon.js";
import { analyzeDemoArtifact } from "./demo-analysis-worker.js";

interface ManagedChild extends ChildProcess {
  aftertickOutput(): string;
}

interface TestSession {
  playerId: string;
  cookie: string;
  csrf: string;
}

const TEST_PLAYER_IDS = Array.from(
  { length: 10 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);

function parseEnvironment(content: string): Record<string, string> {
  return Object.fromEntries(content
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Malformed node credential file.");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

function schemaDatabaseUrl(databaseUrl: string, schema: string): string {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("options", `-csearch_path=${schema}`);
  return parsed.toString();
}

function launch(command: string, args: string[], environment: NodeJS.ProcessEnv): ManagedChild {
  const child = spawn(command, args, {
    cwd: resolve(import.meta.dirname, ".."),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }) as ManagedChild;
  let output = "";
  child.stdout?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-65_536); });
  child.stderr?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-65_536); });
  child.aftertickOutput = () => output;
  return child;
}

async function stop(child: ManagedChild | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

async function crash(child: ManagedChild | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function waitFor<T>(
  label: string,
  check: () => Promise<T | null | false | undefined>,
  timeoutMs = 45_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(200);
  }
  throw new Error(`${label} timed out.${lastError ? ` ${lastError.message}` : ""}`);
}

async function cleanTestQueue(redisUrl: string): Promise<void> {
  const client = createClient({ url: redisUrl });
  await client.connect();
  try {
    for (const playerId of TEST_PLAYER_IDS) {
      const pointer = `aftertick:player:${playerId}:ticket`;
      const ticketId = await client.get(pointer);
      if (ticketId) {
        const raw = await client.get(`aftertick:queue:ticket:${ticketId}`);
        if (raw) {
          const ticket = JSON.parse(raw) as {
            readyCheck?: { matchId?: string } | null;
            mapVeto?: { matchId?: string } | null;
          };
          const activeMatchId = ticket.readyCheck?.matchId ?? ticket.mapVeto?.matchId;
          if (activeMatchId) {
            await client.del(`aftertick:queue:ready:${activeMatchId}`);
            await client.del(`aftertick:queue:veto:${activeMatchId}`);
            await client.zRem("aftertick:queue:ready:deadlines", activeMatchId);
            await client.zRem("aftertick:queue:veto:deadlines", activeMatchId);
            await client.zRem("aftertick:queue:veto:finalizations", activeMatchId);
          }
        }
        await client.del(`aftertick:queue:ticket:${ticketId}`);
        await client.zRem("aftertick:queue:tickets", ticketId);
      }
      await client.del(pointer);
      await client.del(`aftertick:player:${playerId}:queue-cooldown`);
    }
  } finally {
    await client.quit();
  }
}

async function fixtureServerListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host: "127.0.0.1", port: 27115 });
    const finish = (listening: boolean) => { socket.destroy(); resolve(listening); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

async function checkFixtureProcesses(startedAt?: string): Promise<void> {
  if (process.platform !== "win32") return;
  await new Promise<void>((resolvePromise, reject) => {
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", resolve(import.meta.dirname, "check-platform-fixture-processes.ps1"),
      ...(startedAt ? ["-Cleanup", "-StartedAfterUtc", startedAt] : [])
    ], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else { if (stdout.trim()) console.log(stdout.trim()); resolvePromise(); }
    });
  });
}

async function main(): Promise<void> {
  const fixtureStartedAt = new Date().toISOString();
  const root = resolve(import.meta.dirname, "..");
  const credentials = parseEnvironment(
    await readFile(resolve(root, ".artifacts", "nodes", "local.env"), "utf8")
  );
  if (resolve(credentials["AFTERTICK_SERVER_ROOT"] ?? "") !== resolve(root, ".tools/csgo-server")
    || credentials["AFTERTICK_SRCDS_HOST"] !== "127.0.0.1"
    || credentials["AFTERTICK_SRCDS_PORT"] !== "27115") {
    throw new Error("The platform fixture requires its workspace-local loopback server.");
  }
  await checkFixtureProcesses();
  if (await fixtureServerListening()) {
    throw new Error("The local fixture server port is occupied. Stop that session before testing; nothing was changed.");
  }
  const baseDatabaseUrl = process.env["TEST_DATABASE_URL"]
    ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick";
  const schema = `platform_${randomUUID().replaceAll("-", "")}`;
  const admin = createConnection(baseDatabaseUrl);
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = schemaDatabaseUrl(baseDatabaseUrl, schema);
  const redisUrl = process.env["TEST_REDIS_URL"]
    ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0";
  const origin = "http://127.0.0.1:8793";
  const identitySecret = "aftertick-ten-player-header-secret";
  const s3 = {
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "aftertick-demos",
    accessKey: "aftertick-local",
    secretKey: "aftertick-local-minio-secret"
  };
  const sql: Sql = createConnection(databaseUrl);
  const controls = new NodeControlService(sql, credentials["MANIFEST_SIGNING_SECRET"]!);
  let api: ManagedChild | undefined;
  let agent: ManagedChild | undefined;
  let lastServerPid: number | null = null;
  let leaseId: string | undefined;
  let matchId: string | undefined;
  let crashLeaseId: string | undefined;
  let crashMatchId: string | undefined;
  let noShowLeaseId: string | undefined;
  let noShowMatchId: string | undefined;
  let srcdsFailureDetectedMs: number | undefined;
  try {
    await copyFile(
      resolve(root, ".artifacts", "sourcemod", "aftertick_match.smx"),
      resolve(root, ".tools", "csgo-server", "csgo", "addons", "sourcemod", "plugins", "aftertick_match.smx")
    );
    await runMigrations(sql);
    const nodeCredentials = await controls.registerNode({
      name: "local-windows-01",
      region: "NA Central"
    });
    credentials["AFTERTICK_NODE_TOKEN"] = nodeCredentials.token;
    await runSeeds(sql, { includeTestPlayers: true });
    await cleanTestQueue(redisUrl);
    await sql`
      update node_commands command
      set status = 'failed', completed_at = now(),
          last_error = 'superseded_by_integration_preflight'
      from game_nodes node
      where command.node_id = node.id and node.name = 'local-windows-01'
        and command.status in ('pending', 'claimed')
    `;
    await sql`
      update server_instances instance
      set state = 'offline', active_lease_id = null, updated_at = now()
      from game_nodes node
      where instance.node_id = node.id and node.name = 'local-windows-01'
        and not exists (
          select 1 from server_leases lease
          where lease.server_instance_id = instance.id and lease.status = 'active'
        )
    `;
    await sql`
      update game_nodes set status = 'offline' where name = 'local-windows-01'
    `;

    api = launch(process.execPath, ["apps/api/dist/server.js"], {
      ...process.env,
      NODE_ENV: "test",
      PORT: "8793",
      AFTERTICK_PUBLIC_URL: origin,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      SESSION_SECRET: "aftertick-full-platform-integration-session-secret",
      MANIFEST_SIGNING_SECRET: credentials["MANIFEST_SIGNING_SECRET"],
      AFTERTICK_E2E_IDENTITY_HEADER_SECRET: identitySecret,
      API_RATE_LIMIT: "5000",
      AUTH_RATE_LIMIT: "5000",
      S3_ENDPOINT: s3.endpoint,
      S3_REGION: s3.region,
      S3_BUCKET: s3.bucket,
      S3_ACCESS_KEY: s3.accessKey,
      S3_SECRET_KEY: s3.secretKey
    });
    await waitFor("API readiness", async () => {
      if (api!.exitCode !== null) throw new Error(api!.aftertickOutput());
      const response = await fetch(`${origin}/ready`);
      return response.ok ? true : null;
    }, 20_000);

    const agentEnvironment = {
      ...process.env,
      ...credentials,
      AFTERTICK_API_URL: origin,
      AFTERTICK_NODE_HEARTBEAT_MS: "500"
    };
    agent = launch(process.execPath, ["apps/node-agent/dist/main.js"], agentEnvironment);
    const [node] = await sql<{ id: string }[]>`
      select id from game_nodes where name = 'local-windows-01'
    `;
    if (!node) throw new Error("Local game node is not registered.");
    await waitFor("node heartbeat", async () => {
      if (agent!.exitCode !== null) throw new Error(agent!.aftertickOutput());
      const [row] = await sql<{ last_heartbeat_at: Date | null }[]>`
        select last_heartbeat_at from game_nodes where id = ${node.id}
      `;
      return row?.last_heartbeat_at ? true : null;
    });
    await controls.enqueueCommand(node.id, "start", { instanceKey: "csgo-01" });
    await waitFor("real warm server", async () => {
      const [instance] = await sql<{ state: string; process_id: number | null }[]>`
        select state, process_id from server_instances
        where node_id = ${node.id} and instance_key = 'csgo-01'
      `;
      if (instance?.process_id) lastServerPid = Number(instance.process_id);
      return instance?.state === "ready" ? true : null;
    }, 60_000);

    const sessions = await Promise.all(TEST_PLAYER_IDS.map(async (playerId): Promise<TestSession> => {
      const response = await fetch(`${origin}/api/auth/csrf`, {
        headers: {
          "X-Aftertick-Test-Secret": identitySecret,
          "X-Aftertick-Test-Player-Id": playerId
        }
      });
      if (!response.ok) throw new Error(`Could not establish test session for ${playerId}.`);
      const cookie = response.headers.get("set-cookie");
      const body = await response.json() as { token: string };
      if (!cookie) throw new Error("Test session did not issue a cookie.");
      return { playerId, cookie, csrf: body.token };
    }));

    const request = async <T>(session: TestSession, path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(`${origin}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrf,
          "X-Aftertick-Test-Secret": identitySecret,
          "X-Aftertick-Test-Player-Id": session.playerId,
          ...init.headers
        }
      });
      const body = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `${path} failed with ${response.status}.`);
      return body;
    };

    await Promise.all(sessions.map((session) => request(session, "/api/queue/join", {
      method: "POST",
      body: JSON.stringify({
        regions: ["NA Central"],
        maps: ["Mirage"]
      })
    })));

    const ready = await waitFor("ten-player ready check", async () => {
      const bootstrap = await request<{
        readyCheck: { matchId: string } | null;
      }>(sessions[0]!, "/api/bootstrap");
      return bootstrap.readyCheck;
    }, 30_000);
    matchId = ready.matchId;

    const acceptResults = await Promise.all(sessions.map((session) => request<Record<string, unknown>>(
      session,
      `/api/matches/${encodeURIComponent(matchId!)}/accept`,
      { method: "POST" }
    )));
    const nativeReadyCompletion = acceptResults.find((result) => "remainingMaps" in result) as {
      matchId: string;
      status: "active" | "allocating";
      remainingMaps: string[];
      selectedMap: string | null;
      bans: Array<{ sequence: number }>;
    } | undefined;
    if (
      !nativeReadyCompletion
      || nativeReadyCompletion.matchId !== matchId
      || nativeReadyCompletion.status !== "allocating"
      || nativeReadyCompletion.selectedMap !== "Mirage"
      || nativeReadyCompletion.remainingMaps.length !== 1
      || nativeReadyCompletion.remainingMaps[0] !== "Mirage"
      || nativeReadyCompletion.bans.length !== 0
    ) {
      throw new Error("The tenth native acceptance did not allocate the shared Panorama map directly.");
    }

    await Promise.all(sessions.map(async (session) => {
      const bootstrap = await waitFor(`assignment recovery for ${session.playerId}`, async () => {
        const current = await request<{
          queue: { phase: string };
          assignment: { address: string; matchId: string } | null;
        }>(session, "/api/bootstrap");
        return current.queue.phase === "assigned" && current.assignment ? current : null;
      }, 20_000);
      if (
        bootstrap.assignment?.matchId !== matchId
        || bootstrap.assignment.address !== "127.0.0.1:27115"
      ) {
        throw new Error(`Player ${session.playerId} did not recover the real assignment.`);
      }
    }));

    await waitFor("signed manifest preparation", async () => {
      const [row] = await sql<{ lease_id: string; status: string }[]>`
        select lease.id as lease_id, command.status
        from server_leases lease
        join node_commands command
          on command.command_type = 'prepare'
          and command.payload->>'leaseId' = lease.id::text
        where lease.match_id = ${matchId}
        order by command.created_at desc
        limit 1
      `;
      if (row?.lease_id) leaseId = row.lease_id;
      return row?.status === "completed" ? true : null;
    }, 20_000);

    const eventPath = resolve(
      root,
      ".tools", "csgo-server", "csgo", "addons", "sourcemod", "logs", "aftertick-events.jsonl"
    );
    await waitFor("real plugin warmup event", async () => {
      const content = await readFile(eventPath, "utf8");
      return content.split(/\r?\n/).some((line) =>
        line.includes(`\"matchId\":\"${matchId}\"`) && line.includes("match.warmup")
      ) ? true : null;
    }, 20_000);
    await waitFor("signed warmup event ingestion", async () => {
      const [event] = await sql<{ count: number }[]>`
        select count(*)::int as count
        from match_events
        where match_id = ${matchId}
          and event_type = 'match.warmup'
          and lease_id = ${leaseId}
          and payload_checksum ~ '^[a-f0-9]{64}$'
      `;
      return event?.count === 1 ? true : null;
    }, 20_000);

    const [heartbeatBeforeRestart] = await sql<{ last_heartbeat_at: Date }[]>`
      select last_heartbeat_at from game_nodes where id = ${node.id}
    `;
    await crash(agent);
    const serverDuringAgentLoss = await sendRcon({
      host: "127.0.0.1",
      port: 27115,
      password: credentials["AFTERTICK_SRCDS_RCON"]!,
      command: "status",
      timeoutMs: 2_000
    });
    if (!serverDuringAgentLoss.trim()) {
      throw new Error("SRCDS did not remain reachable during node-agent loss.");
    }
    agent = launch(process.execPath, ["apps/node-agent/dist/main.js"], agentEnvironment);
    await waitFor("node-agent restart and live-server adoption", async () => {
      if (agent!.exitCode !== null) throw new Error(agent!.aftertickOutput());
      const [row] = await sql<{ last_heartbeat_at: Date; state: string }[]>`
        select node.last_heartbeat_at, instance.state::text
        from game_nodes node
        join server_instances instance on instance.node_id = node.id
        where node.id = ${node.id} and instance.instance_key = 'csgo-01'
      `;
      return row
        && row.last_heartbeat_at > heartbeatBeforeRestart!.last_heartbeat_at
        && row.state === "leased"
        ? true
        : null;
    }, 20_000);

    const [evidence] = await sql<{
      roster_count: number;
      lease_count: number;
      veto_count: number;
      map_pool_size: number;
      signature: string;
    }[]>`
      select
        (select count(*)::int from rosters where match_id = ${matchId}) as roster_count,
        (select count(*)::int from server_leases where match_id = ${matchId} and status = 'active') as lease_count,
        (select count(*)::int from match_map_veto_actions where match_id = ${matchId}) as veto_count,
        (select cardinality(map_pool) from matches where id = ${matchId}) as map_pool_size,
        (select manifest_signature from server_leases where match_id = ${matchId} limit 1) as signature
    `;
    if (
      evidence?.roster_count !== 10
      || evidence.lease_count !== 1
      || evidence.veto_count !== 0
      || evidence.map_pool_size !== 1
      || !evidence.signature
    ) {
      throw new Error("Database evidence for the real match is incomplete.");
    }

    if (!leaseId) throw new Error("Active lease ID was not captured.");
    await sendRcon({
      host: "127.0.0.1",
      port: 27115,
      password: credentials["AFTERTICK_SRCDS_RCON"]!,
      command: "sm_aftertick_begin"
    });
    await waitFor("signed live-match event", async () => {
      const [live] = await sql<{ status: string; count: number }[]>`
        select match.status::text,
               (select count(*)::int from match_events event
                where event.match_id = match.id and event.event_type = 'match.live') as count
        from matches match where match.id = ${matchId}
      `;
      return live?.status === "live" && live.count === 1 ? true : null;
    }, 20_000);

    await sendRcon({
      host: "127.0.0.1",
      port: 27115,
      password: credentials["AFTERTICK_SRCDS_RCON"]!,
      command: "sm_aftertick_surrender alpha"
    });
    const terminal = await waitFor("signed terminal result and exactly-once settlement", async () => {
      const [row] = await sql<{
        match_status: string;
        result_status: string;
        lease_status: string;
        release_reason: string | null;
        alpha_rounds: number;
        bravo_rounds: number;
        ledger: number;
        xp_ledger: number;
        xp_total: number;
        stats: number;
        surrendered_events: number;
        aborted_events: number;
      }[]>`
        select match.status::text as match_status,
               result.status::text as result_status,
               lease.status::text as lease_status,
               lease.release_reason,
               result.alpha_rounds,
               result.bravo_rounds,
               (select count(*)::int from rating_changes where match_id = ${matchId}) as ledger,
               (select count(*)::int from player_xp_ledger where match_id = ${matchId}) as xp_ledger,
               (select coalesce(sum(delta), 0)::int from player_xp_ledger where match_id = ${matchId}) as xp_total,
               (select count(*)::int from match_stats where match_id = ${matchId}) as stats,
               (select count(*)::int from match_events
                where match_id = ${matchId} and event_type = 'match.surrendered') as surrendered_events,
               (select count(*)::int from match_events
                where match_id = ${matchId} and event_type = 'match.aborted') as aborted_events
        from matches match
        join match_results result on result.match_id = match.id
        join server_leases lease on lease.id = result.lease_id
        where match.id = ${matchId}
      `;
      return row?.match_status === "completed"
        && row.result_status === "settled"
        && row.lease_status === "released"
        && row.release_reason === "match_completed"
        && row.alpha_rounds < row.bravo_rounds
        && row.ledger === 10
        && row.xp_ledger === (row.alpha_rounds > 0 ? 5 : 0) + (row.bravo_rounds > 0 ? 5 : 0)
        && row.xp_total === (row.alpha_rounds + row.bravo_rounds) * 5 * 30
        && row.stats === 10
        && row.surrendered_events === 1
        && row.aborted_events === 0
        ? row
        : null;
    }, 20_000);

    await waitFor("automatic terminal-match shutdown", async () => {
      const [instance] = await sql<{ state: string }[]>`
        select state from server_instances where node_id = ${node.id} and instance_key = 'csgo-01'
      `;
      return instance?.state === "offline" ? true : null;
    }, 20_000);
    await waitFor("completed terminal drain acknowledgement", async () => {
      const [command] = await sql<{ status: string; terminal_match: boolean }[]>`
        select status::text,
               coalesce((result->>'terminalMatch')::boolean, false) as terminal_match
        from node_commands
        where command_type = 'drain' and payload->>'leaseId' = ${leaseId}
        order by created_at desc limit 1
      `;
      return command?.status === "completed" && command.terminal_match ? true : null;
    }, 20_000);
    const [demo] = await sql<{
      object_key: string;
      sha256: string;
      size_bytes: number;
      status: string;
    }[]>`
      select object_key, sha256, size_bytes::int, status
      from match_demo_artifacts where match_id = ${matchId}
    `;
    if (!demo || demo.status !== "uploaded" || demo.size_bytes <= 0) {
      throw new Error("The canonical GOTV artifact was not persisted.");
    }
    const localDemo = await readFile(resolve(root, ".tools", "csgo-server", "csgo", `aftertick-${matchId}.dem`));
    if (
      localDemo.length !== demo.size_bytes
      || createHash("sha256").update(localDemo).digest("hex") !== demo.sha256
    ) {
      throw new Error("The local GOTV artifact does not match its database checksum.");
    }
    const s3Client = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey }
    });
    try {
      const remote = await s3Client.send(new HeadObjectCommand({
        Bucket: s3.bucket,
        Key: demo.object_key
      }));
      if (Number(remote.ContentLength) !== demo.size_bytes || remote.Metadata?.["sha256"] !== demo.sha256) {
        throw new Error("The MinIO GOTV object metadata does not match PostgreSQL.");
      }
    } finally {
      s3Client.destroy();
    }
    const analysis = await analyzeDemoArtifact(sql, {
      ...s3,
      analyzerPath: resolve(
        root,
        ".artifacts",
        "bin",
        process.platform === "win32" ? "aftertick-demo-analyzer.exe" : "aftertick-demo-analyzer"
      )
    }, matchId);
    const [analyzedDemo] = await sql<{
      status: string;
      analyzer_version: string;
      analysis_sha256: string;
      source_sha256: string;
      map_name: string;
    }[]>`
      select status, analyzer_version, analysis_sha256,
             analysis->'source'->>'sha256' as source_sha256,
             analysis->'header'->>'mapName' as map_name
      from match_demo_artifacts where match_id = ${matchId}
    `;
    if (
      analyzedDemo?.status !== "analyzed"
      || analyzedDemo.analyzer_version !== analysis.analyzerVersion
      || analyzedDemo.analysis_sha256 !== analysis.analysisSha256
      || analyzedDemo.source_sha256 !== demo.sha256
      || analyzedDemo.map_name !== "de_mirage"
    ) {
      throw new Error("The independent GOTV analysis record is incomplete.");
    }

    noShowMatchId = randomUUID();
    await sql`
      insert into matches (
        id, season_id, map, map_pool, region, ruleset_version, status
      )
      select ${noShowMatchId}, season_id, map, map_pool, region, ruleset_version,
             'pending'::match_status
      from matches where id = ${matchId}
    `;
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match)
      select ${noShowMatchId}, player_id, team, slot, rating_at_match
      from rosters where match_id = ${matchId}
    `;
    const noShowRoster = await sql<{
      player_id: string;
      steam_id: string;
      team: "alpha" | "bravo";
    }[]>`
      select roster.player_id, player.steam_id, roster.team::text
      from rosters roster
      join players player on player.id = roster.player_id
      where roster.match_id = ${noShowMatchId}
      order by roster.team, roster.slot
    `;
    const noShowLease = await controls.leaseReadyServer({
      matchId: noShowMatchId,
      region: "NA Central",
      ttlSeconds: 600,
      payload: {
        roster: noShowRoster.map((member) => ({
          playerId: member.player_id,
          steamId: member.steam_id,
          team: member.team
        })),
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${noShowMatchId}/gotv.dem`,
        eventIngestSecret: "aftertick-no-show-integration-ingest-secret",
        serverPassword: "aftertickNoShowIntegration123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    noShowLeaseId = noShowLease.id;
    await waitFor("real no-show signed manifest preparation", async () => {
      const [command] = await sql<{ status: string }[]>`
        select status::text
        from node_commands
        where command_type = 'prepare' and payload->>'leaseId' = ${noShowLeaseId}
        order by created_at desc limit 1
      `;
      return command?.status === "completed" ? true : null;
    }, 20_000);
    // AutoExecConfig runs during changelevel, so shorten the isolated test
    // window only after the real plugin has loaded its production defaults.
    await sendRcon({
      host: "127.0.0.1",
      port: 27115,
      password: credentials["AFTERTICK_SRCDS_RCON"]!,
      command: "aftertick_no_show_seconds 30"
    });
    await waitFor("real SourceMod no-show cancellation and penalties", async () => {
      if (agent!.exitCode !== null) throw new Error(agent!.aftertickOutput());
      const [row] = await sql<{
        match_status: string;
        cancelled_reason: string | null;
        lease_status: string;
        release_reason: string | null;
        violations: number;
        sanctions: number;
        audits: number;
        rating_changes: number;
        no_show_events: number;
        aborted_events: number;
        instance_state: string;
        drain_status: string | null;
      }[]>`
        select game.status::text as match_status, game.cancelled_reason,
               lease.status::text as lease_status, lease.release_reason,
               (select count(*)::int from match_participation_violations
                 where match_id = ${noShowMatchId} and violation_type = 'no_show') as violations,
               (select count(*)::int from sanctions where match_id = ${noShowMatchId}) as sanctions,
               (select count(*)::int from audit_log
                 where action = 'sanction.automatic_participation'
                   and detail->>'matchId' = ${noShowMatchId}) as audits,
               (select count(*)::int from rating_changes where match_id = ${noShowMatchId}) as rating_changes,
               (select count(*)::int from match_events
                 where match_id = ${noShowMatchId} and event_type = 'roster.no_show') as no_show_events,
               (select count(*)::int from match_events
                 where match_id = ${noShowMatchId} and event_type = 'match.aborted') as aborted_events,
               instance.state::text as instance_state,
               (select command.status::text from node_commands command
                 where command.command_type = 'drain' and command.payload->>'leaseId' = ${noShowLeaseId}
                 order by command.created_at desc limit 1) as drain_status
        from matches game
        join server_leases lease on lease.match_id = game.id
        join server_instances instance on instance.id = lease.server_instance_id
        where game.id = ${noShowMatchId}
      `;
      return row?.match_status === "cancelled"
        && row.cancelled_reason === "no_show"
        && row.lease_status === "released"
        && row.release_reason === "server_abort"
        && row.violations === 10
        && row.sanctions === 10
        && row.audits === 10
        && row.rating_changes === 0
        && row.no_show_events === 10
        && row.aborted_events === 1
        && row.instance_state === "offline"
        && row.drain_status === "completed"
        ? row
        : null;
    }, 60_000);

    crashMatchId = randomUUID();
    await sql`
      insert into matches (
        id, season_id, map, map_pool, region, ruleset_version, status
      )
      select ${crashMatchId}, season_id, map, map_pool, region, ruleset_version,
             'pending'::match_status
      from matches where id = ${matchId}
    `;
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match)
      select ${crashMatchId}, player_id, team, slot, rating_at_match
      from rosters where match_id = ${matchId}
    `;
    const crashRoster = await sql<{
      player_id: string;
      steam_id: string;
      team: "alpha" | "bravo";
    }[]>`
      select roster.player_id, player.steam_id, roster.team::text
      from rosters roster
      join players player on player.id = roster.player_id
      where roster.match_id = ${crashMatchId}
      order by roster.team, roster.slot
    `;
    const crashLease = await controls.leaseReadyServer({
      matchId: crashMatchId,
      region: "NA Central",
      ttlSeconds: 600,
      payload: {
        roster: crashRoster.map((member) => ({
          playerId: member.player_id,
          steamId: member.steam_id,
          team: member.team
        })),
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${crashMatchId}/gotv.dem`,
        eventIngestSecret: "aftertick-srcds-crash-integration-ingest-secret",
        serverPassword: "aftertickSrcdsCrashIntegration123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    crashLeaseId = crashLease.id;
    await waitFor("second real signed manifest preparation", async () => {
      const [command] = await sql<{ status: string }[]>`
        select status::text
        from node_commands
        where command_type = 'prepare' and payload->>'leaseId' = ${crashLeaseId}
        order by created_at desc limit 1
      `;
      return command?.status === "completed" ? true : null;
    }, 20_000);
    await sendRcon({
      host: "127.0.0.1",
      port: 27115,
      password: credentials["AFTERTICK_SRCDS_RCON"]!,
      command: "sm_aftertick_begin"
    });
    await waitFor("second real match live state", async () => {
      const [live] = await sql<{ status: string }[]>`
        select status::text from matches where id = ${crashMatchId}
      `;
      return live?.status === "live" ? true : null;
    }, 20_000);
    lastServerPid = await waitFor("current real SRCDS PID for the crash drill", async () => {
      const [instance] = await sql<{ process_id: number | null }[]>`
        select process_id from server_instances
        where node_id = ${node.id} and instance_key = 'csgo-01'
      `;
      if (!instance?.process_id) return null;
      const pid = Number(instance.process_id);
      try {
        process.kill(pid, 0);
        return pid;
      } catch {
        return null;
      }
    }, 20_000);
    const crashDetectedFrom = Date.now();
    process.kill(lastServerPid, "SIGKILL");
    lastServerPid = null;
    const crashRecovery = await waitFor("thresholded real SRCDS crash recovery", async () => {
      if (agent!.exitCode !== null) throw new Error(agent!.aftertickOutput());
      const [row] = await sql<{
        match_status: string;
        lease_status: string;
        release_reason: string | null;
        lease_was_unexpired: boolean;
        instance_state: string;
        incident_reason: string;
        incidents: number;
        opened_audits: number;
        completed_match_status: string;
      }[]>`
        select failed.status::text as match_status,
               lease.status::text as lease_status,
               lease.release_reason,
               lease.expires_at > incident.detected_at as lease_was_unexpired,
               instance.state::text as instance_state,
               incident.reason as incident_reason,
               (select count(*)::int from match_recovery_incidents where match_id = ${crashMatchId}) as incidents,
               (
                 select count(*)::int from audit_log
                 where action = 'match.recovery.opened'
                   and detail->>'matchId' = ${crashMatchId}
               ) as opened_audits,
               completed.status::text as completed_match_status
        from matches failed
        join server_leases lease on lease.match_id = failed.id
        join server_instances instance on instance.id = lease.server_instance_id
        join match_recovery_incidents incident on incident.match_id = failed.id
        join matches completed on completed.id = ${matchId}
        where failed.id = ${crashMatchId}
      `;
      return row?.match_status === "disputed"
        && row.lease_status === "expired"
        && row.release_reason === "srcds_unreachable"
        && row.lease_was_unexpired
        && row.instance_state === "quarantined"
        && row.incident_reason === "srcds_unreachable"
        && row.incidents === 1
        && row.opened_audits === 1
        && row.completed_match_status === "completed"
        ? row
        : null;
    }, 30_000);
    srcdsFailureDetectedMs = Date.now() - crashDetectedFrom;
    if (crashRecovery.completed_match_status !== "completed") {
      throw new Error("The SRCDS crash drill altered the already settled canonical match.");
    }

    await Promise.all(sessions.map((session) => request(session, "/api/dev/reset", { method: "POST" })));
    console.log(JSON.stringify({
      matchId,
      players: sessions.length,
      server: "127.0.0.1:27115",
      score: `${terminal.alpha_rounds}-${terminal.bravo_rounds}`,
      demoBytes: demo.size_bytes,
      demoSha256: demo.sha256,
      analyzer: analysis.analyzerVersion,
      analyzerWarnings: analysis.warnings,
      srcdsCrashMatchId: crashMatchId,
      srcdsFailureDetectedMs,
      noShowMatchId,
      verified: [
        "ten independent HTTP sessions",
        "PostgreSQL player profiles and roster",
        "atomic Redis tickets",
        "deterministic matchmaker",
        "shared Panorama map selection before native ready check",
        "ten individual acceptances with zero server allocation before 10/10",
        "direct allocation without a captain or website veto action",
        "fenced lease",
        "signed manifest",
        "real node-agent prepare",
        "real SourceMod warmup event",
        "lease-signed append-only event ingestion",
        "live node-agent crash/restart with SRCDS continuity",
        "ten accepts",
        "assignment recovery",
        "real SourceMod live transition and surrender",
        "real SourceMod no-show timer with ten idempotent audited cooldowns",
        "signed canonical terminal result",
        "ten persisted player stat lines",
        "exactly-once ten-player rating settlement",
        "exactly-once score-derived profile-XP settlement before terminal drain",
        "checksum-verified GOTV upload to MinIO",
        "independent demoinfocs v3 legacy-CS:GO analysis",
        "automatic terminal drain",
        "real leased SRCDS process crash detection before TTL expiry",
        "idempotent quarantine, dispute, audit, and operator-recovery incident"
      ]
    }, null, 2));
  } catch (error) {
    const diagnostic = [
      error instanceof Error ? error.stack ?? error.message : String(error),
      api ? `API output:\n${api.aftertickOutput()}` : "",
      agent ? `Agent output:\n${agent.aftertickOutput()}` : ""
    ].filter(Boolean).join("\n");
    throw new Error(diagnostic);
  } finally {
    if (leaseId) {
      try { await controls.releaseLease(leaseId, "integration_finalizer"); } catch { /* best effort */ }
    }
    if (crashLeaseId) {
      try { await controls.releaseLease(crashLeaseId, "integration_finalizer"); } catch { /* best effort */ }
    }
    if (noShowLeaseId) {
      try { await controls.releaseLease(noShowLeaseId, "integration_finalizer"); } catch { /* best effort */ }
    }
    await stop(agent);
    // Windows can orphan a replacement SRCDS when the agent is stopped after
    // the crash drill. Stop restarts first, then quit only our preflight-vacant,
    // credential-authenticated loopback fixture. Never kill a stale saved PID.
    let cleanupError: unknown;
    try {
      if (await fixtureServerListening()) {
        await sendRcon({
          host: "127.0.0.1", port: 27115,
          password: credentials["AFTERTICK_SRCDS_RCON"]!, command: "quit"
        }).catch(() => undefined);
      }
      await checkFixtureProcesses(fixtureStartedAt);
      await waitFor("fixture SRCDS shutdown", async () => !(await fixtureServerListening()), 10_000);
      console.log("Platform fixture server shutdown verified.");
    } catch (error) { cleanupError = error; }
    await stop(api);
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end({ timeout: 5 });
    if (cleanupError) throw cleanupError;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
