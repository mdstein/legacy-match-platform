import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, runMigrations, type Sql } from "@aftertick/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  NoServerCapacityError,
  NodeAuthenticationError,
  NodeControlService,
  verifyManifest
} from "../src/node-control-service.js";
import { createApp } from "../src/app.js";
import {
  DemoIngestionService,
  type DemoObjectStore
} from "../src/demo-ingestion-service.js";
import { MatchOrchestrator } from "../src/match-orchestrator.js";
import type { MatchPlan } from "../src/matchmaker.js";
import {
  MatchIngestionService,
  signMatchIngestion
} from "../src/match-ingestion-service.js";
import { OperationsService } from "../src/operations-service.js";
import { GameNodeAgent } from "../../node-agent/src/agent.js";
import { MatchEventPump } from "../../node-agent/src/event-pump.js";
import type { AgentConfig } from "../../node-agent/src/config.js";
import type { AgentMatchManifest } from "../../node-agent/src/manifest.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("server control plane", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const signingSecret = "aftertick-control-plane-integration-signing-secret";
  let admin!: Sql;
  let sql!: Sql;
  let service!: NodeControlService;

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
    await runMigrations(sql);
    service = new NodeControlService(sql, signingSecret);
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  async function createMatch(id: string) {
    await sql`
      insert into matches (id, map, region, status)
      values (${id}, 'Mirage', 'NA Central', 'pending')
    `;
  }

  const heartbeat = {
    agentVersion: "integration-agent-1",
    capacityTotal: 1,
    metadata: { host: "integration" },
    instances: [{
      instanceKey: "csgo-01",
      state: "ready" as const,
      address: "127.0.0.1:27115",
      gamePort: 27115,
      gotvPort: 27120,
      processId: 4242,
      serverBuildId: "12426148",
      pluginVersion: "0.1.0"
    }]
  };

  it("authenticates heartbeats and delivers commands exactly once per claim", async () => {
    const credentials = await service.registerNode({ name: "integration-node", region: "NA Central" });
    await expect(service.authenticate("wrong-token")).rejects.toBeInstanceOf(NodeAuthenticationError);

    const app = createApp({ nodeControl: service });
    expect((await request(app).post("/api/node/v1/heartbeat").send(heartbeat)).status).toBe(401);
    const initial = await request(app)
      .post("/api/node/v1/heartbeat")
      .set("Authorization", `Bearer ${credentials.token}`)
      .send(heartbeat);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      nodeId: credentials.nodeId,
      status: "active",
      commands: [],
      activeLeaseIds: []
    });

    const commandId = await service.enqueueCommand(credentials.nodeId, "start", { instanceKey: "csgo-02" });
    const delivery = await service.heartbeat(credentials.token, heartbeat);
    expect(delivery.commands).toHaveLength(1);
    expect(delivery.commands[0]).toMatchObject({ id: commandId, commandType: "start" });
    expect((await service.heartbeat(credentials.token, heartbeat)).commands).toEqual([]);
    expect(await service.acknowledgeCommand(
      credentials.token,
      commandId,
      randomUUID(),
      true
    )).toBe(false);
    expect(await service.acknowledgeCommand(
      credentials.token,
      commandId,
      delivery.commands[0]!.claimToken,
      true,
      { started: true }
    )).toBe(true);
  });

  it("delivers recovery work while leaving terminal drain unclaimed on request", async () => {
    const credentials = await service.registerNode({
      name: "deferred-drain-node",
      region: "NA Central"
    });
    await service.heartbeat(credentials.token, heartbeat);
    const drainId = await service.enqueueCommand(credentials.nodeId, "drain", {
      instanceKey: "csgo-01",
      reason: "match_completed"
    });
    const startId = await service.enqueueCommand(credentials.nodeId, "start", {
      instanceKey: "csgo-01"
    });

    const deferred = await service.heartbeat(credentials.token, {
      ...heartbeat,
      deferTerminalDrain: true
    });
    expect(deferred.commands.map((command) => command.id)).toEqual([startId]);
    expect(await service.acknowledgeCommand(
      credentials.token,
      startId,
      deferred.commands[0]!.claimToken,
      true
    )).toBe(true);

    const resumed = await service.heartbeat(credentials.token, heartbeat);
    expect(resumed.commands).toHaveLength(1);
    expect(resumed.commands[0]).toMatchObject({ id: drainId, commandType: "drain" });
  });

  it("retries failed node commands with a new claim and preserves one command identity", async () => {
    const credentials = await service.registerNode({ name: "retry-node", region: "NA Central" });
    await service.heartbeat(credentials.token, heartbeat);
    const commandId = await service.enqueueCommand(
      credentials.nodeId,
      "start",
      { instanceKey: "retry-02" }
    );

    const first = await service.heartbeat(credentials.token, heartbeat);
    const firstClaim = first.commands.find((command) => command.id === commandId)!;
    expect(firstClaim).toBeDefined();
    expect(await service.acknowledgeCommand(
      credentials.token,
      commandId,
      firstClaim.claimToken,
      false,
      { error: "transient start failure" }
    )).toBe(true);

    expect((await service.heartbeat(credentials.token, heartbeat)).commands).toEqual([]);
    await sql`update node_commands set next_attempt_at = now() where id = ${commandId}`;

    const second = await service.heartbeat(credentials.token, heartbeat);
    const secondClaim = second.commands.find((command) => command.id === commandId)!;
    expect(secondClaim).toBeDefined();
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(await service.acknowledgeCommand(
      credentials.token,
      commandId,
      secondClaim.claimToken,
      true,
      { started: true }
    )).toBe(true);

    const [command] = await sql<{
      status: string;
      attempt_count: number;
      last_error: string | null;
    }[]>`
      select status::text, attempt_count, last_error
      from node_commands where id = ${commandId}
    `;
    expect(command).toEqual({ status: "completed", attempt_count: 2, last_error: null });
  });

  it("uses a signed idempotent manifest and a monotonic fenced lease", async () => {
    const [node] = await sql<{ id: string }[]>`select id from game_nodes where name = 'integration-node'`;
    const [tokenHash] = await sql<{ token_sha256: string }[]>`
      select token_sha256 from game_nodes where id = ${node!.id}
    `;
    expect(tokenHash?.token_sha256).toMatch(/^[a-f0-9]{64}$/);

    // A fresh token is not recoverable from its stored hash; rotate a dedicated node for this flow.
    const credentials = await service.registerNode({ name: "lease-node", region: "NA East" });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{ ...heartbeat.instances[0]!, instanceKey: "lease-01", gamePort: 27215,
        gotvPort: 27220, address: "127.0.0.1:27215" }]
    });
    const matchId = randomUUID();
    await createMatch(matchId);
    const payload = {
      roster: [],
      map: "Mirage",
      rulesetVersion: "1.0",
      pluginVersion: "0.1.0",
      serverConfigVersion: "1.0",
      demoObjectKey: `matches/${matchId}/gotv.dem`,
      serverPassword: "aftertickLeasePassword123",
      integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" } as const
    };
    const lease = await service.leaseReadyServer({
      matchId,
      region: "NA East",
      ttlSeconds: 60,
      payload
    });
    const repeated = await service.leaseReadyServer({
      matchId,
      region: "NA East",
      ttlSeconds: 60,
      payload
    });

    expect(repeated.id).toBe(lease.id);
    expect(repeated.fencingToken).toBe(lease.fencingToken);
    expect(lease.manifest.integrityPolicy).toEqual({
      protocolVersion: 1,
      provider: "none",
      enforcement: "disabled"
    });
    expect(verifyManifest(lease.manifest, lease.signature, signingSecret)).toBe(true);
    expect(verifyManifest({ ...lease.manifest, map: "Nuke" }, lease.signature, signingSecret)).toBe(false);
    expect(verifyManifest({
      ...lease.manifest,
      integrityPolicy: { ...lease.manifest.integrityPolicy, enforcement: "required" as never }
    }, lease.signature, signingSecret)).toBe(false);

    const prepare = await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{ ...heartbeat.instances[0]!, instanceKey: "lease-01", gamePort: 27215,
        gotvPort: 27220, address: "127.0.0.1:27215" }]
    });
    expect(prepare.commands.map((command) => command.commandType)).toContain("prepare");
    const prepareCommand = prepare.commands.find((command) => command.commandType === "prepare")!;
    expect(await service.acknowledgeCommand(
      credentials.token,
      prepareCommand.id,
      prepareCommand.claimToken,
      true
    )).toBe(true);

    expect(await service.releaseLease(lease.id, "integration_complete")).toBe(true);
    const drain = await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{ ...heartbeat.instances[0]!, instanceKey: "lease-01", gamePort: 27215,
        gotvPort: 27220, address: "127.0.0.1:27215" }]
    });
    const drainCommand = drain.commands.find((command) => command.commandType === "drain")!;
    expect(await service.acknowledgeCommand(
      credentials.token,
      drainCommand.id,
      drainCommand.claimToken,
      true
    )).toBe(true);
    const [instance] = await sql<{ state: string }[]>`
      select state from server_instances where node_id = ${credentials.nodeId}
    `;
    expect(instance?.state).toBe("ready");
  });

  it("signs an append-only human roster update for a live drop-in Deathmatch", async () => {
    const credentials = await service.registerNode({ name: "dm-sync-node", region: "DM Sync Test" });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...heartbeat.instances[0]!,
        instanceKey: "dm-sync-01",
        gamePort: 27515,
        gotvPort: 27520,
        address: "127.0.0.1:27515"
      }]
    });
    const matchId = randomUUID();
    const firstPlayer = randomUUID();
    const secondPlayer = randomUUID();
    await sql`
      insert into players (id, steam_id, display_name, region)
      values
        (${firstPlayer}, '76561198000000901', 'DM One', 'DM Sync Test'),
        (${secondPlayer}, '76561198000000902', 'DM Two', 'DM Sync Test')
    `;
    await sql`
      insert into matches (
        id, map, map_pool, region, status, ruleset_version, mode, frag_limit, time_limit_seconds
      ) values (
        ${matchId}, 'Mirage', ${["Mirage"]}, 'DM Sync Test', 'pending', 'dm-1.0',
        'deathmatch', 40, 600
      )
    `;
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match)
      values (${matchId}, ${firstPlayer}, 'ffa', 1, 1000)
    `;
    const lease = await service.leaseReadyServer({
      matchId,
      region: "DM Sync Test",
      ttlSeconds: 600,
      payload: {
        mode: "deathmatch",
        roster: [{ playerId: firstPlayer, steamId: "76561198000000901", team: "ffa" }],
        map: "Mirage",
        rulesetVersion: "dm-1.0",
        fragLimit: 40,
        timeLimitSeconds: 600,
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret: "aftertick-dm-sync-ingest-secret-123456",
        serverPassword: "aftertickDmSyncPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    expect(lease.commandId).toBeDefined();
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match)
      values (${matchId}, ${secondPlayer}, 'ffa', 2, 1000)
    `;

    const synchronized = await service.synchronizeDeathmatchRoster(matchId);
    expect(synchronized.commandId).toBeDefined();
    expect(synchronized.lease.manifest.roster).toHaveLength(2);
    expect(verifyManifest(
      synchronized.lease.manifest,
      synchronized.lease.signature,
      signingSecret
    )).toBe(true);
    const delivery = await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...heartbeat.instances[0]!,
        instanceKey: "dm-sync-01",
        gamePort: 27515,
        gotvPort: 27520,
        address: "127.0.0.1:27515"
      }]
    });
    expect(delivery.commands.map((command) => command.commandType)).toEqual([
      "prepare",
      "sync-roster"
    ]);
    const ingestion = new MatchIngestionService(sql, service);
    const admitted = {
      leaseId: synchronized.lease.id,
      fencingToken: synchronized.lease.fencingToken,
      events: [{
        eventId: randomUUID(),
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: "roster.admitted",
        payload: { steamId: "76561198000000901" }
      }]
    };
    await ingestion.ingestEvents(
      credentials.token,
      matchId,
      admitted,
      signMatchIngestion(admitted, "aftertick-dm-sync-ingest-secret-123456")
    );
    const [presence] = await sql<{ connected: boolean }[]>`
      select connected from match_player_presence
      where match_id = ${matchId} and player_id = ${firstPlayer}
    `;
    expect(presence?.connected).toBe(true);
  });

  it("refreshes live owned inventory from the database with capability and lease isolation", async () => {
    const region = `Inventory sync ${randomUUID()}`;
    const credentials = await service.registerNode({ name: region, region });
    await service.heartbeat(credentials.token, heartbeat);
    const playerId = randomUUID();
    const matchId = randomUUID();
    const steamId = `76561198${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    await sql`insert into players (id, steam_id, display_name) values (${playerId}, ${steamId}, 'Inventory Sync')`;
    await sql`
      insert into matches (id, map, region, mode, status)
      values (${matchId}, 'Dust II', ${region}, 'deathmatch', 'live')
    `;
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match)
      values (${matchId}, ${playerId}, 'ffa', 1, 1000)
    `;
    const lease = await service.leaseReadyServer({
      matchId, region, ttlSeconds: 600,
      payload: {
        mode: 'deathmatch', roster: [{ playerId, steamId, team: 'ffa' }], cosmetics: [],
        map: 'Dust II', rulesetVersion: 'dm-1.0', pluginVersion: '0.1.6',
        serverConfigVersion: '1.0', demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret: 'inventory-sync-test-ingestion-secret', serverPassword: 'testPassword123',
        integrityPolicy: { protocolVersion: 1, provider: 'none', enforcement: 'disabled' }
      }
    });
    const [item] = await sql<{ asset_id: string }[]>`
      insert into player_b2g_inventory_items (
        player_id, asset_id, item_kind, definition_index, weapon_key, display_name,
        inventory_position, paint_index, paint_wear, paint_seed,
        quality, rarity, origin, kill_eater_score_type, kill_eater_value, loadout_slot
      ) values (
        ${playerId}, nextval('b2g_inventory_asset_id_seq')::text, 'cosmetic', 7, 'ak47', 'Test Reward',
        1073741829, 180, 0.1, 10, 9, 5, 8, 0, 0, 15
      ) returning asset_id
    `;
    const report = {
      ...heartbeat,
      instances: [{ ...heartbeat.instances[0]!, metadata: { srcdsHealth: {
        protocolVersion: 1, activeMatchId: matchId, activeLeaseId: lease.id
      } } }]
    };
    const supported = { ...report, metadata: { inventorySyncVersion: 1 } };
    expect((await service.heartbeat(credentials.token, report)).commands
      .filter((command) => command.commandType === 'sync-inventory')).toEqual([]);
    // No duplicate command/revision when two requests race on the same node.
    const deliveries = await Promise.all([
      service.heartbeat(credentials.token, supported), service.heartbeat(credentials.token, supported)
    ]);
    const updates = deliveries.flatMap((delivery) => delivery.commands)
      .filter((command) => command.commandType === 'sync-inventory');
    expect(updates).toHaveLength(1);
    const [stored] = await sql<{ manifest: typeof lease.manifest; manifest_signature: string }[]>`
      select manifest, manifest_signature from server_leases where id = ${lease.id}
    `;
    expect(stored!.manifest.manifestRevision).toBe(2);
    expect(stored!.manifest.roster).toEqual(lease.manifest.roster);
    expect(stored!.manifest.cosmetics).toHaveLength(1);
    expect(stored!.manifest.cosmetics![0]!.items).toHaveLength(1);
    expect(stored!.manifest.cosmetics![0]!.items[0]).toMatchObject({ assetId: item!.asset_id, killEaterValue: 0 });
    expect(verifyManifest(stored!.manifest, stored!.manifest_signature, signingSecret)).toBe(true);
    expect(updates[0]!.payload).toEqual({ manifest: stored!.manifest, signature: stored!.manifest_signature });
    expect((await service.heartbeat(credentials.token, supported)).commands).toEqual([]);

    // Execute the real DB-issued envelope through the real node verifier and
    // atomic policy writer. No SRCDS/game process or UI is launched by this test.
    const serverRoot = await mkdtemp(join(tmpdir(), 'b2g-db-node-inventory-'));
    try {
      const config: AgentConfig = {
        apiUrl: 'http://127.0.0.1:8787', nodeToken: credentials.token,
        manifestSigningSecret: signingSecret, serverRoot, launcherScript: 'unused.ps1',
        instanceKey: 'csgo-01', serverAddress: lease.manifest.serverAddress, host: '127.0.0.1',
        gamePort: 27115, gotvPort: 27120, latencyProbePort: 0, lanMode: true, gsltToken: undefined,
        rconPassword: 'test-rcon', idlePassword: 'test-idle', heartbeatMs: 1000,
        serverBuildId: '1575', pluginVersion: '0.1.6'
      };
      const pump = new MatchEventPump(config);
      await pump.begin(lease.manifest as AgentMatchManifest);
      const rcon = vi.fn(async () => 'unused');
      const agent = new GameNodeAgent(config, {
        fetch: vi.fn() as unknown as typeof fetch, rcon,
        spawnServer: () => { throw new Error('Inventory refresh must not start SRCDS'); }, eventPump: pump
      });
      await agent.execute(updates[0]!);
      const policy = await readFile(join(serverRoot, 'csgo_gc', 'b2g_owned_manifest.txt'), 'utf8');
      expect(policy).toContain(`"${item!.asset_id}"`);
      expect(policy).toContain('"manifest_revision" "2"');
      expect((await pump.manifest())?.cosmetics).toEqual(stored!.manifest.cosmetics);
      expect(rcon).not.toHaveBeenCalled();
    } finally { await rm(serverRoot, { recursive: true, force: true }); }

    await sql`update player_b2g_inventory_items set kill_eater_value = 1 where asset_id = ${item!.asset_id}`;
    const next = (await service.heartbeat(credentials.token, supported)).commands
      .find((command) => command.commandType === 'sync-inventory');
    expect(next!.payload['manifest']).toMatchObject({ manifestRevision: 3, cosmetics: [{
      playerId, steamId, items: [{ assetId: item!.asset_id, killEaterValue: 1 }]
    }] });
    await sql`update player_b2g_inventory_items set state = 'consumed', consumed_at = now() where asset_id = ${item!.asset_id}`;
    const consumed = (await service.heartbeat(credentials.token, supported)).commands
      .find((command) => command.commandType === 'sync-inventory');
    expect(consumed!.payload['manifest']).toMatchObject({ manifestRevision: 4, cosmetics: [] });

    const other = await service.registerNode({ name: `other-${region}`, region: `other-${region}` });
    expect((await service.heartbeat(other.token, supported)).activeLeaseIds).toEqual([]);
    expect((await service.heartbeat(other.token, supported)).commands).toEqual([]);
    await sql`update matches set status = 'completed' where id = ${matchId}`;
    const terminal = await service.heartbeat(credentials.token, supported);
    expect(terminal.activeLeaseIds).toEqual([]);
    expect(terminal.commands).toEqual([]);
  });

  it("connects the first Deathmatch human immediately and appends the next to the same session", async () => {
    const credentials = await service.registerNode({ name: "dm-drop-in-node", region: "DM Drop-in Test" });
    const instance = {
      ...heartbeat.instances[0]!,
      instanceKey: "dm-drop-in-01",
      gamePort: 27915,
      gotvPort: 27920,
      address: "127.0.0.1:27915"
    };
    await service.heartbeat(credentials.token, { ...heartbeat, instances: [instance] });
    const firstPlayer = randomUUID();
    const secondPlayer = randomUUID();
    await sql`
      insert into players (id, steam_id, display_name, region)
      values
        (${firstPlayer}, '76561198000000911', 'Drop-in One', 'DM Drop-in Test'),
        (${secondPlayer}, '76561198000000912', 'Drop-in Two', 'DM Drop-in Test')
    `;
    const [readyFixture] = await sql<{ node_status: string; instance_state: string; region: string }[]>`
      select node.status::text as node_status, instance.state::text as instance_state, node.region
      from server_instances instance
      join game_nodes node on node.id = instance.node_id
      where node.id = ${credentials.nodeId} and instance.instance_key = ${instance.instanceKey}
    `;
    expect(readyFixture).toEqual({
      node_status: "active",
      instance_state: "ready",
      region: "DM Drop-in Test"
    });
    const orchestrator = new MatchOrchestrator(sql, service);

    const acknowledge = async (commandType: "prepare" | "sync-roster") => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const delivery = await service.heartbeat(credentials.token, {
          ...heartbeat,
          instances: [instance]
        });
        for (const command of delivery.commands) {
          await service.acknowledgeCommand(
            credentials.token,
            command.id,
            command.claimToken,
            true,
            { acceptedByFixture: true }
          );
          if (command.commandType === commandType) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${commandType}.`);
    };

    const firstJoin = orchestrator.joinDeathmatch({
      playerIds: [firstPlayer],
      regions: ["DM Drop-in Test"]
    });
    await acknowledge("prepare");
    const firstAssignment = await firstJoin;
    expect(firstAssignment).toMatchObject({
      mode: "deathmatch",
      address: "127.0.0.1:27915",
      humanPlayers: 1,
      botPlayers: 13,
      capacity: 14
    });
    await sql`
      update matches set status = 'live', started_at = now()
      where id = ${firstAssignment.matchId}
    `;

    const secondJoin = orchestrator.joinDeathmatch({
      playerIds: [secondPlayer],
      regions: ["DM Drop-in Test"]
    });
    await acknowledge("sync-roster");
    const secondAssignment = await secondJoin;
    expect(secondAssignment).toMatchObject({
      matchId: firstAssignment.matchId,
      humanPlayers: 2,
      botPlayers: 12,
      capacity: 14
    });
    const [persisted] = await sql<{ matches: number; humans: number }[]>`
      select
        (select count(*)::int from matches
          where mode = 'deathmatch' and region = 'DM Drop-in Test') as matches,
        (select count(*)::int from rosters
          where match_id = ${firstAssignment.matchId}) as humans
    `;
    expect(persisted).toEqual({ matches: 1, humans: 2 });

    const [lease] = await sql<{ id: string }[]>`
      select id::text from server_leases
      where match_id = ${firstAssignment.matchId} and status = 'active'
    `;
    expect(lease).toBeDefined();
    const authority = await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...instance,
        metadata: {
          srcdsHealth: {
            protocolVersion: 1,
            rconReachable: true,
            consecutiveRconFailures: 0,
            activeLeaseId: lease!.id,
            activeMatchId: firstAssignment.matchId,
            observedAt: new Date().toISOString(),
            lastRconSuccessAt: new Date().toISOString(),
            lastRconFailureAt: null
          }
        }
      }]
    });
    expect(authority.activeLeaseIds).toEqual([lease!.id]);
  }, 15_000);

  it("cold-starts an offline game server when a fresh match is queued", async () => {
    const region = "DM Cold Start Test";
    const credentials = await service.registerNode({ name: "dm-cold-start-node", region });
    const offlineInstance = {
      ...heartbeat.instances[0]!,
      instanceKey: "dm-cold-start-01",
      state: "offline" as const,
      gamePort: 28015,
      gotvPort: 28020,
      address: "127.0.0.1:28015"
    };
    await service.heartbeat(credentials.token, { ...heartbeat, instances: [offlineInstance] });
    const matchId = randomUUID();
    await createMatch(matchId);
    await sql`update matches set region = ${region} where id = ${matchId}`;

    const allocation = service.leaseReadyServer({
      matchId,
      region,
      ttlSeconds: 60,
      payload: {
        roster: [],
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        serverPassword: "aftertickColdStartPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    const deadline = Date.now() + 10_000;
    let started = false;
    while (Date.now() < deadline && !started) {
      const delivery = await service.heartbeat(credentials.token, {
        ...heartbeat,
        instances: [offlineInstance]
      });
      const start = delivery.commands.find((command) => command.commandType === "start");
      if (start) {
        expect(start.payload).toMatchObject({ reason: "match_queued" });
        await service.acknowledgeCommand(
          credentials.token,
          start.id,
          start.claimToken,
          true,
          { state: "starting" }
        );
        await service.heartbeat(credentials.token, {
          ...heartbeat,
          instances: [{ ...offlineInstance, state: "ready" as const, processId: 5252 }]
        });
        started = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(started).toBe(true);
    const lease = await allocation;
    expect(lease.manifest.serverAddress).toBe("127.0.0.1:28015");
    const prepared = await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{ ...offlineInstance, state: "ready" as const, processId: 5252 }]
    });
    expect(prepared.commands.map((command) => command.commandType)).toContain("prepare");
  });

  it.each(["offline", "ready"] as const)("waits for terminal DM drain before allocating its next match (%s)", async (drainedState) => {
    const region = `DM Drain Handoff ${drainedState}`;
    const credentials = await service.registerNode({ name: `dm-drain-${drainedState}`, region });
    const instance = { ...heartbeat.instances[0]!, instanceKey: "drain-handoff", gamePort: 28115,
      gotvPort: 28120, address: "127.0.0.1:28115" };
    const sendHeartbeat = (state: "ready" | "offline" | "draining") => service.heartbeat(credentials.token, {
      ...heartbeat, instances: [{ ...instance, state }]
    });
    await sendHeartbeat("ready");
    const oldMatchId = randomUUID();
    const newMatchId = randomUUID();
    await Promise.all([createMatch(oldMatchId), createMatch(newMatchId)]);
    const leaseInput = (matchId: string) => ({
      matchId, region, ttlSeconds: 60,
      payload: {
        roster: [], map: "Dust II", rulesetVersion: "1.0", pluginVersion: "0.1.0",
        serverConfigVersion: "1.0", demoObjectKey: `matches/${matchId}/gotv.dem`,
        serverPassword: "aftertickDrainFixturePassword123",
        integrityPolicy: { protocolVersion: 1 as const, provider: "none" as const, enforcement: "disabled" as const }
      }
    });
    const oldLease = await service.leaseReadyServer(leaseInput(oldMatchId));
    for (const command of (await sendHeartbeat("ready")).commands) {
      await service.acknowledgeCommand(credentials.token, command.id, command.claimToken, true);
    }
    await service.releaseLease(oldLease.id, "match_completed");
    const drain = (await sendHeartbeat("draining")).commands.find((command) => command.commandType === "drain")!;
    expect(drain).toBeDefined();

    const allocations = [service.leaseReadyServer(leaseInput(newMatchId)), service.leaseReadyServer(leaseInput(newMatchId))];
    // Capture errors immediately so this regression also fails cleanly against
    // the former allocator, which rejected a normal drain after just 250 ms.
    const results = Promise.allSettled(allocations);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect((await sendHeartbeat("draining")).commands).toEqual([]);
    const [beforeDrain] = await sql<{ starts: number; active: number }[]>`
      select (select count(*)::int from node_commands where node_id = ${credentials.nodeId}
        and command_type = 'start') as starts,
        (select count(*)::int from server_leases where match_id = ${newMatchId} and status = 'active') as active
    `;
    expect(beforeDrain).toEqual({ starts: 0, active: 0 });
    await service.acknowledgeCommand(credentials.token, drain.id, drain.claimToken, true, { state: drainedState });
    await sendHeartbeat(drainedState);
    if (drainedState === "offline") {
      await vi.waitFor(async () => {
        const [start] = await sql<{ id: string }[]>`
          select id from node_commands where node_id = ${credentials.nodeId} and command_type = 'start'
        `;
        expect(start).toBeDefined();
      });
      const start = (await sendHeartbeat("offline")).commands.find((command) => command.commandType === "start")!;
      expect(start).toBeDefined();
      // A third join sees an offline heartbeat while start is already claimed.
      // It must share that command, not launch a second process.
      const retry = service.leaseReadyServer(leaseInput(newMatchId));
      const retriedResult = retry.catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect((await sendHeartbeat("offline")).commands).toEqual([]);
      await service.acknowledgeCommand(credentials.token, start.id, start.claimToken, true, { state: "starting" });
      await sendHeartbeat("ready");
      expect(await retriedResult).toMatchObject({ manifest: { matchId: newMatchId } });
    }
    const settled = await results;
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const leases = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(new Set(leases.map((lease) => lease.id)).size).toBe(1);
    const [starts] = await sql<{ count: number }[]>`
      select count(*)::int as count from node_commands where node_id = ${credentials.nodeId} and command_type = 'start'
    `;
    expect(starts?.count).toBe(drainedState === "offline" ? 1 : 0);
  });

  it("never leases one server to two concurrent matches", async () => {
    const credentials = await service.registerNode({ name: "race-node", region: "EU West" });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{ ...heartbeat.instances[0]!, instanceKey: "race-01", gamePort: 27315,
        gotvPort: 27320, address: "127.0.0.1:27315" }]
    });
    const matches = [randomUUID(), randomUUID()];
    await Promise.all(matches.map(createMatch));
    const attempts = await Promise.allSettled(matches.map((matchId) => service.leaseReadyServer({
      matchId,
      region: "EU West",
      ttlSeconds: 60,
      payload: {
        roster: [],
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        serverPassword: "aftertickRacePassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    })));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(NoServerCapacityError);
    const [active] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from server_leases lease
      join server_instances instance on instance.id = lease.server_instance_id
      where instance.node_id = ${credentials.nodeId} and lease.status = 'active'
    `;
    expect(active?.count).toBe(1);
  });

  it("quarantines an expired live lease and exposes zero regional capacity", async () => {
    const credentials = await service.registerNode({
      name: "node-loss-drill",
      region: "Resilience Test"
    });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...heartbeat.instances[0]!,
        instanceKey: "loss-01",
        gamePort: 27615,
        gotvPort: 27620,
        address: "127.0.0.1:27615"
      }]
    });
    const matchId = randomUUID();
    await createMatch(matchId);
    const payload = {
      roster: [],
      map: "Mirage",
      rulesetVersion: "1.0",
      pluginVersion: "0.1.0",
      serverConfigVersion: "1.0",
      demoObjectKey: `matches/${matchId}/gotv.dem`,
      serverPassword: "aftertickNodeLossPassword123",
      integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" } as const
    };
    const lease = await service.leaseReadyServer({
      matchId,
      region: "Resilience Test",
      ttlSeconds: 60,
      payload
    });
    await sql`
      update server_leases
      set leased_at = now() - interval '2 minutes',
          expires_at = now() - interval '1 minute'
      where id = ${lease.id}
    `;

    expect(await service.quarantineExpiredLeases()).toBe(1);
    const [state] = await sql<{
      lease_status: string;
      release_reason: string;
      instance_state: string;
      quarantine_reason: string;
      quarantine_commands: number;
    }[]>`
      select lease.status::text as lease_status,
             lease.release_reason,
             instance.state::text as instance_state,
             instance.quarantine_reason,
             (
               select count(*)::int from node_commands command
               where command.node_id = instance.node_id
                 and command.command_type = 'quarantine'
                 and command.payload->>'leaseId' = ${lease.id}
             ) as quarantine_commands
      from server_leases lease
      join server_instances instance on instance.id = lease.server_instance_id
      where lease.id = ${lease.id}
    `;
    expect(state).toEqual({
      lease_status: "expired",
      release_reason: "lease_expired",
      instance_state: "quarantined",
      quarantine_reason: "lease_expired",
      quarantine_commands: 1
    });

    const nextMatchId = randomUUID();
    await createMatch(nextMatchId);
    await expect(service.leaseReadyServer({
      matchId: nextMatchId,
      region: "Resilience Test",
      ttlSeconds: 60,
      payload: {
        ...payload,
        demoObjectKey: `matches/${nextMatchId}/gotv.dem`
      }
    })).rejects.toBeInstanceOf(NoServerCapacityError);
  });

  it("fences a repeatedly unreachable leased SRCDS before TTL expiry and opens one recovery incident", async () => {
    const credentials = await service.registerNode({
      name: "srcds-crash-node",
      region: "NA Crash Test"
    });
    const instance = {
      ...heartbeat.instances[0]!,
      instanceKey: "srcds-crash-01",
      gamePort: 27815,
      gotvPort: 27820,
      address: "127.0.0.1:27815"
    };
    await service.heartbeat(credentials.token, { ...heartbeat, instances: [instance] });
    const matchId = randomUUID();
    await createMatch(matchId);
    await sql`update matches set status = 'live', started_at = now() where id = ${matchId}`;
    const lease = await service.leaseReadyServer({
      matchId,
      region: "NA Crash Test",
      ttlSeconds: 600,
      payload: {
        roster: [],
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret: "aftertick-srcds-crash-ingest-secret-12345",
        serverPassword: "aftertickSrcdsCrashPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    const prepared = await service.heartbeat(credentials.token, { ...heartbeat, instances: [instance] });
    const prepareCommand = prepared.commands.find((command) => command.commandType === "prepare")!;
    expect(await service.acknowledgeCommand(
      credentials.token,
      prepareCommand.id,
      prepareCommand.claimToken,
      true
    )).toBe(true);

    const failedHeartbeat = (consecutiveRconFailures: number) => ({
      ...heartbeat,
      instances: [{
        ...instance,
        state: "offline" as const,
        metadata: {
          srcdsHealth: {
            protocolVersion: 1,
            rconReachable: false,
            consecutiveRconFailures,
            activeLeaseId: lease.id,
            activeMatchId: matchId,
            lastRconSuccessAt: new Date(Date.now() - 2_000).toISOString(),
            lastRconFailureAt: new Date().toISOString(),
            observedAt: new Date().toISOString()
          }
        }
      }]
    });

    await service.heartbeat(credentials.token, failedHeartbeat(2));
    const [beforeThreshold] = await sql<{ lease_status: string; match_status: string }[]>`
      select lease.status::text as lease_status, match.status::text as match_status
      from server_leases lease
      join matches match on match.id = lease.match_id
      where lease.id = ${lease.id}
    `;
    expect(beforeThreshold).toEqual({ lease_status: "active", match_status: "live" });

    const detected = await service.heartbeat(credentials.token, failedHeartbeat(3));
    expect(detected.commands.map((command) => command.commandType)).toContain("quarantine");
    const [state] = await sql<{
      lease_status: string;
      release_reason: string;
      lease_was_unexpired: boolean;
      instance_state: string;
      quarantine_reason: string;
      match_status: string;
      incident_reason: string;
      evidence: Record<string, unknown>;
      incidents: number;
      quarantine_commands: number;
      opened_audits: number;
    }[]>`
      select lease.status::text as lease_status,
             lease.release_reason,
             lease.expires_at > now() as lease_was_unexpired,
             instance.state::text as instance_state,
             instance.quarantine_reason,
             match.status::text as match_status,
             incident.reason as incident_reason,
             incident.evidence,
             (select count(*)::int from match_recovery_incidents where match_id = ${matchId}) as incidents,
             (
               select count(*)::int from node_commands command
               where command.node_id = instance.node_id
                 and command.command_type = 'quarantine'
                 and command.payload->>'leaseId' = ${lease.id}
             ) as quarantine_commands,
             (
               select count(*)::int from audit_log audit
               where audit.action = 'match.recovery.opened'
                 and audit.detail->>'matchId' = ${matchId}
             ) as opened_audits
      from server_leases lease
      join server_instances instance on instance.id = lease.server_instance_id
      join matches match on match.id = lease.match_id
      join match_recovery_incidents incident on incident.match_id = match.id
      where lease.id = ${lease.id}
    `;
    expect(state).toMatchObject({
      lease_status: "expired",
      release_reason: "srcds_unreachable",
      lease_was_unexpired: true,
      instance_state: "quarantined",
      quarantine_reason: "srcds_unreachable",
      match_status: "disputed",
      incident_reason: "srcds_unreachable",
      incidents: 1,
      quarantine_commands: 1,
      opened_audits: 1,
      evidence: {
        consecutiveRconFailures: 3,
        reportedInstanceState: "offline"
      }
    });

    await service.heartbeat(credentials.token, failedHeartbeat(4));
    const [repeated] = await sql<{ incidents: number; quarantine_commands: number }[]>`
      select
        (select count(*)::int from match_recovery_incidents where match_id = ${matchId}) as incidents,
        (
          select count(*)::int from node_commands
          where node_id = ${credentials.nodeId}
            and command_type = 'quarantine'
            and payload->>'leaseId' = ${lease.id}
        ) as quarantine_commands
    `;
    expect(repeated).toEqual({ incidents: 1, quarantine_commands: 1 });
  });

  it("defers recovery when a canonical result was already accepted before lease expiry", async () => {
    const credentials = await service.registerNode({ name: "result-race-node", region: "NA Result Race" });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...heartbeat.instances[0]!,
        instanceKey: "result-race-01",
        gamePort: 27365,
        gotvPort: 27370,
        address: "127.0.0.1:27365"
      }]
    });
    const matchId = randomUUID();
    await createMatch(matchId);
    await sql`update matches set status = 'live', started_at = now() where id = ${matchId}`;
    const lease = await service.leaseReadyServer({
      matchId,
      region: "NA Result Race",
      ttlSeconds: 60,
      payload: {
        roster: [],
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret: "aftertick-result-race-ingest-secret-12345",
        serverPassword: "aftertickResultRacePassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    await sql`
      insert into match_results (
        id, match_id, lease_id, result_version, idempotency_key, payload_checksum,
        alpha_rounds, bravo_rounds, reason, completed_at, payload
      ) values (
        ${randomUUID()}, ${matchId}, ${lease.id}, 1, ${randomUUID()}, ${"a".repeat(64)},
        16, 12, 'completed', now(), '{}'
      )
    `;
    await sql`
      update server_leases
      set leased_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
      where id = ${lease.id}
    `;

    expect(await service.quarantineExpiredLeases()).toBe(1);
    const [state] = await sql<{
      match_status: string;
      incident_count: number;
      deferred_audits: number;
    }[]>`
      select match.status::text as match_status,
             (select count(*)::int from match_recovery_incidents where match_id = ${matchId}) as incident_count,
             (select count(*)::int from audit_log where action = 'match.recovery.deferred_for_result' and target_id = ${matchId}) as deferred_audits
      from matches match where match.id = ${matchId}
    `;
    expect(state).toEqual({ match_status: "live", incident_count: 0, deferred_audits: 1 });
  });

  it("idempotently cancels a failed ready check and drains its leased server", async () => {
    const credentials = await service.registerNode({ name: "cancel-node", region: "NA South" });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...heartbeat.instances[0]!,
        instanceKey: "cancel-01",
        gamePort: 27415,
        gotvPort: 27420,
        address: "127.0.0.1:27415"
      }]
    });
    const matchId = randomUUID();
    await createMatch(matchId);
    const lease = await service.leaseReadyServer({
      matchId,
      region: "NA South",
      ttlSeconds: 60,
      payload: {
        roster: [],
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        serverPassword: "aftertickCancelPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });

    const orchestrator = new MatchOrchestrator(sql, service);
    await orchestrator.cancelPendingMatch(matchId, "expiry");
    await orchestrator.cancelPendingMatch(matchId, "expiry");

    const [state] = await sql<{
      match_status: string;
      cancelled_reason: string;
      lease_status: string;
      instance_state: string;
      drain_commands: number;
    }[]>`
      select match.status::text as match_status,
             match.cancelled_reason,
             lease.status::text as lease_status,
             instance.state::text as instance_state,
             (
               select count(*)::int from node_commands command
               where command.node_id = instance.node_id
                 and command.command_type = 'drain'
                 and command.payload->>'leaseId' = ${lease.id}
             ) as drain_commands
      from matches match
      join server_leases lease on lease.match_id = match.id
      join server_instances instance on instance.id = lease.server_instance_id
      where match.id = ${matchId}
    `;
    expect(state).toEqual({
      match_status: "cancelled",
      cancelled_reason: "ready_check_expiry",
      lease_status: "released",
      instance_state: "draining",
      drain_commands: 1
    });
  });

  it("reserves capacity only after a durable, immutable captain map veto", async () => {
    const region = "Map Veto Test";
    const credentials = await service.registerNode({ name: "map-veto-node", region });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [
        {
          ...heartbeat.instances[0]!,
          instanceKey: "map-veto-01",
          gamePort: 27715,
          gotvPort: 27720,
          address: "127.0.0.1:27715"
        },
        {
          ...heartbeat.instances[0]!,
          instanceKey: "map-veto-02",
          gamePort: 27725,
          gotvPort: 27730,
          address: "127.0.0.1:27725"
        }
      ]
    });
    const matchId = randomUUID();
    const playerIds = Array.from({ length: 10 }, () => randomUUID());
    for (let index = 0; index < playerIds.length; index += 1) {
      await sql`
        insert into players (id, steam_id, display_name, rating)
        values (
          ${playerIds[index]!},
          ${`7656119899${String(index).padStart(7, "0")}`},
          ${`Map Veto ${index + 1}`},
          ${1100 + index}
        )
      `;
    }
    const maps = ["Mirage", "Inferno", "Nuke"];
    const plan: MatchPlan = {
      mode: "competitive",
      tickets: playerIds.map((playerId, index) => ({
        id: randomUUID(),
        fencingToken: index + 1,
        joinedAt: new Date().toISOString(),
        mode: "competitive",
        regions: [region],
        maps,
        players: [{
          playerId,
          steamId: `7656119899${String(index).padStart(7, "0")}`,
          rating: 1100 + index,
          uncertainty: 50,
          moderationBand: "normal",
          regionPings: { [region]: 20 + index }
        }],
        source: {} as never
      })),
      alphaPlayerIds: playerIds.slice(0, 5),
      bravoPlayerIds: playerIds.slice(5),
      map: "Mirage",
      mapPool: maps,
      region,
      quality: {
        score: 1,
        predictedAlphaWin: 0.5,
        ratingDifference: 5,
        pingSpread: 9,
        maxPing: 29,
        stackImbalance: 0,
        oldestWaitSeconds: 0,
        ratingWindow: 100,
        pingLimit: 70
      }
    };
    const orchestrator = new MatchOrchestrator(sql, service);
    await orchestrator.reserve(plan, matchId);
    const [before] = await sql<{ leases: number; actions: number; map_pool: string[] }[]>`
      select
        (select count(*)::int from server_leases where match_id = ${matchId}) as leases,
        (select count(*)::int from match_map_veto_actions where match_id = ${matchId}) as actions,
        map_pool
      from matches where id = ${matchId}
    `;
    expect(before).toEqual({ leases: 0, actions: 0, map_pool: maps });

    const createdAt = new Date().toISOString();
    const veto = {
      version: 1 as const,
      matchId,
      region,
      captains: { alpha: playerIds[0]!, bravo: playerIds[5]! },
      actingTeam: "bravo" as const,
      remainingMaps: ["Mirage"],
      bans: [
        {
          sequence: 1,
          map: "Nuke",
          team: "alpha" as const,
          captainPlayerId: playerIds[0]!,
          automated: false,
          createdAt
        },
        {
          sequence: 2,
          map: "Inferno",
          team: "bravo" as const,
          captainPlayerId: playerIds[5]!,
          automated: true,
          createdAt: new Date(new Date(createdAt).getTime() + 1).toISOString()
        }
      ],
      status: "allocating" as const,
      selectedMap: "Mirage",
      expiresAt: null
    };
    const assignment = await orchestrator.finalizeMapVeto(veto);
    expect(assignment).toMatchObject({ matchId, map: "Mirage", region });
    expect(["127.0.0.1:27715", "127.0.0.1:27725"]).toContain(assignment.address);
    expect(await orchestrator.finalizeMapVeto(veto)).toEqual(assignment);

    const [after] = await sql<{
      map: string;
      actions: number;
      active_leases: number;
      prepare_commands: number;
    }[]>`
      select match.map,
        (select count(*)::int from match_map_veto_actions where match_id = ${matchId}) as actions,
        (select count(*)::int from server_leases where match_id = ${matchId} and status = 'active') as active_leases,
        (select count(*)::int from node_commands where payload->'manifest'->>'matchId' = ${matchId} and command_type = 'prepare') as prepare_commands
      from matches match where match.id = ${matchId}
    `;
    expect(after).toEqual({ map: "Mirage", actions: 2, active_leases: 1, prepare_commands: 1 });

    await expect(orchestrator.finalizeMapVeto({
      ...veto,
      bans: [
        { ...veto.bans[0]!, map: "Inferno" },
        { ...veto.bans[1]!, map: "Nuke" }
      ]
    })).rejects.toThrow("conflicts");
    await expect(sql`
      update match_map_veto_actions set automated = true
      where match_id = ${matchId} and sequence = 1
    `).rejects.toThrow("append-only");
    await expect(sql`
      delete from match_map_veto_actions where match_id = ${matchId} and sequence = 1
    `).rejects.toThrow("append-only");

    const clientSelectionMatchId = randomUUID();
    await orchestrator.reserve({
      ...plan,
      map: "Inferno",
      mapPool: ["Inferno"]
    }, clientSelectionMatchId);
    const clientSelection = {
      version: 1 as const,
      matchId: clientSelectionMatchId,
      region,
      captains: { alpha: playerIds[0]!, bravo: playerIds[5]! },
      actingTeam: "alpha" as const,
      remainingMaps: ["Inferno"],
      bans: [],
      status: "allocating" as const,
      selectedMap: "Inferno",
      expiresAt: null
    };
    const clientSelectionAssignment = await orchestrator.finalizeMapVeto(clientSelection);
    expect(clientSelectionAssignment).toMatchObject({
      matchId: clientSelectionMatchId,
      map: "Inferno",
      region
    });
    expect(["127.0.0.1:27715", "127.0.0.1:27725"]).toContain(clientSelectionAssignment.address);
    expect(clientSelectionAssignment.address).not.toBe(assignment.address);
    const [clientSelectionEvidence] = await sql<{
      map_pool: string[];
      actions: number;
      active_leases: number;
    }[]>`
      select match.map_pool,
        (select count(*)::int from match_map_veto_actions where match_id = ${clientSelectionMatchId}) as actions,
        (select count(*)::int from server_leases where match_id = ${clientSelectionMatchId} and status = 'active') as active_leases
      from matches match where match.id = ${clientSelectionMatchId}
    `;
    expect(clientSelectionEvidence).toEqual({
      map_pool: ["Inferno"],
      actions: 0,
      active_leases: 1
    });
  });

  it("authenticates append-only events and settles one canonical signed result", async () => {
    const credentials = await service.registerNode({ name: "ingestion-node", region: "NA Ingest" });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...heartbeat.instances[0]!,
        instanceKey: "ingest-01",
        gamePort: 27515,
        gotvPort: 27520,
        address: "127.0.0.1:27515"
      }]
    });
    const matchId = randomUUID();
    const eventIngestSecret = "aftertick-match-event-ingestion-secret-123456789";
    const roster = Array.from({ length: 10 }, (_, index) => ({
      playerId: randomUUID(),
      steamId: `76561198${String(index).padStart(9, "0")}`,
      team: index < 5 ? "alpha" as const : "bravo" as const
    }));
    for (const player of roster) {
      await sql`
        insert into players (id, steam_id, display_name, rating)
        values (${player.playerId}, ${player.steamId}, ${`Ingest ${player.steamId}`}, 1000)
      `;
    }
    await createMatch(matchId);
    for (let index = 0; index < roster.length; index += 1) {
      await sql`
        insert into rosters (match_id, player_id, team, slot, rating_at_match)
        values (
          ${matchId}, ${roster[index]!.playerId}, ${roster[index]!.team},
          ${(index % 5) + 1}, 1000
        )
      `;
    }
    const lease = await service.leaseReadyServer({
      matchId,
      region: "NA Ingest",
      ttlSeconds: 60,
      payload: {
        roster,
        map: "Mirage",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret,
        serverPassword: "aftertickIngestPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    const ingestion = new MatchIngestionService(sql, service);
    const uploadedObjects = new Map<string, Buffer>();
    const objectStore: DemoObjectStore = {
      async put(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
        uploadedObjects.set(input.key, Buffer.concat(chunks));
      },
      async delete(key) { uploadedObjects.delete(key); },
      uri(key) { return `s3://integration-demos/${key}`; },
      async get(key) {
        const value = uploadedObjects.get(key);
        if (!value) throw new Error("Object not found.");
        return {
          body: Readable.from(value),
          contentLength: value.length,
          contentType: "application/octet-stream"
        };
      }
    };
    const demoIngestion = new DemoIngestionService(sql, ingestion, objectStore);
    const app = createApp({
      sql,
      nodeControl: service,
      matchIngestion: ingestion,
      demoIngestion,
      devIdentity: {
        playerId: roster[0]!.playerId,
        steamId: roster[0]!.steamId,
        displayName: `Ingest ${roster[0]!.steamId}`
      }
    });
    const events = {
      leaseId: lease.id,
      fencingToken: lease.fencingToken,
      events: [{
        eventId: randomUUID(),
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: "match.live",
        payload: {}
      }]
    };
    const eventRequest = () => request(app)
      .post(`/api/node/v1/matches/${matchId}/events`)
      .set("Authorization", `Bearer ${credentials.token}`)
      .set("X-Aftertick-Signature", signMatchIngestion(events, eventIngestSecret))
      .send(events);
    expect((await eventRequest()).body).toEqual({ inserted: 1, duplicates: 0, conflicts: 0 });
    expect((await eventRequest()).body).toEqual({ inserted: 0, duplicates: 1, conflicts: 0 });

    const result = {
      resultVersion: 1 as const,
      resultId: randomUUID(),
      idempotencyKey: randomUUID(),
      leaseId: lease.id,
      fencingToken: lease.fencingToken,
      alphaRounds: 16,
      bravoRounds: 12,
      reason: "completed" as const,
      completedAt: new Date().toISOString(),
      stats: roster.map((player) => ({
        steamId: player.steamId,
        kills: 0,
        deaths: 0,
        assists: 0,
        adr: 0,
        kast: 0,
        openingKills: 0,
        openingDeaths: 0,
        trades: 0,
        clutches: 0,
        flashAssists: 0,
        utilityDamage: 0,
        roundsPlayed: 28
      }))
    };
    const resultRequest = () => request(app)
      .post(`/api/node/v1/matches/${matchId}/result`)
      .set("Authorization", `Bearer ${credentials.token}`)
      .set("X-Aftertick-Signature", signMatchIngestion(result, eventIngestSecret))
      .send(result);
    const submissions = await Promise.all([resultRequest(), resultRequest()]);
    expect(submissions.every((response) => response.status === 200)).toBe(true);
    expect(submissions.every((response) => response.body.status === "settled")).toBe(true);

    const [evidence] = await sql<{
      match_status: string;
      result_status: string;
      lease_status: string;
      ledger: number;
      total_plays: number;
    }[]>`
      select match.status::text as match_status, result.status::text as result_status,
             lease.status::text as lease_status,
             (select count(*)::int from rating_changes where match_id = ${matchId}) as ledger,
             (select sum(matches_played)::int from players where id in (
               select player_id from rosters where match_id = ${matchId}
             )) as total_plays
      from matches match
      join match_results result on result.match_id = match.id
      join server_leases lease on lease.id = result.lease_id
      where match.id = ${matchId}
    `;
    expect(evidence).toEqual({
      match_status: "completed",
      result_status: "settled",
      lease_status: "released",
      ledger: 10,
      total_plays: 10
    });

    const demoBytes = Buffer.from("HL2DEMO\0signed-aftertick-integration-demo");
    const demoSha256 = createHash("sha256").update(demoBytes).digest("hex");
    const demoMetadata = {
      demoVersion: 1 as const,
      leaseId: lease.id,
      fencingToken: lease.fencingToken,
      objectKey: `matches/${matchId}/gotv.dem`,
      sizeBytes: demoBytes.length,
      sha256: demoSha256
    };
    const demoRequest = () => request(app)
      .put(`/api/node/v1/matches/${matchId}/demo`)
      .set("Authorization", `Bearer ${credentials.token}`)
      .set("Content-Type", "application/octet-stream")
      .set("X-Aftertick-Demo-Version", "1")
      .set("X-Aftertick-Lease-Id", lease.id)
      .set("X-Aftertick-Fencing-Token", lease.fencingToken)
      .set("X-Aftertick-Demo-Key", demoMetadata.objectKey)
      .set("X-Aftertick-Demo-Sha256", demoSha256)
      .set("X-Aftertick-Signature", signMatchIngestion(demoMetadata, eventIngestSecret))
      .send(demoBytes);
    expect((await demoRequest()).status).toBe(201);
    expect((await demoRequest()).status).toBe(200);
    expect(uploadedObjects.get(demoMetadata.objectKey)).toEqual(demoBytes);
    const [demoEvidence] = await sql<{
      sha256: string;
      size_bytes: number;
      demo_url: string;
      demo_checksum: string;
    }[]>`
      select artifact.sha256, artifact.size_bytes::int,
             match.demo_url, match.demo_checksum
      from match_demo_artifacts artifact
      join matches match on match.id = artifact.match_id
      where artifact.match_id = ${matchId}
    `;
    expect(demoEvidence).toEqual({
      sha256: demoSha256,
      size_bytes: demoBytes.length,
      demo_url: `s3://integration-demos/${demoMetadata.objectKey}`,
      demo_checksum: demoSha256
    });
    const profileResponse = await request(app).get(`/api/players/${roster[0]!.playerId}`);
    expect(profileResponse.status).toBe(200);
    expect(profileResponse.body).toMatchObject({
      id: roster[0]!.playerId,
      matchesPlayed: 1,
      totals: { wins: 1 },
      ratingHistory: [{ matchId }]
    });
    const detailsResponse = await request(app).get(`/api/matches/${matchId}`);
    expect(detailsResponse.status).toBe(200);
    expect(detailsResponse.body).toMatchObject({
      id: matchId,
      status: "completed",
      teams: { alpha: expect.any(Array), bravo: expect.any(Array) },
      demo: {
        checksum: demoSha256,
        sizeBytes: demoBytes.length,
        downloadUrl: `/api/matches/${matchId}/demo`
      }
    });
    expect(detailsResponse.body.teams.alpha).toHaveLength(5);
    expect(detailsResponse.body.teams.bravo).toHaveLength(5);
    const downloadResponse = await request(app).get(`/api/matches/${matchId}/demo`);
    expect(downloadResponse.status).toBe(200);
    expect(Buffer.from(downloadResponse.body)).toEqual(demoBytes);

    const conflict = { ...result, resultId: randomUUID(), idempotencyKey: randomUUID(), alphaRounds: 15 };
    const conflictResponse = await request(app)
      .post(`/api/node/v1/matches/${matchId}/result`)
      .set("Authorization", `Bearer ${credentials.token}`)
      .set("X-Aftertick-Signature", signMatchIngestion(conflict, eventIngestSecret))
      .send(conflict);
    expect(conflictResponse.body).toMatchObject({ status: "conflicting" });
    const [dispute] = await sql<{ status: string; conflicts: number; ledger: number }[]>`
      select match.status::text,
             (select count(*)::int from match_result_conflicts where match_id = ${matchId}) as conflicts,
             (select count(*)::int from rating_changes where match_id = ${matchId}) as ledger
      from matches match where id = ${matchId}
    `;
    expect(dispute).toEqual({ status: "disputed", conflicts: 1, ledger: 10 });
  });

  it("never creates no-show or abandon penalties for drop-in Deathmatch", async () => {
    const eventIngestSecret = "aftertick-deathmatch-participation-secret-123456789";
    const playerId = randomUUID();
    const steamId = "76561198000000999";
    const matchId = randomUUID();
    await sql`
      insert into players (id, steam_id, display_name, rating)
      values (${playerId}, ${steamId}, 'Drop-in Player', 1000)
    `;
    await sql`
      insert into matches (
        id, map, region, status, mode, frag_limit, time_limit_seconds
      ) values (
        ${matchId}, 'Mirage', 'NA Drop-in Policy', 'pending', 'deathmatch', 40, 600
      )
    `;
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match)
      values (${matchId}, ${playerId}, 'ffa', 1, 1000)
    `;

    const credentials = await service.registerNode({
      name: "deathmatch-participation-node",
      region: "NA Drop-in Policy"
    });
    await service.heartbeat(credentials.token, {
      ...heartbeat,
      instances: [{
        ...heartbeat.instances[0]!,
        instanceKey: "deathmatch-participation-01",
        gamePort: 28115,
        gotvPort: 28120,
        address: "127.0.0.1:28115"
      }]
    });
    const lease = await service.leaseReadyServer({
      matchId,
      region: "NA Drop-in Policy",
      ttlSeconds: 600,
      payload: {
        mode: "deathmatch",
        roster: [{ playerId, steamId, team: "ffa" }],
        map: "Mirage",
        rulesetVersion: "1.0",
        fragLimit: 40,
        timeLimitSeconds: 600,
        pluginVersion: "0.1.2",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret,
        serverPassword: "aftertickDropInPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    const occurredAt = Math.floor(Date.now() / 1_000);
    const batch = {
      leaseId: lease.id,
      fencingToken: lease.fencingToken,
      events: ["roster.no_show", "roster.abandoned"].map((type, index) => ({
        eventId: randomUUID(),
        sequence: index + 1,
        occurredAt: new Date(occurredAt * 1_000).toISOString(),
        type,
        payload: {
          policyVersion: 1,
          steamId,
          team: "ffa",
          absenceStartedAt: occurredAt - 300,
          graceSeconds: 300
        }
      }))
    };
    const ingestion = new MatchIngestionService(sql, service);
    await expect(ingestion.ingestEvents(
      credentials.token,
      matchId,
      batch,
      signMatchIngestion(batch, eventIngestSecret)
    )).resolves.toEqual({ inserted: 2, duplicates: 0, conflicts: 0 });

    const [evidence] = await sql<{ violations: number; sanctions: number }[]>`
      select
        (select count(*)::int from match_participation_violations
          where match_id = ${matchId}) as violations,
        (select count(*)::int from sanctions
          where match_id = ${matchId}) as sanctions
    `;
    expect(evidence).toEqual({ violations: 0, sanctions: 0 });
    await expect(new OperationsService(sql).assertCanQueue(playerId)).resolves.toBeUndefined();
  });

  it("creates idempotent escalating no-show and abandon penalties before settling a forfeit", async () => {
    const eventIngestSecret = "aftertick-participation-ingestion-secret-123456789";
    const roster = Array.from({ length: 10 }, (_, index) => ({
      playerId: randomUUID(),
      steamId: `76561197${String(index).padStart(9, "0")}`,
      team: index < 5 ? "alpha" as const : "bravo" as const
    }));
    for (const player of roster) {
      await sql`
        insert into players (id, steam_id, display_name, rating)
        values (${player.playerId}, ${player.steamId}, ${`Penalty ${player.steamId}`}, 1000)
      `;
    }

    async function provisionMatch(region: string, instanceKey: string, port: number) {
      const credentials = await service.registerNode({ name: `${instanceKey}-node`, region });
      await service.heartbeat(credentials.token, {
        ...heartbeat,
        instances: [{
          ...heartbeat.instances[0]!,
          instanceKey,
          gamePort: port,
          gotvPort: port + 5,
          address: `127.0.0.1:${port}`
        }]
      });
      const matchId = randomUUID();
      await createMatch(matchId);
      for (let index = 0; index < roster.length; index += 1) {
        await sql`
          insert into rosters (match_id, player_id, team, slot, rating_at_match)
          values (
            ${matchId}, ${roster[index]!.playerId}, ${roster[index]!.team},
            ${(index % 5) + 1}, 1000
          )
        `;
      }
      const lease = await service.leaseReadyServer({
        matchId,
        region,
        ttlSeconds: 600,
        payload: {
          roster,
          map: "Mirage",
          rulesetVersion: "1.0",
          pluginVersion: "0.1.0",
          serverConfigVersion: "1.0",
          demoObjectKey: `matches/${matchId}/gotv.dem`,
          eventIngestSecret,
          serverPassword: "aftertickParticipationPassword123",
          integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
        }
      });
      return { credentials, matchId, lease };
    }

    const onMatchTerminal = vi.fn(async () => undefined);
    const ingestion = new MatchIngestionService(sql, service, onMatchTerminal);
    const operations = new OperationsService(sql);
    const noShow = await provisionMatch("NA Penalty One", "penalty-01", 27915);
    const noShowTimestamp = Math.floor(Date.now() / 1_000);
    const noShowBatch = {
      leaseId: noShow.lease.id,
      fencingToken: noShow.lease.fencingToken,
      events: [{
        eventId: randomUUID(),
        sequence: 1,
        occurredAt: new Date(noShowTimestamp * 1_000).toISOString(),
        type: "roster.no_show",
        payload: {
          policyVersion: 1,
          steamId: roster[0]!.steamId,
          team: "alpha",
          absenceStartedAt: noShowTimestamp - 300,
          graceSeconds: 300
        }
      }, {
        eventId: randomUUID(),
        sequence: 2,
        occurredAt: new Date(noShowTimestamp * 1_000).toISOString(),
        type: "match.aborted",
        payload: { reason: "no_show" }
      }]
    };
    const submitNoShow = () => ingestion.ingestEvents(
      noShow.credentials.token,
      noShow.matchId,
      noShowBatch,
      signMatchIngestion(noShowBatch, eventIngestSecret)
    );
    await expect(submitNoShow()).resolves.toEqual({ inserted: 2, duplicates: 0, conflicts: 0 });
    await expect(submitNoShow()).resolves.toEqual({ inserted: 0, duplicates: 2, conflicts: 0 });
    expect(onMatchTerminal).toHaveBeenCalledTimes(2);
    expect(onMatchTerminal).toHaveBeenNthCalledWith(1, noShow.matchId);
    expect(onMatchTerminal).toHaveBeenNthCalledWith(2, noShow.matchId);
    await expect(operations.assertCanQueue(roster[0]!.playerId)).rejects.toMatchObject({ status: 403 });

    const abandon = await provisionMatch("NA Penalty Two", "penalty-02", 28015);
    const abandonTimestamp = Math.floor(Date.now() / 1_000);
    const malformedBatch = {
      leaseId: abandon.lease.id,
      fencingToken: abandon.lease.fencingToken,
      events: [{
        eventId: randomUUID(),
        sequence: 1,
        occurredAt: new Date(abandonTimestamp * 1_000).toISOString(),
        type: "match.live",
        payload: {}
      }, {
        eventId: randomUUID(),
        sequence: 2,
        occurredAt: new Date(abandonTimestamp * 1_000).toISOString(),
        type: "roster.abandoned",
        payload: {
          policyVersion: 1,
          steamId: roster[0]!.steamId,
          team: "bravo",
          absenceStartedAt: abandonTimestamp - 300,
          graceSeconds: 300
        }
      }]
    };
    await expect(ingestion.ingestEvents(
      abandon.credentials.token,
      abandon.matchId,
      malformedBatch,
      signMatchIngestion(malformedBatch, eventIngestSecret)
    )).rejects.toMatchObject({ status: 409 });
    const [rolledBack] = await sql<{ count: number }[]>`
      select count(*)::int as count from match_events where match_id = ${abandon.matchId}
    `;
    expect(rolledBack?.count).toBe(0);

    const forfeitBatch = {
      leaseId: abandon.lease.id,
      fencingToken: abandon.lease.fencingToken,
      events: [{
        eventId: randomUUID(),
        sequence: 1,
        occurredAt: new Date(abandonTimestamp * 1_000).toISOString(),
        type: "match.live",
        payload: {}
      }, {
        eventId: randomUUID(),
        sequence: 2,
        occurredAt: new Date(abandonTimestamp * 1_000).toISOString(),
        type: "roster.abandoned",
        payload: {
          policyVersion: 1,
          steamId: roster[0]!.steamId,
          team: "alpha",
          absenceStartedAt: abandonTimestamp - 300,
          graceSeconds: 300
        }
      }, {
        eventId: randomUUID(),
        sequence: 3,
        occurredAt: new Date(abandonTimestamp * 1_000).toISOString(),
        type: "match.forfeited",
        payload: { tScore: 7, ctScore: 8, stats: [] }
      }]
    };
    const submitForfeitEvents = () => ingestion.ingestEvents(
      abandon.credentials.token,
      abandon.matchId,
      forfeitBatch,
      signMatchIngestion(forfeitBatch, eventIngestSecret)
    );
    await expect(submitForfeitEvents()).resolves.toEqual({ inserted: 3, duplicates: 0, conflicts: 0 });
    await expect(submitForfeitEvents()).resolves.toEqual({ inserted: 0, duplicates: 3, conflicts: 0 });

    const forfeitResult = {
      resultVersion: 1 as const,
      resultId: randomUUID(),
      idempotencyKey: randomUUID(),
      leaseId: abandon.lease.id,
      fencingToken: abandon.lease.fencingToken,
      alphaRounds: 7,
      bravoRounds: 8,
      reason: "forfeit" as const,
      completedAt: new Date(abandonTimestamp * 1_000).toISOString(),
      stats: roster.map((player) => ({
        steamId: player.steamId,
        kills: 0,
        deaths: 0,
        assists: 0,
        adr: 0,
        kast: 0,
        openingKills: 0,
        openingDeaths: 0,
        trades: 0,
        clutches: 0,
        flashAssists: 0,
        utilityDamage: 0,
        roundsPlayed: 1
      }))
    };
    const submitForfeitResult = () => ingestion.ingestResult(
      abandon.credentials.token,
      abandon.matchId,
      forfeitResult,
      signMatchIngestion(forfeitResult, eventIngestSecret)
    );
    const resultResponses = await Promise.all([submitForfeitResult(), submitForfeitResult()]);
    expect(resultResponses.every((result) => result.status === "settled")).toBe(true);
    expect(resultResponses.every((result) => result.progression.length === 10)).toBe(true);
    expect(resultResponses[0]!.progression.every((entry) =>
      entry.xpCategory === 2
      && entry.nextLevel === entry.previousLevel
      && entry.nextXp === entry.previousXp + entry.earnedXp
    )).toBe(true);
    expect(resultResponses[1]!.progression).toEqual(resultResponses[0]!.progression);

    const participationEvidence = await sql<{
      violation_type: string;
      offense_number: number;
      penalty_minutes: number;
    }[]>`
      select violation_type::text, offense_number, penalty_minutes
      from match_participation_violations
      where player_id = ${roster[0]!.playerId}
      order by created_at, violation_type
    `;
    expect(participationEvidence).toEqual([
      { violation_type: "no_show", offense_number: 1, penalty_minutes: 15 },
      { violation_type: "abandon", offense_number: 2, penalty_minutes: 120 }
    ]);
    const [evidence] = await sql<{
      sanctions: number;
      audits: number;
      rating_changes: number;
      match_status: string;
      result_reason: string;
      result_status: string;
    }[]>`
      select
        (select count(*)::int from sanctions where player_id = ${roster[0]!.playerId}) as sanctions,
        (select count(*)::int from audit_log
          where action = 'sanction.automatic_participation'
            and detail->>'playerId' = ${roster[0]!.playerId}) as audits,
        (select count(*)::int from rating_changes where match_id = ${abandon.matchId}) as rating_changes,
        game.status::text as match_status,
        result.reason as result_reason,
        result.status::text as result_status
      from matches game
      join match_results result on result.match_id = game.id
      where game.id = ${abandon.matchId}
    `;
    expect(evidence).toEqual({
      sanctions: 2,
      audits: 2,
      rating_changes: 10,
      match_status: "completed",
      result_reason: "forfeit",
      result_status: "settled"
    });
  });
});
