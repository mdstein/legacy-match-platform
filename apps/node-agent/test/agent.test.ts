import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GameNodeAgent,
  ownedInventoryPolicy,
  type AgentCommand,
  type AgentDependencies
} from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { NODE_VERSION } from "../src/version.js";
import {
  manifestSignature,
  verifyManifestSignature,
  type AgentMatchManifest
} from "../src/manifest.js";

const signingSecret = "aftertick-agent-test-manifest-signing-secret";
const config: AgentConfig = {
  apiUrl: "http://127.0.0.1:8787",
  nodeToken: "aftertick-agent-test-node-token-at-least-32",
  manifestSigningSecret: signingSecret,
  serverRoot: "C:\\aftertick-test-server",
  launcherScript: "C:\\aftertick-test\\start-srcds-hidden.ps1",
  instanceKey: "csgo-01",
  serverAddress: "127.0.0.1:27115",
  host: "127.0.0.1",
  gamePort: 27115,
  gotvPort: 27120,
  latencyProbePort: 0,
  lanMode: true,
  gsltToken: undefined,
  rconPassword: "aftertick-test-rcon",
  idlePassword: "aftertick-test-idle",
  heartbeatMs: 1_000,
  serverBuildId: "12426148",
  pluginVersion: "0.1.0"
};

function manifest(fencingToken = "42"): AgentMatchManifest {
  const now = Date.now();
  return {
    manifestVersion: 1,
    matchId: randomUUID(),
    leaseId: randomUUID(),
    fencingToken,
    nodeId: randomUUID(),
    serverInstanceId: randomUUID(),
    serverAddress: config.serverAddress,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    roster: Array.from({ length: 10 }, (_, index) => ({
      playerId: randomUUID(),
      steamId: `765611980000000${String(index).padStart(2, "0")}`,
      team: index < 5 ? "alpha" as const : "bravo" as const
    })),
    map: "Mirage",
    rulesetVersion: "1.0",
    pluginVersion: "0.1.0",
    serverConfigVersion: "1.0",
    demoObjectKey: "matches/test/gotv.dem",
    eventIngestSecret: "aftertick-agent-test-event-ingestion-secret",
    serverPassword: "aftertickAgentPassword123",
    integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
  };
}

function prepareCommand(value: AgentMatchManifest, signature: string): AgentCommand {
  return {
    id: randomUUID(),
    commandType: "prepare",
    claimToken: randomUUID(),
    payload: { manifest: value, signature }
  };
}

describe("game node agent", () => {
  it("renders only exact signed owned-item attributes into the GC policy", () => {
    const value = manifest();
    const owner = value.roster[0]!;
    value.cosmetics = [{
      playerId: owner.playerId,
      steamId: owner.steamId,
      items: [{
        assetId: "50286157940",
        source: "steam",
        itemKind: "cosmetic",
        definitionIndex: 7,
        weaponKey: "ak47",
        inventoryPosition: 11,
        paintIndex: 282,
        paintWear: 0.22740158438682556,
        paintSeed: 49,
        quality: 4,
        rarity: 5,
        origin: 8,
        killEaterScoreType: null,
        killEaterValue: null,
        customName: "LO's Redline",
        stickers: [{ slot: 0, stickerId: 76, wear: 0.1, scale: null, rotation: null }],
        loadoutSlot: 15,
        equipped: true
      }]
    }];

    const policy = ownedInventoryPolicy(value);
    expect(policy).toMatch(/^"format_version" "1"\n/);
    expect(policy).not.toContain('"b2g_owned_manifest"');
    expect(policy).toContain('"50286157940"');
    expect(policy).toContain('"6" "282"');
    expect(policy).toContain('"8" "0.22740158438682556"');
    expect(policy).toContain('"113" "76"');
    expect(policy).toContain('"2" "15"');
    expect(policy).not.toContain("give_item");
    const medal = value.cosmetics[0]!.items[0]!;
    Object.assign(medal, { assetId: "8000000000000000100", source: "b2g", definitionIndex: 1331,
      weaponKey: "service_medal", loadoutSlot: 55, paintIndex: null, paintWear: null,
      paintSeed: null, stickers: [], customName: null, origin: 24 });
    const medalPolicy = ownedInventoryPolicy(value);
    expect(medalPolicy).toContain('"0" "55"');
    expect(medalPolicy).not.toContain('"2" "55"');
    expect(medalPolicy).not.toContain('"3" "55"');
  });

  it("announces only a rostered authoritative container result through server RCON", async () => {
    const value = manifest();
    const recipient = value.roster[0]!;
    const rcon = vi.fn(async () => "[B2G] Drop result announced.");
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest: vi.fn(),
        flush: vi.fn(async () => []),
        manifest: vi.fn(async () => value),
        clear: vi.fn()
      }
    });
    await expect(agent.execute({
      id: randomUUID(),
      commandType: "announce-drop",
      claimToken: randomUUID(),
      payload: {
        matchId: value.matchId,
        steamId: recipient.steamId,
        itemName: "AWP | Dragon Lore",
        rarity: 6,
        quality: 12
      }
    })).resolves.toEqual({
      announced: true,
      matchId: value.matchId,
      steamId: recipient.steamId
    });
    expect(rcon).toHaveBeenCalledWith(expect.objectContaining({
      command: `sm_aftertick_announce_drop ${recipient.steamId} 6 12 "AWP | Dragon Lore"`
    }));
    await expect(agent.execute({
      id: randomUUID(),
      commandType: "announce-drop",
      claimToken: randomUUID(),
      payload: {
        matchId: value.matchId,
        steamId: "76561198000999999",
        itemName: "AWP | Dragon Lore",
        rarity: 6,
        quality: 12
      }
    })).rejects.toThrow("active rostered match");
    expect(rcon).toHaveBeenCalledTimes(1);
    for (const reply of [
      "[B2G] Rejected invalid or disconnected drop recipient.",
      'Unknown command "sm_aftertick_announce_drop"',
      ""
    ]) {
      rcon.mockResolvedValueOnce(reply);
      await expect(agent.execute({
        id: randomUUID(), commandType: "announce-drop", claimToken: randomUUID(),
        payload: {
          matchId: value.matchId, steamId: recipient.steamId,
          itemName: "AWP | Dragon Lore", rarity: 6, quality: 12
        }
      })).rejects.toThrow("did not confirm the drop announcement");
    }
  });

  it("presents authoritative XP in game before requesting terminal drain work", async () => {
    const value = manifest();
    const receipt = {
      steamId: value.roster[0]!.steamId,
      earnedXp: 420,
      previousLevel: 3,
      previousXp: 900,
      nextLevel: 4,
      nextXp: 320,
      xpCategory: 2 as const,
      serviceDrop: {
        id: "11111111-2222-4333-8444-555555555555",
        serviceLevel: 4,
        rewardType: "b2g_service_drop" as const
      }
    };
    const acknowledgeProgression = vi.fn(async () => undefined);
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn(async () => []),
      manifest: vi.fn(async () => value),
      clear: vi.fn(),
      hasPendingTerminal: vi.fn(async () => false),
      pendingProgression: vi.fn(async () => [receipt]),
      acknowledgeProgression
    };
    const rcon = vi.fn(async (input: Parameters<AgentDependencies["rcon"]>[0]) =>
      input.command.startsWith("sm_aftertick_present_xp") ? "[B2G_XP_OK] sent" : ""
    );
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ commands: [] }), {
      status: 200
    }));
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const agent = new GameNodeAgent(config, {
      fetch: fetchMock,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump
    });

    await agent.heartbeat();

    const presentation = rcon.mock.calls.map(([input]) => input.command)
      .find((command) => command.startsWith("sm_aftertick_present_xp"));
    expect(presentation).toContain(`"${receipt.steamId}"`);
    expect(presentation).toContain('"420" "2" "4" "320"');
    expect(presentation).toContain('"1" "4"');
    expect(acknowledgeProgression).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      agentVersion: NODE_VERSION,
      deferTerminalDrain: false
    });
  });

  it("keeps heartbeating but defers drain while a terminal result needs its receipt", async () => {
    const value = manifest();
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ commands: [], activeLeaseIds: [] }), {
      status: 200
    }));
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn(async () => []),
      manifest: vi.fn(async () => value),
      clear: vi.fn(),
      hasPendingTerminal: vi.fn(async () => true),
      pendingProgression: vi.fn(async () => []),
      acknowledgeProgression: vi.fn()
    };
    const agent = new GameNodeAgent(config, {
      fetch: fetchMock,
      rcon: vi.fn(async () => ""),
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump
    });

    await agent.heartbeat();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      deferTerminalDrain: true
    });
    expect(eventPump.pendingProgression).not.toHaveBeenCalled();
    expect(eventPump.clear).not.toHaveBeenCalled();
  });

  it("preserves released-lease evidence for its terminal drain command", async () => {
    const value = manifest();
    const drain = {
      id: randomUUID(),
      commandType: "drain" as const,
      claimToken: randomUUID(),
      payload: {
        leaseId: value.leaseId,
        serverInstanceId: value.serverInstanceId,
        reason: "match_completed"
      }
    };
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ commands: [drain], activeLeaseIds: [] }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    });
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn(async () => []),
      manifest: vi.fn(async () => value),
      clear: vi.fn(async () => undefined),
      hasPendingTerminal: vi.fn(async () => false),
      pendingProgression: vi.fn(async () => []),
      acknowledgeProgression: vi.fn()
    };
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) => "");
    const demoUploader = {
      upload: vi.fn(async () => ({
        objectKey: value.demoObjectKey,
        sha256: "a".repeat(64),
        sizeBytes: 128,
        duplicate: false
      }))
    };
    const agent = new GameNodeAgent(config, {
      fetch: fetchSpy as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump,
      demoUploader
    });

    await agent.heartbeat();

    expect(rcon.mock.calls.some(([input]) => input.command === "quit")).toBe(true);
    expect(demoUploader.upload).toHaveBeenCalledWith(value);
    expect(eventPump.clear).toHaveBeenCalledOnce();
    const acknowledgement = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes(`/commands/${drain.id}/ack`)
    );
    expect(acknowledgement).toBeDefined();
    expect(JSON.parse(String(acknowledgement?.[1]?.body))).toMatchObject({
      succeeded: true,
      result: { state: "offline", terminalMatch: true }
    });
  });

  it("recovers non-drain work while an unreachable server leaves XP pending", async () => {
    const value = manifest();
    const drain = {
      id: randomUUID(),
      commandType: "drain" as const,
      claimToken: randomUUID(),
      payload: { leaseId: value.leaseId, reason: "match_completed" }
    };
    const quarantine = {
      id: randomUUID(),
      commandType: "quarantine" as const,
      claimToken: randomUUID(),
      payload: { instanceKey: "csgo-01", reason: "srcds_unreachable" }
    };
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ commands: [drain, quarantine] }), { status: 200 });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn(async () => []),
      manifest: vi.fn(async () => value),
      clear: vi.fn(),
      hasPendingTerminal: vi.fn(async () => false),
      pendingProgression: vi.fn(async () => [{
        steamId: value.roster[0]!.steamId,
        earnedXp: 420,
        previousLevel: 3,
        previousXp: 0,
        nextLevel: 3,
        nextXp: 420,
        xpCategory: 2 as const,
        serviceDrop: null
      }]),
      acknowledgeProgression: vi.fn()
    };
    const agent = new GameNodeAgent(config, {
      fetch: fetchMock,
      rcon: vi.fn(async () => { throw new Error("connection refused"); }),
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump
    });

    await agent.heartbeat();

    const heartbeatRequest = fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/heartbeat"));
    expect(JSON.parse(String(heartbeatRequest?.[1]?.body))).toMatchObject({ deferTerminalDrain: true });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes(`/commands/${quarantine.id}/ack`))).toBe(true);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes(`/commands/${drain.id}/ack`))).toBe(false);
    expect(eventPump.acknowledgeProgression).not.toHaveBeenCalled();
  });

  it("presents an XP receipt that arrives while a terminal-drain heartbeat is in flight", async () => {
    const value = manifest();
    const order: string[] = [];
    let settled = false;
    let acknowledged = false;
    const eventPump = {
      begin: vi.fn(), updateManifest: vi.fn(), flush: vi.fn(async () => []),
      manifest: vi.fn(async () => value), hasPendingTerminal: vi.fn(async () => false),
      clear: vi.fn(async () => { order.push("clear"); }),
      pendingProgression: vi.fn(async () => settled && !acknowledged ? [{
        steamId: value.roster[0]!.steamId, earnedXp: 420, previousLevel: 3, previousXp: 0,
        nextLevel: 3, nextXp: 420, xpCategory: 2 as const, serviceDrop: null
      }] : []),
      acknowledgeProgression: vi.fn(async () => { acknowledged = true; order.push("xp-ack"); })
    };
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn(async (url) => {
        if (String(url).endsWith("/heartbeat")) {
          settled = true;
          return new Response(JSON.stringify({ activeLeaseIds: [], commands: [{
            id: randomUUID(), claimToken: randomUUID(), commandType: "drain",
            payload: { reason: "match_completed", leaseId: value.leaseId }
          }] }));
        }
        return new Response('{"accepted":true}');
      }) as typeof fetch,
      rcon: vi.fn(async ({ command }) => {
        if (command.startsWith("sm_aftertick_present_xp")) { order.push("xp"); return "[B2G_XP_OK]"; }
        if (command === "quit") order.push("quit");
        return "";
      }),
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump, demoUploader: { upload: vi.fn(async () => ({ objectKey: "test", sha256: "a".repeat(64), sizeBytes: 1, duplicate: false })) }
    });
    await agent.heartbeat();
    expect(order).toEqual(["xp", "xp-ack", "quit", "clear"]);
  });

  it("starts a missing game server when the control plane requests it", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "aftertick-agent-"));
    const controller = new AbortController();
    const spawnServer = vi.fn<AgentDependencies["spawnServer"]>(() => Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter()
    }) as ChildProcess);
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return {
        ok: true,
        json: async () => ({
          activeLeaseIds: [],
          commands: [{
            id: randomUUID(),
            commandType: "start",
            claimToken: randomUUID(),
            payload: {}
          }]
        })
      } as Response;
    });

    try {
      await writeFile(join(serverRoot, "srcds.exe"), "test");
      const agent = new GameNodeAgent({ ...config, serverRoot, heartbeatMs: 1 }, {
        fetch: fetchMock as unknown as typeof fetch,
        rcon: vi.fn(async () => { throw new Error("connection refused"); }),
        spawnServer,
        eventPump: {
          begin: vi.fn(),
          updateManifest: vi.fn(),
          flush: vi.fn(async () => []),
          manifest: vi.fn(async () => null),
          clear: vi.fn()
        }
      });

      await agent.run(controller.signal);

      expect(spawnServer).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(serverRoot, { recursive: true, force: true });
    }
  });

  it("does not let a stale server wrapper exit clear a replacement process", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "aftertick-agent-restart-"));
    const children = [4244, 4245].map((pid) => Object.assign(new EventEmitter(), {
      pid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null
    }) as ChildProcess);
    const [first, second] = children as [ChildProcess, ChildProcess];
    const spawnServer = vi.fn<AgentDependencies["spawnServer"]>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    let statusReady = false;
    const rcon = vi.fn(async (input: Parameters<AgentDependencies["rcon"]>[0]) => {
      if (input.command === "status" && !statusReady) throw new Error("connection refused");
      return "hostname: B2G";
    });
    const heartbeatBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/heartbeat")) {
        heartbeatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ commands: [], activeLeaseIds: [] }), { status: 200 });
    });

    try {
      await writeFile(join(serverRoot, "srcds.exe"), "test");
      const agent = new GameNodeAgent({ ...config, serverRoot }, {
        fetch: fetchMock as unknown as typeof fetch,
        rcon,
        spawnServer,
        eventPump: {
          begin: vi.fn(),
          updateManifest: vi.fn(),
          flush: vi.fn(async () => []),
          manifest: vi.fn(async () => null),
          clear: vi.fn()
        }
      });
      const startCommand = (): AgentCommand => ({
        id: randomUUID(),
        commandType: "start",
        claimToken: randomUUID(),
        payload: {}
      });

      await agent.execute(startCommand());
      first.stdout!.emit("data", Buffer.from("AFTERTICK_PID=1111\r\n"));
      await agent.execute(startCommand());
      second.stdout!.emit("data", Buffer.from("AFTERTICK_PID=2222\r\n"));
      first.emit("exit", 0, null);

      statusReady = true;
      await agent.heartbeat();

      const instances = heartbeatBodies.at(-1)?.["instances"] as Array<Record<string, unknown>>;
      expect(instances[0]).toMatchObject({ state: "ready", processId: 2222 });
    } finally {
      await rm(serverRoot, { recursive: true, force: true });
    }
  });

  it("starts a public server securely with its app-specific Steam login token", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "aftertick-agent-public-"));
    const controller = new AbortController();
    const spawnServer = vi.fn<AgentDependencies["spawnServer"]>(() => Object.assign(new EventEmitter(), {
      pid: 4243,
      stdout: new EventEmitter(),
      stderr: new EventEmitter()
    }) as ChildProcess);
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return {
        ok: true,
        json: async () => ({
          activeLeaseIds: [],
          commands: [{
            id: randomUUID(),
            commandType: "start",
            claimToken: randomUUID(),
            payload: {}
          }]
        })
      } as Response;
    });
    const gsltToken = "0123456789abcdef0123456789abcdef";

    try {
      await writeFile(join(serverRoot, "srcds.exe"), "test");
      const agent = new GameNodeAgent({
        ...config,
        serverRoot,
        heartbeatMs: 1,
        lanMode: false,
        gsltToken
      }, {
        fetch: fetchMock as unknown as typeof fetch,
        rcon: vi.fn(async () => { throw new Error("connection refused"); }),
        spawnServer,
        eventPump: {
          begin: vi.fn(),
          updateManifest: vi.fn(),
          flush: vi.fn(async () => []),
          manifest: vi.fn(async () => null),
          clear: vi.fn()
        }
      });

      await agent.run(controller.signal);

      const launchArguments = spawnServer.mock.calls[0]![1];
      expect(launchArguments).toContain(
        process.platform === "win32" ? "-SteamAccountToken" : "+sv_setsteamaccount"
      );
      expect(launchArguments).toContain(gsltToken);
      expect(launchArguments).not.toContain("-insecure");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(serverRoot, { recursive: true, force: true });
    }
  });

  it("restores a persisted Deathmatch credential after SRCDS restarts in idle mode", async () => {
    const base = manifest();
    const active: AgentMatchManifest = {
      ...base,
      mode: "deathmatch",
      map: "Dust II",
      roster: [{
        playerId: randomUUID(),
        steamId: "76561198000000100",
        team: "ffa"
      }],
      rulesetVersion: "dm-1.0",
      fragLimit: 40,
      timeLimitSeconds: 600
    };
    const rcon = vi.fn(async (input: Parameters<AgentDependencies["rcon"]>[0]) => {
      if (input.command === "status") return "hostname: B2G";
      if (input.command === "aftertick_match_id") return '"aftertick_match_id" = ""';
      return "";
    });
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn(async () => ["match.warmup"]),
      manifest: vi.fn(async () => active),
      clear: vi.fn()
    };
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump
    });

    await expect(agent.execute({
      id: randomUUID(),
      commandType: "start",
      claimToken: randomUUID(),
      payload: {}
    })).resolves.toMatchObject({ state: "ready" });

    const commands = rcon.mock.calls.map(([input]) => input.command);
    expect(commands.some((command) =>
      command.includes(`aftertick_match_id ${active.matchId}`)
      && command.includes(`sv_password ${active.serverPassword}`)
    )).toBe(true);
    expect(commands).toContain(
      "bot_quota 14; bot_quota_mode fill; bot_auto_vacate 1; "
      + "bot_join_after_player 0; mp_limitteams 0; mp_autoteambalance 0"
    );
    expect(commands).toContain(`tv_record aftertick-${active.matchId}`);
    expect(eventPump.begin).not.toHaveBeenCalled();
    expect(eventPump.clear).not.toHaveBeenCalled();
  });

  it("does not reset a persisted match that SRCDS still has loaded", async () => {
    const active = manifest();
    const rcon = vi.fn(async (input: Parameters<AgentDependencies["rcon"]>[0]) =>
      input.command === "aftertick_match_id"
        ? `"aftertick_match_id" = "${active.matchId}"`
        : "hostname: B2G"
    );
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest: vi.fn(),
        flush: vi.fn(async () => []),
        manifest: vi.fn(async () => active),
        clear: vi.fn()
      }
    });

    await agent.execute({
      id: randomUUID(),
      commandType: "start",
      claimToken: randomUUID(),
      payload: {}
    });

    expect(rcon.mock.calls.map(([input]) => input.command)).toEqual([
      "status",
      "aftertick_match_id"
    ]);
  });

  it("stops and clears a persisted match after the control plane releases its lease", async () => {
    const released = manifest();
    let persisted: AgentMatchManifest | null = released;
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) => "hostname: B2G");
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn(async () => []),
      manifest: vi.fn(async () => persisted),
      clear: vi.fn(async () => {
        persisted = null;
      })
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ commands: [], activeLeaseIds: [] })
    }) as Response);
    const agent = new GameNodeAgent(config, {
      fetch: fetchMock as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump
    });

    await agent.heartbeat();

    expect(rcon.mock.calls.some(([input]) => input.command === "quit")).toBe(true);
    expect(eventPump.clear).toHaveBeenCalledOnce();
    expect(persisted).toBeNull();
  });

  it("verifies canonical manifests and rejects tampering", () => {
    const value = manifest();
    const signature = manifestSignature(value, signingSecret);
    expect(verifyManifestSignature(value, signature, signingSecret)).toBe(true);
    expect(verifyManifestSignature({ ...value, map: "Nuke" }, signature, signingSecret)).toBe(false);
  });

  it("prepares a rostered server once and rejects stale fencing tokens", async () => {
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) =>
      "[Aftertick] Match prepared for warmup."
    );
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest: vi.fn(),
        flush: vi.fn(async () => ["match.warmup"]),
        manifest: vi.fn(async () => null),
        clear: vi.fn()
      }
    });
    const value = manifest();
    const command = prepareCommand(value, manifestSignature(value, signingSecret));

    await expect(agent.execute(command)).resolves.toMatchObject({
      prepared: true,
      matchId: value.matchId,
      fencingToken: value.fencingToken
    });
    expect(rcon).toHaveBeenCalledTimes(3);
    expect(rcon.mock.calls[0]![0].command).toContain(`aftertick_match_id ${value.matchId}`);
    expect(rcon.mock.calls[0]![0].command).toContain("changelevel de_mirage");
    expect(rcon.mock.calls[0]![0].command).toContain("sv_password aftertickAgentPassword123");
    expect(rcon.mock.calls[0]![0].command).not.toContain("sm_aftertick_prepare");
    expect(rcon.mock.calls[0]![0].command).not.toContain("tv_record");
    expect(rcon.mock.calls[1]![0].command).toContain("bot_quota 0; bot_quota_mode normal");
    expect(rcon.mock.calls[2]![0].command).toBe(`tv_record aftertick-${value.matchId}`);
    await expect(agent.execute(command)).rejects.toThrow("Stale lease fencing token rejected");
  });

  it("prepares a one-human Deathmatch immediately with fill-mode bots", async () => {
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) =>
      "[B2G] Match prepared for warmup."
    );
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest: vi.fn(),
        flush: vi.fn(async () => ["match.warmup"]),
        manifest: vi.fn(async () => null),
        clear: vi.fn()
      }
    });
    const base = manifest();
    const value: AgentMatchManifest = {
      ...base,
      mode: "deathmatch",
      map: "Dust II",
      roster: Array.from({ length: 1 }, (_, index) => ({
        playerId: randomUUID(),
        steamId: `765611980000001${String(index).padStart(2, "0")}`,
        team: "ffa" as const
      })),
      rulesetVersion: "dm-1.0",
      fragLimit: 40,
      timeLimitSeconds: 600
    };

    await expect(agent.execute(prepareCommand(
      value,
      manifestSignature(value, signingSecret)
    ))).resolves.toMatchObject({ prepared: true, matchId: value.matchId });
    const command = rcon.mock.calls[0]![0].command;
    expect(command).toContain("aftertick_mode deathmatch");
    expect(command).toContain("aftertick_roster_ffa 76561198000000100");
    expect(command).toContain("game_type 1; game_mode 2");
    expect(command).toContain("changelevel de_dust2");
    expect(rcon.mock.calls[1]![0].command).toContain(
      "bot_quota 14; bot_quota_mode fill; bot_auto_vacate 1"
    );
    expect(rcon.mock.calls[1]![0].command).toContain("mp_limitteams 0; mp_autoteambalance 0");
  });

  it("applies a signed append-only Deathmatch roster while preserving the lease fence", async () => {
    const base = manifest();
    const active: AgentMatchManifest = {
      ...base,
      mode: "deathmatch",
      roster: [{
        playerId: randomUUID(),
        steamId: "76561198000000100",
        team: "ffa"
      }],
      rulesetVersion: "dm-1.0",
      fragLimit: 40,
      timeLimitSeconds: 600
    };
    const updated: AgentMatchManifest = {
      ...active,
      issuedAt: new Date(Date.now() + 1_000).toISOString(),
      roster: [
        ...active.roster,
        { playerId: randomUUID(), steamId: "76561198000000101", team: "ffa" }
      ]
    };
    const rcon = vi.fn(async () => "[B2G] Deathmatch roster synchronized.");
    const updateManifest = vi.fn();
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest,
        flush: vi.fn(async () => ["roster.synced"]),
        manifest: vi.fn(async () => active),
        clear: vi.fn()
      }
    });

    await expect(agent.execute({
      id: randomUUID(),
      commandType: "sync-roster",
      claimToken: randomUUID(),
      payload: { manifest: updated, signature: manifestSignature(updated, signingSecret) }
    })).resolves.toMatchObject({ synchronized: true, humanPlayers: 2 });
    expect(updateManifest).toHaveBeenCalledWith(updated);
    expect(rcon).toHaveBeenCalledWith(expect.objectContaining({
      command: "aftertick_roster_ffa 76561198000000100,76561198000000101; sm_aftertick_sync_roster"
    }));
  });

  it("does not touch SRCDS when a prepare signature is invalid", async () => {
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) => "");
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest: vi.fn(),
        flush: vi.fn(async () => []),
        manifest: vi.fn(async () => null),
        clear: vi.fn()
      }
    });
    await expect(agent.execute(prepareCommand(manifest(), "invalid"))).rejects.toThrow(
      "Match manifest signature is invalid"
    );
    expect(rcon).not.toHaveBeenCalled();
  });

  it("fails closed on an unsupported signed integrity provider", async () => {
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) => "");
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest: vi.fn(),
        flush: vi.fn(async () => []),
        manifest: vi.fn(async () => null),
        clear: vi.fn()
      }
    });
    const unsupported = {
      ...manifest(),
      integrityPolicy: { protocolVersion: 1, provider: "unlicensed-vendor", enforcement: "required" }
    } as unknown as AgentMatchManifest;
    await expect(agent.execute(prepareCommand(
      unsupported,
      manifestSignature(unsupported, signingSecret)
    ))).rejects.toThrow("Manifest integrity policy is unsupported");
    expect(rcon).not.toHaveBeenCalled();
  });

  it("reports thresholdable leased-SRCDS health evidence without exposing manifest secrets", async () => {
    const value = manifest();
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({ commands: [] })
      } as Response;
    });
    const rcon = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const agent = new GameNodeAgent(config, {
      fetch: fetchMock as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump: {
        begin: vi.fn(),
        updateManifest: vi.fn(),
        flush: vi.fn(async () => []),
        manifest: vi.fn(async () => value),
        clear: vi.fn()
      }
    });

    await agent.heartbeat();
    await agent.heartbeat();
    await agent.heartbeat();

    const instances = requests.at(-1)?.["instances"] as Array<Record<string, unknown>>;
    const metadata = instances[0]?.["metadata"] as Record<string, unknown>;
    expect(metadata["srcdsHealth"]).toMatchObject({
      protocolVersion: 1,
      rconReachable: false,
      consecutiveRconFailures: 3,
      activeLeaseId: value.leaseId,
      activeMatchId: value.matchId
    });
    expect(JSON.stringify(metadata)).not.toContain(value.serverPassword);
    expect(JSON.stringify(metadata)).not.toContain(value.eventIngestSecret);
  });

  it.each(["match_completed", "server_abort"])(
    "drains terminal reason %s without waiting for a second abort event",
    async (reason) => {
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) => "");
    const value = manifest();
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn()
        .mockResolvedValueOnce(["match.warmup"])
        .mockResolvedValueOnce([]),
      manifest: vi.fn(async () => value),
      clear: vi.fn()
    };
    const uploadedDemo = {
      objectKey: value.demoObjectKey,
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      duplicate: false
    };
    const demoUploader = { upload: vi.fn(async () => uploadedDemo) };
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump,
      demoUploader
    });
    await agent.execute(prepareCommand(value, manifestSignature(value, signingSecret)));

    await expect(agent.execute({
      id: randomUUID(),
      commandType: "drain",
      claimToken: randomUUID(),
      payload: { leaseId: value.leaseId, reason }
    })).resolves.toEqual({
      state: "offline",
      abortEventObserved: false,
      terminalMatch: true,
      demo: uploadedDemo
    });

    expect(rcon.mock.calls.some(([input]) => input.command === "sm_aftertick_abort")).toBe(false);
    expect(rcon.mock.calls.some(([input]) => input.command === "quit")).toBe(true);
    expect(rcon.mock.calls.some(([input]) =>
      input.command.includes(`sv_password ${config.idlePassword}`)
    )).toBe(false);
    expect(eventPump.flush).toHaveBeenCalledTimes(2);
    expect(demoUploader.upload).toHaveBeenCalledWith(value);
    expect(eventPump.clear).toHaveBeenCalledOnce();
    }
  );

  it("stops a terminal server even when the finalized demo cannot upload", async () => {
    const rcon = vi.fn(async (_input: Parameters<AgentDependencies["rcon"]>[0]) => "");
    const value = manifest();
    const eventPump = {
      begin: vi.fn(),
      updateManifest: vi.fn(),
      flush: vi.fn()
        .mockResolvedValueOnce(["match.warmup"])
        .mockResolvedValueOnce([]),
      manifest: vi.fn(async () => value),
      clear: vi.fn()
    };
    const demoUploader = {
      upload: vi.fn(async () => {
        throw new Error("Demo ingestion failed with 413.");
      })
    };
    const agent = new GameNodeAgent(config, {
      fetch: vi.fn() as unknown as typeof fetch,
      rcon,
      spawnServer: () => new EventEmitter() as ChildProcess,
      eventPump,
      demoUploader
    });
    await agent.execute(prepareCommand(value, manifestSignature(value, signingSecret)));

    await expect(agent.execute({
      id: randomUUID(),
      commandType: "drain",
      claimToken: randomUUID(),
      payload: { leaseId: value.leaseId, reason: "match_completed" }
    })).resolves.toEqual({
      state: "offline",
      abortEventObserved: false,
      terminalMatch: true,
      demo: null,
      demoUploadFailed: true
    });

    expect(rcon.mock.calls.some(([input]) => input.command === "quit")).toBe(true);
    expect(eventPump.clear).toHaveBeenCalledOnce();
  });
});
