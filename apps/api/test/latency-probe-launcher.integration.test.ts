import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createConnection, runMigrations, type Sql } from "@aftertick/db";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { LatencyProbeService } from "../src/latency-probe-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl
  && process.env["AFTERTICK_RUN_NATIVE_LATENCY_INTEGRATION"] === "1"
  ? describe
  : describe.skip;
const execFileAsync = promisify(execFile);

integration("native launcher latency probe boundary", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const playerId = randomUUID();
  let admin: Sql;
  let sql: Sql;
  let service: LatencyProbeService;
  let apiServer: Server;
  let a2sServer: dgram.Socket;
  let steamRoot: string;

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  beforeAll(async () => {
    steamRoot = await mkdtemp(join(tmpdir(), "b2g-native-probe-steam-"));
    const gameRoot = join(steamRoot, "steamapps", "common", "csgo legacy");
    await mkdir(join(gameRoot, "csgo"), { recursive: true });
    await writeFile(join(steamRoot, "steam.exe"), "fixture");
    await writeFile(
      join(steamRoot, "steamapps", "appmanifest_4465480.acf"),
      '"AppState"\n{\n\t"appid" "4465480"\n\t"installdir" "csgo legacy"\n}\n'
    );
    await writeFile(join(gameRoot, "csgo.exe"), "fixture");
    await writeFile(
      join(gameRoot, "csgo", "steam.inf"),
      "ClientVersion=1575\nServerVersion=1575\nPatchVersion=1.38.8.1\n"
    );
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
    await runMigrations(sql);
    await sql`
      insert into players (id, steam_id, display_name, region)
      values (${playerId}, '76561198000000124', 'Native Probe Player', 'NA Central')
    `;

    a2sServer = dgram.createSocket("udp4");
    a2sServer.on("message", (_message, remote) => {
      a2sServer.send(
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]),
        remote.port,
        remote.address
      );
    });
    a2sServer.bind(0, "127.0.0.1");
    await once(a2sServer, "listening");

    const app = createApp({
      latencyProbes: {
        regions: () => service.regions(),
        issue: (candidateId, regions) => service.issue(candidateId, regions),
        status: (candidateId) => service.status(candidateId),
        submit: (token, signature, submission) => service.submit(token, signature, submission),
        assertFresh: (playerIds, regions) => service.assertFresh(playerIds, regions)
      }
    });
    apiServer = app.listen(0, "127.0.0.1");
    await once(apiServer, "listening");
    const apiAddress = apiServer.address();
    const a2sAddress = a2sServer.address();
    if (!apiAddress || typeof apiAddress === "string" || typeof a2sAddress === "string") {
      throw new Error("Latency integration fixtures did not expose TCP/UDP ports.");
    }
    service = new LatencyProbeService(sql, {
      publicUrl: `http://127.0.0.1:${apiAddress.port}`,
      endpoints: { "NA Central": `127.0.0.1:${a2sAddress.port}` },
      challengeSeconds: 120,
      measurementSeconds: 900,
      samples: 3
    });
  });

  afterAll(async () => {
    if (apiServer) await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
    if (a2sServer) await new Promise<void>((resolveClose) => a2sServer.close(() => resolveClose()));
    if (steamRoot) await rm(steamRoot, { recursive: true, force: true });
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it("measures A2S, signs in Rust, consumes through HTTP, and persists once", async () => {
    const challenge = await service.issue(playerId, ["NA Central"]);
    const launcher = resolve(
      "apps",
      "launcher",
      "target",
      "debug",
      process.platform === "win32" ? "b2g-launcher.exe" : "b2g-launcher"
    );
    const result = await execFileAsync(launcher, ["protocol", challenge.launcherUrl, "--no-error-dialog"], {
      cwd: resolve("."),
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, AFTERTICK_STEAM_ROOT: steamRoot }
    });
    expect(result.stdout).toContain("Submitted 1 signed regional measurement");

    const status = await service.status(playerId);
    expect(status.measurements).toHaveLength(1);
    expect(status.measurements[0]).toMatchObject({
      region: "NA Central",
      requestedSamples: 3,
      successfulSamples: 3,
      packetLossPercent: 0
    });
    expect(status.measurements[0]?.medianMs).not.toBeNull();
    expect(status.measurements[0]?.p95Ms).not.toBeNull();
    await expect(service.assertFresh([playerId], ["NA Central"]))
      .resolves.toBeUndefined();

    const [stored] = await sql<{ status: string; consumed_at: Date | null }[]>`
      select status, consumed_at from latency_probe_challenges where id = ${challenge.challengeId}
    `;
    expect(stored).toMatchObject({ status: "completed" });
    expect(stored?.consumed_at).toBeInstanceOf(Date);

    await expect(execFileAsync(launcher, ["protocol", challenge.launcherUrl, "--no-error-dialog"], {
      cwd: resolve("."),
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, AFTERTICK_STEAM_ROOT: steamRoot }
    })).rejects.toMatchObject({ code: 1 });
    const counts = await sql<{ count: number }[]>`
      select count(*)::int as count
      from player_latency_measurements
      where challenge_id = ${challenge.challengeId}
    `;
    expect(counts[0]?.count).toBe(1);

    const privateChallenge = await service.issue(playerId, ["NA Central"]);
    const privateLink = new URL(privateChallenge.launcherUrl);
    privateLink.searchParams.set(
      "submit",
      "https://play.example.test/api/latency/v1/reports"
    );
    const releaseLauncher = resolve(
      "apps",
      "launcher",
      "target",
      "release",
      process.platform === "win32" ? "b2g-launcher.exe" : "b2g-launcher"
    );
    try {
      await execFileAsync(releaseLauncher, ["protocol", privateLink.toString(), "--no-error-dialog"], {
        cwd: resolve("."),
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, AFTERTICK_STEAM_ROOT: steamRoot }
      });
      throw new Error("The release launcher unexpectedly accepted a private probe target.");
    } catch (error) {
      expect(error).toMatchObject({ code: 1 });
      expect((error as { stderr?: string }).stderr).toMatch(/private or non-routable/i);
    }
    const [privateStored] = await sql<{ status: string }[]>`
      select status from latency_probe_challenges where id = ${privateChallenge.challengeId}
    `;
    expect(privateStored?.status).toBe("pending");
  });
});
