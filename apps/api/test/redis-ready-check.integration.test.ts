import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisMatchmaker } from "../src/matchmaker.js";
import { RedisQueueService } from "../src/redis-queue-service.js";

const redisUrl = process.env["TEST_REDIS_URL"] ?? "";
const integration = redisUrl ? describe : describe.skip;

integration("Redis ready checks", () => {
  const prefix = `aftertick:test:${randomUUID()}:`;
  const firstClient = createClient({ url: redisUrl });
  const secondClient = createClient({ url: redisUrl });
  let first!: RedisQueueService;
  let second!: RedisQueueService;

  beforeAll(async () => {
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    [first, second] = await Promise.all([
      RedisQueueService.create(firstClient, { prefix }),
      RedisQueueService.create(secondClient, { prefix })
    ]);
  });

  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
    const keys = await firstClient.keys(`${prefix}*`);
    if (keys.length > 0) await firstClient.del(keys);
    await Promise.all([firstClient.quit(), secondClient.quit()]);
  });

  async function joinTen(stem: string, maps = ["Mirage"]) {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 ? first : second).join({
        playerId: `${stem}-${index}`,
        regions: ["NA Central"],
        maps
      }))
    );
    return first.listSearchingTickets();
  }

  async function joinDeathmatch(stem: string) {
    await Promise.all(
      Array.from({ length: 14 }, (_, index) => (index % 2 ? first : second).join({
        playerId: `${stem}-${index}`,
        regions: ["NA Central"],
        maps: [],
        mode: "deathmatch"
      }))
    );
    return first.listSearchingTickets();
  }

  it("atomically transitions ten tickets through ready check to assignment", async () => {
    const tickets = await joinTen("ready-player");
    expect(tickets).toHaveLength(10);
    const ready = await first.createReadyCheck({
      tickets,
      map: "Mirage",
      region: "NA Central",
      durationSeconds: 20,
      assignment: {
        map: "Mirage",
        region: "NA Central",
        serverLabel: "Integration SRCDS",
        address: "127.0.0.1:27115",
        connectUrl: "steam://connect/127.0.0.1:27115/aftertickIntegration123",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickIntegration123"
      }
    });

    expect((await second.getQueueRuntime("ready-player-4")).readyCheck?.matchId).toBe(
      ready.matchId
    );
    expect(await first.listSearchingTickets()).toEqual([]);

    const accepts = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 ? first : second).accept(
        `ready-player-${index}`,
        ready.matchId
      ))
    );
    expect(accepts.filter((result) => "connectUrl" in result)).toHaveLength(1);

    for (let index = 0; index < 10; index += 1) {
      const runtime = await first.getQueueRuntime(`ready-player-${index}`);
      expect(runtime.queue.phase).toBe("assigned");
      expect(runtime.readyCheck).toBeNull();
      expect(runtime.assignment?.matchId).toBe(ready.matchId);
    }
  });

  it("delivers one native accept flow to every member of a grouped Steam lobby ticket", async () => {
    const leader = "native-ready-leader";
    const follower = "native-ready-follower";
    await first.joinVerifiedParty(
      { playerId: leader, regions: ["NA Central"], maps: ["Mirage"] },
      {
        partyId: "steam-lobby:109775241234567892",
        leaderPlayerId: leader,
        memberPlayerIds: [leader, follower]
      }
    );
    const soloIds = Array.from({ length: 8 }, (_, index) => `native-ready-solo-${index}`);
    await Promise.all(soloIds.map((playerId) => second.join({
      playerId,
      regions: ["NA Central"],
      maps: ["Mirage"]
    })));
    const tickets = await first.listSearchingTickets();
    expect(tickets).toHaveLength(9);
    expect(tickets.reduce((count, ticket) => count + ticket.memberPlayerIds.length, 0)).toBe(10);

    const ready = await first.createReadyCheck({
      tickets,
      map: "Mirage",
      region: "NA Central",
      durationSeconds: 20,
      assignment: {
        map: "Mirage",
        region: "NA Central",
        serverLabel: "Native Party SRCDS",
        address: "127.0.0.1:27115",
        connectUrl: "steam://connect/127.0.0.1:27115/aftertickNativeParty123",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickNativeParty123"
      }
    });
    for (const playerId of [leader, follower, ...soloIds]) {
      await first.accept(playerId, ready.matchId);
    }

    const followerRuntime = await second.getQueueRuntime(follower);
    expect(followerRuntime.queue.phase).toBe("assigned");
    expect(followerRuntime.readyCheck).toBeNull();
    expect(followerRuntime.assignment?.matchId).toBe(ready.matchId);
  });

  it("runs alternating captain vetoes before publishing the final server assignment", async () => {
    const maps = ["Mirage", "Inferno", "Nuke"];
    const tickets = await joinTen("veto-player", maps);
    const ready = await first.createReadyCheck({
      tickets,
      map: "Mirage",
      mapPool: maps,
      region: "NA Central",
      durationSeconds: 20,
      veto: {
        captains: { alpha: "veto-player-0", bravo: "veto-player-1" },
        mapPool: maps,
        turnSeconds: 30
      }
    });

    const accepts = [];
    for (let index = 0; index < 10; index += 1) {
      accepts.push(await (index % 2 ? first : second).accept(
        `veto-player-${index}`,
        ready.matchId
      ));
    }
    const opened = accepts.at(-1)!;
    expect("remainingMaps" in opened && opened.remainingMaps).toEqual(maps);
    expect((await second.getQueueRuntime("veto-player-8")).queue.phase).toBe("map-veto");
    await expect(second.banMap("veto-player-5", ready.matchId, "Nuke"))
      .rejects.toMatchObject({ status: 403 });

    const secondTurn = await first.banMap("veto-player-0", ready.matchId, "Nuke");
    expect(secondTurn.actingTeam).toBe("bravo");
    expect(secondTurn.bans).toHaveLength(1);
    const final = await second.banMap("veto-player-1", ready.matchId, "Inferno");
    expect(final).toMatchObject({
      status: "allocating",
      selectedMap: "Mirage",
      remainingMaps: ["Mirage"]
    });
    expect(final.bans.map((ban) => ban.sequence)).toEqual([1, 2]);

    const pending = await first.listPendingVetoFinalizations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toEqual(final);
    const assignment = {
      matchId: ready.matchId,
      map: "Mirage",
      region: "NA Central",
      serverLabel: "Veto SRCDS",
      address: "127.0.0.1:27115",
      connectUrl: "steam://connect/127.0.0.1:27115/aftertickVeto123",
      launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickVeto123"
    };
    expect(await second.completeMapVeto(ready.matchId, assignment)).toBe(10);
    expect(await first.listPendingVetoFinalizations()).toEqual([]);
    for (let index = 0; index < 10; index += 1) {
      const runtime = await first.getQueueRuntime(`veto-player-${index}`);
      expect(runtime.queue.phase).toBe("assigned");
      expect(runtime.mapVeto).toBeNull();
      expect(runtime.assignment).toEqual(assignment);
    }
  });

  it("uses Panorama map choices without requiring a post-accept captain action", async () => {
    await joinTen("client-map-player", ["Mirage", "Inferno", "Nuke"]);
    let reservedMap = "";
    let reservedPool: string[] = [];
    const matchmaker = new RedisMatchmaker(
      first,
      async (playerIds) => new Map(playerIds.map((playerId, index) => [playerId, {
        playerId,
        steamId: `765611980000001${String(index).padStart(2, "0")}`,
        rating: 980 + index * 4,
        uncertainty: 75,
        moderationBand: "normal" as const,
        regionPings: { "NA Central": 28 + index }
      }])),
      {
        readyCheckSeconds: 20,
        competitiveMapSelection: "client-selection",
        randomIndex: () => 1,
        reserveMatch: async (plan) => {
          reservedMap = plan.map;
          reservedPool = plan.mapPool;
          return { abort: async () => undefined };
        }
      }
    );

    const ready = await matchmaker.runOnce();
    expect(ready).toMatchObject({ map: "Inferno", mapPool: ["Inferno"] });
    expect(reservedMap).toBe("Inferno");
    expect(reservedPool).toEqual(["Inferno"]);

    let accepted;
    for (let index = 0; index < 10; index += 1) {
      accepted = await (index % 2 ? first : second).accept(
        `client-map-player-${index}`,
        ready!.matchId
      );
    }
    expect(accepted).toMatchObject({
      status: "allocating",
      selectedMap: "Inferno",
      remainingMaps: ["Inferno"],
      bans: []
    });
    expect(await first.listPendingVetoFinalizations()).toHaveLength(1);

    const assignment = {
      matchId: ready!.matchId,
      map: "Inferno",
      region: "NA Central",
      serverLabel: "Client-selected SRCDS",
      address: "127.0.0.1:27115",
      connectUrl: "steam://connect/127.0.0.1:27115/aftertickClientMap123",
      launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickClientMap123"
    };
    expect(await second.completeMapVeto(ready!.matchId, assignment)).toBe(10);
    expect((await first.getQueueRuntime("client-map-player-4")).assignment).toEqual(assignment);
  });

  it("atomically assigns a 14-player Deathmatch without opening map veto", async () => {
    const tickets = await joinDeathmatch("dm-ready-player");
    const ready = await first.createReadyCheck({
      mode: "deathmatch",
      tickets,
      map: "Anubis",
      mapPool: ["Mirage", "Inferno", "Nuke", "Overpass", "Vertigo", "Ancient", "Anubis"],
      region: "NA Central",
      durationSeconds: 20,
      assignment: {
        mode: "deathmatch",
        map: "Anubis",
        region: "NA Central",
        serverLabel: "B2G Deathmatch",
        address: "127.0.0.1:27115",
        connectUrl: "steam://connect/127.0.0.1:27115/b2gDeathmatch123",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=b2gDeathmatch123"
      }
    });
    expect(ready).toMatchObject({ mode: "deathmatch", totalPlayers: 14, map: "Anubis" });

    for (let index = 0; index < 14; index += 1) {
      await (index % 2 ? first : second).accept(`dm-ready-player-${index}`, ready.matchId);
    }
    const runtime = await first.getQueueRuntime("dm-ready-player-13");
    expect(runtime.queue).toMatchObject({ mode: "deathmatch", phase: "assigned", playersFound: 14 });
    expect(runtime.mapVeto).toBeNull();
    expect(runtime.assignment).toMatchObject({ mode: "deathmatch", map: "Anubis" });
  });

  it("auto-bans the lowest-priority remaining map when a captain turn expires", async () => {
    const maps = ["Mirage", "Inferno", "Nuke"];
    const tickets = await joinTen("timeout-veto-player", maps);
    const ready = await first.createReadyCheck({
      tickets,
      map: "Mirage",
      mapPool: maps,
      region: "NA Central",
      durationSeconds: 20,
      veto: {
        captains: { alpha: "timeout-veto-player-0", bravo: "timeout-veto-player-1" },
        mapPool: maps,
        turnSeconds: 0.05
      }
    });
    for (let index = 0; index < 10; index += 1) {
      await first.accept(`timeout-veto-player-${index}`, ready.matchId);
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
    const timedOut = await second.banMap("timeout-veto-player-0", ready.matchId, "Mirage");
    expect(timedOut).toMatchObject({
      status: "active",
      actingTeam: "bravo",
      remainingMaps: ["Mirage", "Inferno"],
      bans: [{ map: "Nuke", automated: true }]
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await first.sweepExpiredMapVetos()).toBe(1);
    const [pending] = await first.listPendingVetoFinalizations();
    expect(pending?.state).toMatchObject({
      status: "allocating",
      selectedMap: "Mirage",
      remainingMaps: ["Mirage"],
      bans: [
        {
          sequence: 1,
          map: "Nuke",
          team: "alpha",
          captainPlayerId: "timeout-veto-player-0",
          automated: true
        },
        {
          sequence: 2,
          map: "Inferno",
          team: "bravo",
          captainPlayerId: "timeout-veto-player-1",
          automated: true
        }
      ]
    });
    expect(await first.sweepExpiredMapVetos()).toBe(0);
  });

  it("expires unattended checks, releases tickets, and applies escalating cooldowns", async () => {
    const tickets = await joinTen("expiry-player");
    const ready = await second.createReadyCheck({
      tickets,
      map: "Mirage",
      region: "NA Central",
      durationSeconds: 0.05,
      assignment: {
        map: "Mirage",
        region: "NA Central",
        serverLabel: "Integration SRCDS",
        address: "127.0.0.1:27115",
        connectUrl: "steam://connect/127.0.0.1:27115/aftertickIntegration123",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickIntegration123"
      }
    });
    await first.accept("expiry-player-0", ready.matchId);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await second.sweepExpiredReadyChecks()).toBe(1);
    expect(await first.listReadyCheckCancellations()).toContainEqual({
      matchId: ready.matchId,
      reason: "expiry"
    });
    expect((await first.getQueueRuntime("expiry-player-0")).queue.phase).toBe("idle");
    await expect(first.join({
      playerId: "expiry-player-1",
      regions: ["NA Central"],
      maps: ["Mirage"]
    })).rejects.toMatchObject({ status: 429 });
    await expect(first.join({
      playerId: "expiry-player-0",
      regions: ["NA Central"],
      maps: ["Mirage"]
    })).resolves.toMatchObject({ phase: "searching" });
    await first.leave("expiry-player-0");
    await first.acknowledgeReadyCheckCancellation(ready.matchId);
    expect(await second.listReadyCheckCancellations()).toEqual([]);
  });

  it("does not cooldown native party followers who never accepted a leader-started search", async () => {
    const leader = "native-expiry-leader";
    const follower = "native-expiry-follower";
    await first.joinVerifiedParty(
      { playerId: leader, regions: ["NA Central"], maps: ["Mirage"] },
      {
        partyId: "steam-lobby:109775241234567891",
        leaderPlayerId: leader,
        memberPlayerIds: [leader, follower]
      }
    );
    await Promise.all(Array.from({ length: 8 }, (_, index) => second.join({
      playerId: `native-expiry-solo-${index}`,
      regions: ["NA Central"],
      maps: ["Mirage"]
    })));
    const tickets = await first.listSearchingTickets();
    const ready = await first.createReadyCheck({
      tickets,
      map: "Mirage",
      region: "NA Central",
      durationSeconds: 0.05,
      assignment: {
        map: "Mirage",
        region: "NA Central",
        serverLabel: "Integration SRCDS",
        address: "127.0.0.1:27115",
        connectUrl: "steam://connect/127.0.0.1:27115/aftertickIntegration123",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickIntegration123"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await first.sweepExpiredReadyChecks()).toBe(1);

    expect(await firstClient.pTTL(`${prefix}player:${leader}:queue-cooldown`)).toBeGreaterThan(0);
    expect(await firstClient.pTTL(`${prefix}player:${follower}:queue-cooldown`)).toBe(-2);
    expect(await firstClient.pTTL(`${prefix}player:native-expiry-solo-0:queue-cooldown`))
      .toBeGreaterThan(0);
    await first.acknowledgeReadyCheckCancellation(ready.matchId);
  });

  it("runs the deterministic selector against durable Redis tickets", async () => {
    await joinTen("matchmaker-player");
    const matchmaker = new RedisMatchmaker(
      first,
      async (playerIds) => new Map(playerIds.map((playerId, index) => [playerId, {
        playerId,
        steamId: `765611980000000${String(index).padStart(2, "0")}`,
        rating: 980 + index * 4,
        uncertainty: 75,
        moderationBand: "normal" as const,
        regionPings: { "NA Central": 28 + index }
      }])),
      {
        readyCheckSeconds: 20,
        assignment: {
          serverLabel: "Integration SRCDS",
          address: "127.0.0.1:27115",
          connectUrl: "steam://connect/127.0.0.1:27115/aftertickIntegration123",
          launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickIntegration123"
        }
      }
    );

    const ready = await matchmaker.runOnce();
    expect(ready).not.toBeNull();
    expect(ready?.totalPlayers).toBe(10);
    expect((await second.getQueueRuntime("matchmaker-player-3")).queue.phase).toBe(
      "ready-check"
    );
    await first.leave("matchmaker-player-0");
  });
});
