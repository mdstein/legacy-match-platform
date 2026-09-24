import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GameNodeAgent, type AgentCommand } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { MatchEventPump } from "../src/event-pump.js";
import { manifestSignature, type AgentMatchManifest } from "../src/manifest.js";

const secret = "inventory-sync-test-manifest-signing-secret";
async function fixture(mode: "deathmatch" | "competitive" = "deathmatch") {
  const root = await mkdtemp(join(tmpdir(), "b2g-inventory-sync-"));
  const config: AgentConfig = {
    apiUrl: "http://127.0.0.1:8787", nodeToken: "inventory-sync-test-node-token-123456",
    manifestSigningSecret: secret, serverRoot: root, launcherScript: "unused.ps1",
    instanceKey: "test", serverAddress: "127.0.0.1:27115", host: "127.0.0.1",
    gamePort: 27115, gotvPort: 27120, latencyProbePort: 0, lanMode: true, gsltToken: undefined,
    rconPassword: "test-rcon", idlePassword: "test-idle", heartbeatMs: 1000,
    serverBuildId: "1575", pluginVersion: "0.1.6"
  };
  const initial: AgentMatchManifest = {
    manifestVersion: 1, manifestRevision: 1, matchId: randomUUID(), leaseId: randomUUID(),
    nodeId: randomUUID(), serverInstanceId: randomUUID(), fencingToken: "42",
    serverAddress: config.serverAddress, issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), mode,
    roster: Array.from({ length: mode === "deathmatch" ? 1 : 10 }, (_, index) => ({
      playerId: randomUUID(), steamId: `765611980000000${String(index).padStart(2, "0")}`,
      team: mode === "deathmatch" ? "ffa" : index < 5 ? "alpha" : "bravo"
    })),
    cosmetics: [], map: "Dust II", rulesetVersion: "1", pluginVersion: "0.1.6",
    serverConfigVersion: "1", demoObjectKey: "matches/test.dem", serverPassword: "testPassword123",
    eventIngestSecret: "inventory-sync-test-event-ingestion-secret",
    integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
  };
  const request = vi.fn() as unknown as typeof fetch;
  const pump = new MatchEventPump(config, request);
  await pump.begin(initial);
  const rcon = vi.fn(async () => "ok");
  const spawnServer = vi.fn(() => { throw new Error("Inventory sync must not spawn a server"); });
  const makeAgent = (eventPump = pump) => new GameNodeAgent(config, {
    fetch: request, rcon, spawnServer, eventPump
  });
  const updated: AgentMatchManifest = {
    ...initial, manifestRevision: 2,
    cosmetics: [{ playerId: initial.roster[0]!.playerId, steamId: initial.roster[0]!.steamId, items: [{
      assetId: "8000000000000000042", source: "b2g", itemKind: "cosmetic",
      definitionIndex: 7, weaponKey: "ak47", inventoryPosition: 1073741829,
      paintIndex: 180, paintWear: 0.1, paintSeed: 42, quality: 9, rarity: 5, origin: 8,
      killEaterScoreType: 0, killEaterValue: 0, customName: null, stickers: [],
      loadoutSlot: 15, equipped: true
    }] }]
  };
  const command = (manifest = updated, commandType: AgentCommand["commandType"] = "sync-inventory"): AgentCommand => ({
    id: randomUUID(), claimToken: randomUUID(), commandType,
    payload: { manifest, signature: manifestSignature(manifest, secret) }
  });
  const policy = () => readFile(join(root, "csgo_gc", "b2g_owned_manifest.txt"), "utf8");
  return { root, config, initial, updated, pump, makeAgent, command, policy, rcon, spawnServer, request };
}

describe("live signed server inventory refresh", () => {
  it.each(["deathmatch", "competitive"] as const)("persists %s updates without restarting or resetting event progress", async (mode) => {
    const f = await fixture(mode);
    try {
      const agent = f.makeAgent();
      const statePath = join(f.root, ".aftertick-node-state.json");
      const before = JSON.parse(await readFile(statePath, "utf8"));
      await expect(agent.execute(f.command())).resolves.toMatchObject({ inventorySynchronized: true, manifestRevision: 2 });
      expect(await f.policy()).toContain('"8000000000000000042"');
      const after = JSON.parse(await readFile(statePath, "utf8"));
      expect(after).toEqual({ ...before, manifest: f.updated });
      expect(f.rcon).not.toHaveBeenCalled();
      expect(f.spawnServer).not.toHaveBeenCalled();

      // Durable state, not an in-memory last-seen revision, guards replay after restart.
      const restartedPump = new MatchEventPump(f.config, f.request);
      const restarted = f.makeAgent(restartedPump);
      await expect(restarted.execute(f.command())).resolves.toMatchObject({ alreadyApplied: true });
      const third = structuredClone(f.updated);
      third.manifestRevision = 3;
      third.cosmetics![0]!.items[0]!.killEaterValue = 5;
      await restarted.execute(f.command(third));
      expect(await f.policy()).toContain('"80" "5"');
      await expect(restarted.execute(f.command())).resolves.toMatchObject({ superseded: true, manifestRevision: 3 });
      expect(await f.policy()).toContain('"80" "5"');
      expect((await restartedPump.manifest())?.manifestRevision).toBe(3);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("rejects signature, owner, lease, configuration, roster and revision substitutions before writing", async () => {
    const f = await fixture("competitive");
    try {
      const agent = f.makeAgent();
      await agent.execute(f.command());
      const accepted = await f.policy();
      const mutations: Array<(value: AgentMatchManifest) => void> = [
        (value) => { value.nodeId = randomUUID(); },
        (value) => { value.leaseId = randomUUID(); },
        (value) => { value.fencingToken = "43"; },
        (value) => { value.serverAddress = "127.0.0.1:27116"; },
        (value) => { value.expiresAt = "invalid"; },
        (value) => { value.expiresAt = new Date(0).toISOString(); },
        (value) => { value.map = "Mirage"; },
        (value) => { value.eventIngestSecret = "different-event-ingestion-secret"; },
        (value) => { value.cosmetics![0]!.steamId = "76561198999999999"; },
        (value) => { value.cosmetics!.push(value.cosmetics![0]!); },
        (value) => { value.cosmetics![0]!.items.push(value.cosmetics![0]!.items[0]!); },
        (value) => { value.roster.pop(); },
        (value) => { value.manifestRevision = 2; value.cosmetics = []; },
        (value) => { value.manifestRevision = 1.5; },
        (value) => { delete value.manifestRevision; }
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(f.updated);
        changed.manifestRevision = 3;
        mutate(changed);
        await expect(agent.execute(f.command(changed))).rejects.toThrow();
        expect(await f.policy()).toBe(accepted);
      }
      const badSignature = f.command();
      badSignature.payload["signature"] = "invalid";
      await expect(agent.execute(badSignature)).rejects.toThrow("signature");
      expect(f.rcon).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("lets a newer inventory snapshot carry a pending DM roster append, then ignores the stale roster command", async () => {
    const f = await fixture();
    try {
      const roster = { ...f.initial, manifestRevision: 2, roster: [...f.initial.roster, {
        playerId: randomUUID(), steamId: "76561198000000011", team: "ffa" as const
      }] };
      const latest = { ...f.updated, manifestRevision: 3, roster: roster.roster };
      const flush = vi.spyOn(f.pump, "flush").mockResolvedValue(["roster.synced"]);
      const agent = f.makeAgent();
      await expect(agent.execute(f.command(latest))).resolves.toMatchObject({ manifestRevision: 3, humanPlayers: 2 });
      expect(f.rcon).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalled();
      await expect(agent.execute(f.command(roster, "sync-roster"))).resolves.toMatchObject({ superseded: true });
      expect((await f.pump.manifest())?.roster).toHaveLength(2);
      expect(await f.policy()).toContain('"8000000000000000042"');
      expect(f.rcon).toHaveBeenCalledTimes(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("does not roll back a written policy if durable event-pump state failed and the node restarted", async () => {
    const f = await fixture();
    try {
      const latest = structuredClone(f.updated);
      latest.manifestRevision = 3;
      latest.cosmetics![0]!.items[0]!.killEaterValue = 5;
      vi.spyOn(f.pump, "updateManifest").mockRejectedValueOnce(new Error("simulated disk failure"));
      await expect(f.makeAgent().execute(f.command(latest))).rejects.toThrow("simulated disk failure");
      expect(await f.policy()).toContain('"manifest_revision" "3"');
      const restartedPump = new MatchEventPump(f.config, f.request);
      expect((await restartedPump.manifest())?.manifestRevision).toBe(1);
      const restarted = f.makeAgent(restartedPump);
      await expect(restarted.execute(f.command())).resolves.toMatchObject({ superseded: true, manifestRevision: 3 });
      expect(await f.policy()).toContain('"80" "5"');
      const conflict = structuredClone(latest);
      conflict.cosmetics = [];
      await expect(restarted.execute(f.command(conflict))).rejects.toThrow("written inventory policy");
      await restarted.execute(f.command(latest));
      expect((await restartedPump.manifest())?.manifestRevision).toBe(3);
      expect(f.rcon).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
