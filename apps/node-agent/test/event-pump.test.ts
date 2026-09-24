import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/config.js";
import { MatchEventPump } from "../src/event-pump.js";
import type { AgentMatchManifest } from "../src/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture() {
  const serverRoot = await mkdtemp(join(tmpdir(), "aftertick-event-pump-"));
  temporaryDirectories.push(serverRoot);
  const logDirectory = join(serverRoot, "csgo", "addons", "sourcemod", "logs");
  await mkdir(logDirectory, { recursive: true });
  const eventPath = join(logDirectory, "aftertick-events.jsonl");
  await writeFile(eventPath, '{"old":"event"}\n');
  const config: AgentConfig = {
    apiUrl: "http://127.0.0.1:8787",
    nodeToken: "aftertick-event-pump-node-token-long-enough",
    manifestSigningSecret: "aftertick-event-pump-manifest-secret-long-enough",
    serverRoot,
    launcherScript: join(serverRoot, "start.ps1"),
    instanceKey: "csgo-01",
    serverAddress: "127.0.0.1:27115",
    host: "127.0.0.1",
    gamePort: 27115,
    gotvPort: 27120,
    latencyProbePort: 0,
    lanMode: true,
    rconPassword: "aftertick-event-pump-rcon",
    idlePassword: "aftertick-event-idle",
    heartbeatMs: 1_000,
    serverBuildId: "12426148",
    pluginVersion: "0.1.0"
  };
  const now = Date.now();
  const manifest: AgentMatchManifest = {
    manifestVersion: 1,
    matchId: randomUUID(),
    leaseId: randomUUID(),
    fencingToken: "42",
    nodeId: randomUUID(),
    serverInstanceId: randomUUID(),
    serverAddress: config.serverAddress,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    roster: Array.from({ length: 10 }, (_, index) => ({
      playerId: randomUUID(),
      steamId: `76561198${String(index).padStart(9, "0")}`,
      team: index < 5 ? "alpha" as const : "bravo" as const
    })),
    map: "Mirage",
    rulesetVersion: "1.0",
    pluginVersion: "0.1.0",
    serverConfigVersion: "1.0",
    demoObjectKey: "matches/test/gotv.dem",
    eventIngestSecret: "aftertick-event-pump-ingestion-secret-long-enough",
    serverPassword: "aftertickEventPumpPassword123",
    integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
  };
  return { config, manifest, eventPath };
}

describe("node-agent event pump", () => {
  it("replays a captured kill epoch unchanged after failure, ownership refresh and restart", async () => {
    const {config,manifest,eventPath}=await fixture();const batches: any[]=[];
    const assetId="8000000000000000100";
    const request=vi.fn(async (_url:unknown,init?:RequestInit)=> {
      batches.push(JSON.parse(String(init?.body)));
      return batches.length===1?new Response("retry",{status:503}):new Response("{}");
    }) as unknown as typeof fetch;
    const pump=new MatchEventPump(config,request);await pump.begin(manifest);
    await appendFile(eventPath,JSON.stringify({version:1,timestamp:1_700_000_000,matchId:manifest.matchId,type:"player.killed",
      payload:{weaponAssetId:assetId,weaponOwnershipGeneration:"0"}})+"\n");
    await expect(pump.flush()).rejects.toThrow("503");
    const updated={...manifest,cosmetics:[{playerId:manifest.roster[0]!.playerId,steamId:manifest.roster[0]!.steamId,items:[{
      assetId,source:"b2g" as const,itemKind:"cosmetic" as const,definitionIndex:7,weaponKey:"ak47",inventoryPosition:1,
      paintIndex:180,paintWear:0.1,paintSeed:1,quality:9,rarity:3,origin:8,loadoutSlot:15,equipped:false,
      killEaterScoreType:0,killEaterValue:0,ownershipGeneration:"2",customName:null,stickers:[]
    }]}]};
    await pump.updateManifest(updated);
    const restarted=new MatchEventPump(config,request);await restarted.flush();
    expect(batches).toHaveLength(2);expect(batches[1]).toEqual(batches[0]);
    expect(JSON.stringify(batches[1])).toContain('"weaponOwnershipGeneration":"0"');
  });
  it("serializes overlapping flushes and preserves replay after a failed upload", async () => {
    const { config, manifest, eventPath } = await fixture();
    const batches: any[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      batches.push(JSON.parse(String(init?.body)));
      if (batches.length === 1) { await held; return new Response("failed", { status: 503 }); }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, request);
    await pump.begin(manifest);
    await appendFile(eventPath, JSON.stringify({ version: 1, timestamp: 1_700_000_000,
      matchId: manifest.matchId, type: "player.killed", payload: {} }) + "\n");
    const first = pump.flush();
    const rejected = expect(first).rejects.toThrow("503");
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    const second = pump.flush();
    const third = pump.flush();
    expect(batches).toHaveLength(1);
    release();
    await rejected;
    expect(await second).toEqual(["player.killed"]);
    expect(await third).toEqual([]);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(batches[0]);
    expect(await new MatchEventPump(config, request).flush()).toEqual([]);
  });

  it("reads bounded appended bytes, carries partial lines, and detects same-size replacement", async () => {
    const { config, manifest, eventPath } = await fixture();
    await writeFile(eventPath, "x".repeat(2 * 1024 * 1024));
    const events: any[] = [];
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      events.push(...JSON.parse(String(init?.body)).events);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, request);
    await pump.begin(manifest);
    const line = (i: number) => JSON.stringify({ version: 1, timestamp: 1_700_000_000 + i,
      matchId: manifest.matchId, type: "player.killed", payload: { value: "a".repeat(60_000), i } });
    const appended = Array.from({ length: 20 }, (_, i) => line(i)).join("\n") + "\n";
    await appendFile(eventPath, appended + line(20).slice(0, 200));
    await pump.flush();
    expect(pump.metrics()!.bytesRead).toBe(1024 * 1024);
    await pump.flush();
    expect(events).toHaveLength(20);
    await appendFile(eventPath, line(20).slice(200) + "\n");
    await pump.flush();
    expect(events.map((entry) => entry.sequence)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(new Set(events.map((entry) => entry.eventId)).size).toBe(21);
    const previous = await readFile(eventPath);
    await rename(eventPath, `${eventPath}.old`);
    const replacement = line(21) + "\n";
    await writeFile(eventPath, replacement + " ".repeat(previous.length - replacement.length));
    await pump.flush();
    expect(events.at(-1).payload.i).toBe(21);
    expect(events.at(-1).sequence).toBe(22);
  });

  it("ingests independently of heartbeat and exposes lifecycle observations without consuming them", async () => {
    const { config, manifest, eventPath } = await fixture();
    const request = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const pump = new MatchEventPump({ ...config, eventFlushMs: 25 }, request);
    await pump.begin(manifest);
    const stop = new AbortController();
    const running = pump.run(stop.signal);
    try {
      await appendFile(eventPath, JSON.stringify({ version: 1, timestamp: 1_700_000_000,
        matchId: manifest.matchId, type: "roster.synced", payload: {} }) + "\n");
      await vi.waitFor(() => expect(pump.observedSequence("roster.synced")).toBe(1), { timeout: 800, interval: 10 });
      expect(await pump.flush()).toEqual([]);
      expect(pump.observedSequence("roster.synced")).toBe(1);
      expect(pump.metrics()).toMatchObject({ events: 1 });
    } finally { stop.abort(); await running; }
  });

  it("uploads sequenced events and one durable terminal result", async () => {
    const { config, manifest, eventPath } = await fixture();
    const requests: Array<{ url: string; body: any; headers: HeadersInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers ?? {}
      });
      if (String(url).endsWith("/result")) {
        return new Response(JSON.stringify({
          status: "settled",
          duplicate: false,
          progression: [{
            steamId: manifest.roster[0]!.steamId,
            earnedXp: 420,
            previousLevel: 3,
            previousXp: 0,
            nextLevel: 3,
            nextXp: 420,
            xpCategory: 2,
            serviceDrop: null
          }]
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, fetchMock);
    await pump.begin(manifest);
    const timestamp = Math.floor(Date.now() / 1000);
    await appendFile(eventPath, [
      JSON.stringify({ version: 1, timestamp, matchId: manifest.matchId, type: "match.live", payload: {} }),
      JSON.stringify({
        version: 1,
        timestamp,
        matchId: manifest.matchId,
        type: "match.ended",
        payload: {
          tScore: 16,
          ctScore: 12,
          stats: [[manifest.roster[0]!.steamId, 7, 5, 3, 1176, 28, 21, 2, 1, 1, 0, 2, 83]]
        }
      }),
      ""
    ].join("\n"));

    await pump.flush();
    expect(requests.map((entry) => entry.url.split("/").at(-1))).toEqual(["events", "result"]);
    expect(requests[0]!.body.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
    expect(requests[0]!.body.events.every((event: { eventId: string }) =>
      /^[a-f0-9-]{36}$/.test(event.eventId)
    )).toBe(true);
    expect(requests[1]!.body).toMatchObject({ alphaRounds: 16, bravoRounds: 12 });
    expect(requests[1]!.body.stats).toHaveLength(10);
    expect(requests[1]!.body.stats[0]).toMatchObject({
      steamId: manifest.roster[0]!.steamId,
      kills: 7,
      deaths: 5,
      assists: 3,
      adr: 42,
      kast: 75,
      openingKills: 2,
      openingDeaths: 1,
      trades: 1,
      flashAssists: 2,
      utilityDamage: 83,
      roundsPlayed: 28
    });
    expect(String((requests[0]!.headers as Record<string, string>)["X-Aftertick-Signature"])).not.toBe("");
    expect(await pump.pendingProgression()).toEqual([{
      steamId: manifest.roster[0]!.steamId,
      earnedXp: 420,
      previousLevel: 3,
      previousXp: 0,
      nextLevel: 3,
      nextXp: 420,
      xpCategory: 2,
      serviceDrop: null
    }]);

    requests.length = 0;
    const restarted = new MatchEventPump(config, fetchMock);
    await restarted.flush();
    expect(requests).toEqual([]);
    expect(await restarted.pendingProgression()).toHaveLength(1);
    await restarted.acknowledgeProgression();
    expect(await new MatchEventPump(config, fetchMock).pendingProgression()).toEqual([]);
  });

  it("retains a canonical result across a 202 settlement response and restart", async () => {
    const { config, manifest, eventPath } = await fixture();
    const resultBodies: unknown[] = [];
    let resultAttempts = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/result")) return new Response("{}", { status: 200 });
      resultBodies.push(JSON.parse(String(init?.body)));
      resultAttempts += 1;
      if (resultAttempts === 1) {
        return new Response(JSON.stringify({ status: "pending", duplicate: false, progression: [] }), {
          status: 202
        });
      }
      return new Response(JSON.stringify({
        status: "settled",
        duplicate: true,
        progression: [{
          steamId: manifest.roster[0]!.steamId,
          earnedXp: 300,
          previousLevel: 3,
          previousXp: 900,
          nextLevel: 4,
          nextXp: 200,
          xpCategory: 2,
          serviceDrop: {
            id: "11111111-2222-4333-8444-555555555555",
            serviceLevel: 4,
            rewardType: "b2g_service_drop"
          }
        }]
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, fetchMock);
    await pump.begin(manifest);
    await appendFile(eventPath, `${JSON.stringify({
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      matchId: manifest.matchId,
      type: "match.ended",
      payload: { tScore: 10, ctScore: 8, stats: [] }
    })}\n`);

    expect(await pump.flush()).toEqual(["match.ended"]);
    expect(await pump.hasPendingTerminal()).toBe(true);
    const restarted = new MatchEventPump(config, fetchMock);
    expect(await restarted.flush()).toEqual([]);
    expect(resultBodies).toHaveLength(2);
    expect(resultBodies[1]).toEqual(resultBodies[0]);
    expect(await restarted.hasPendingTerminal()).toBe(false);
    expect(await restarted.pendingProgression()).toEqual([expect.objectContaining({
      steamId: manifest.roster[0]!.steamId,
      nextLevel: 4,
      nextXp: 200
    })]);
  });

  it("rejects a settled receipt that is not roster-bound and mathematically consistent", async () => {
    const { config, manifest, eventPath } = await fixture();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith("/result")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({
        status: "settled",
        duplicate: false,
        progression: [{
          steamId: "76561198999999999",
          earnedXp: 420,
          previousLevel: 3,
          previousXp: 0,
          nextLevel: 40,
          nextXp: 999,
          xpCategory: 2
        }]
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, fetchMock);
    await pump.begin(manifest);
    await appendFile(eventPath, `${JSON.stringify({
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      matchId: manifest.matchId,
      type: "match.ended",
      payload: { tScore: 9, ctScore: 7, stats: [] }
    })}\n`);

    await expect(pump.flush()).rejects.toThrow("invalid progression data");
    expect(await pump.hasPendingTerminal()).toBe(true);
    expect(await pump.pendingProgression()).toEqual([]);
  });

  it("retries the same event identity after an upload failure and agent restart", async () => {
    const { config, manifest, eventPath } = await fixture();
    const bodies: any[] = [];
    let fail = true;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (fail) return new Response("{}", { status: 503 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, fetchMock);
    await pump.begin(manifest);
    await appendFile(eventPath, `${JSON.stringify({
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      matchId: manifest.matchId,
      type: "player.killed",
      payload: {
        attackerSteamId: manifest.roster[0]!.steamId,
        victimSteamId: manifest.roster[1]!.steamId,
        weapon: "ak47",
        weaponItemId: "8000000000000001131",
        weaponOriginalOwnerSteamId: manifest.roster[0]!.steamId
      }
    })}\n`);
    await expect(pump.flush()).rejects.toThrow("503");
    fail = false;
    await new MatchEventPump(config, fetchMock).flush();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1].events[0].payload.weaponItemId).toBe("8000000000000001131");
  });

  it("preserves a labeled synthetic anti-cheat signal through signed event upload", async () => {
    const { config, manifest, eventPath } = await fixture();
    const requests: Array<{ body: any }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, fetchMock);
    await pump.begin(manifest);
    const payload = {
      policyVersion: 1,
      steamId: manifest.roster[0]!.steamId,
      module: "b2g_pipeline_self_test",
      detectionType: 0,
      mode: "competitive",
      automaticAction: false,
      synthetic: true
    };
    await appendFile(eventPath, `${JSON.stringify({
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      matchId: manifest.matchId,
      type: "anticheat.signal",
      payload
    })}\n`);

    expect(await pump.flush()).toEqual(["anticheat.signal"]);
    expect(requests[0]!.body.events[0]).toMatchObject({ type: "anticheat.signal", payload });
    expect(String(requests[0]!.body.events[0].eventId)).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("turns a signed SourceMod forfeit into one canonical forfeit result", async () => {
    const { config, manifest, eventPath } = await fixture();
    const requests: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return String(url).endsWith("/result")
        ? new Response(JSON.stringify({ status: "settled", duplicate: false, progression: [] }), {
            status: 200
          })
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const pump = new MatchEventPump(config, fetchMock);
    await pump.begin(manifest);
    const timestamp = Math.floor(Date.now() / 1000);
    await appendFile(eventPath, [
      JSON.stringify({
        version: 1,
        timestamp,
        matchId: manifest.matchId,
        type: "roster.abandoned",
        payload: {
          policyVersion: 1,
          steamId: manifest.roster[0]!.steamId,
          team: "alpha",
          absenceStartedAt: timestamp - 300,
          graceSeconds: 300
        }
      }),
      JSON.stringify({
        version: 1,
        timestamp,
        matchId: manifest.matchId,
        type: "match.forfeited",
        payload: { tScore: 7, ctScore: 8, stats: [] }
      }),
      ""
    ].join("\n"));

    await pump.flush();
    expect(requests.map((entry) => entry.url.split("/").at(-1))).toEqual(["events", "result"]);
    expect(requests[1]!.body).toMatchObject({
      reason: "forfeit",
      alphaRounds: 7,
      bravoRounds: 8
    });
    expect(requests[1]!.body.stats).toHaveLength(10);
  });
});
