import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@aftertick/contracts";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisQueueService } from "../src/redis-queue-service.js";
import { DeathmatchDropInService } from "../src/deathmatch-drop-in-service.js";
import type { MatchOrchestrator } from "../src/match-orchestrator.js";

const redisUrl = process.env["TEST_REDIS_URL"] ?? "";
const integration = redisUrl ? describe : describe.skip;

integration("Redis queue tickets", () => {
  const prefix = `aftertick:test:${randomUUID()}:`;
  const firstClient = createClient({ url: redisUrl });
  const secondClient = createClient({ url: redisUrl });
  let first: RedisQueueService;
  let second: RedisQueueService;

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

  it("atomically deduplicates multi-instance joins and restores state", async () => {
    const playerId = "redis-queue-player";
    const request = {
      playerId,
      regions: ["NA Central"],
      maps: ["Mirage", "Inferno"]
    };

    const joins = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).join(request))
    );

    expect(new Set(joins.map((queue) => queue.joinedAt))).toHaveLength(1);
    expect(joins.every((queue) => queue.phase === "searching")).toBe(true);
    expect(await firstClient.zCard(`${prefix}queue:tickets`)).toBe(1);

    const restored = await second.getQueueRuntime(playerId);
    expect(restored.queue).toMatchObject({
      phase: "searching",
      regions: ["NA Central"],
      maps: ["Mirage", "Inferno"]
    });
  });

  it("fans cancellation events across instances and releases the ticket", async () => {
    const playerId = "redis-event-player";
    await first.join({ playerId, regions: ["NA Central"], maps: ["Nuke"] });

    const cancelled = new Promise<ServerEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for Redis event.")), 2_000);
      void second.subscribe(playerId, (event) => {
        if (event.type === "queue.cancelled") {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });

    await first.leave(playerId);
    await expect(cancelled).resolves.toMatchObject({
      type: "queue.cancelled",
      payload: { phase: "idle" }
    });
    expect((await second.getQueueRuntime(playerId)).queue.phase).toBe("idle");
  });

  it("fences failed Deathmatch cleanup to its searching ticket", async () => {
    const request = { playerId: "dm-cleanup-player", regions: ["NA Central"], maps: [], mode: "deathmatch" as const };
    await first.join(request);
    const oldTicket = (await first.ticketForPlayer(request.playerId))!;
    await second.leave(request.playerId);
    await second.join(request);
    const newTicket = (await second.ticketForPlayer(request.playerId))!;
    expect(newTicket.id).not.toBe(oldTicket.id);
    expect(await first.cancelDeathmatchTicket(oldTicket)).toBe(false);
    expect(await first.cancelDeathmatchTicket({ ...newTicket, fencingToken: oldTicket.fencingToken })).toBe(false);
    expect((await second.ticketForPlayer(request.playerId))?.id).toBe(newTicket.id);
    expect(await first.cancelDeathmatchTicket(newTicket)).toBe(true);
    expect(await second.ticketForPlayer(request.playerId)).toBeNull();
    expect(await first.cancelDeathmatchTicket(newTicket)).toBe(false);

    await second.join({ ...request, mode: "competitive", maps: ["Mirage"] });
    const competitiveTicket = (await second.ticketForPlayer(request.playerId))!;
    expect(await first.cancelDeathmatchTicket(competitiveTicket)).toBe(false);
    expect((await second.ticketForPlayer(request.playerId))?.id).toBe(competitiveTicket.id);
    await second.leave(request.playerId);
  });

  it("releases a closing member's exact search while preserving replacements and assigned matches", async () => {
    const playerId = "closing-search-leader";
    const memberId = "closing-search-member";
    const request = { playerId, regions: ["NA Central"], maps: ["Mirage"] };
    const party = { partyId: "steam-lobby:10977524123456789", leaderPlayerId: playerId, memberPlayerIds: [playerId, memberId] };
    const firstSearch = await first.joinVerifiedParty(request, party);
    expect(firstSearch.ticketId).toBeTruthy();
    expect((await second.getQueueRuntime(memberId)).queue.ticketId).toBe(firstSearch.ticketId);
    expect(await first.releaseSearch("unrelated-player", firstSearch.ticketId!)).toBe(false);
    expect(await second.releaseSearch(memberId, firstSearch.ticketId!)).toBe(true);
    expect((await first.getQueueRuntime(playerId)).queue.phase).toBe("idle");

    const replacement = await first.joinVerifiedParty(request, party);
    expect(await second.releaseSearch(memberId, firstSearch.ticketId!)).toBe(false);
    expect((await first.getQueueRuntime(playerId)).queue.ticketId).toBe(replacement.ticketId);
    // Simulate the atomic matcher winning the phase transition before cleanup.
    const ticket = (await first.ticketForPlayer(memberId))!;
    for (const phase of ["ready-check", "map-veto", "assigned"] as const) {
      ticket.queue.phase = phase;
      await firstClient.set(`${prefix}queue:ticket:${ticket.id}`, JSON.stringify(ticket));
      expect(await second.releaseSearch(memberId, replacement.ticketId!)).toBe(false);
      expect((await first.ticketForPlayer(memberId))?.queue.phase).toBe(phase);
    }
    await first.leave(playerId);
  });

  it("does not cancel a new join when an older slow allocation fails", async () => {
    const request = { playerId: "dm-slow-allocation", regions: ["NA Central"], maps: [], mode: "deathmatch" as const };
    let failAllocation!: (error: Error) => void;
    let allocationStarted!: () => void;
    const started = new Promise<void>((resolve) => { allocationStarted = resolve; });
    const allocator = {
      joinDeathmatch: () => {
        allocationStarted();
        return new Promise((_, reject) => { failAllocation = reject; });
      }
    } as unknown as MatchOrchestrator;
    const dropIn = new DeathmatchDropInService(first, allocator);
    const failedJoin = dropIn.join(request).catch((error: unknown) => error);
    await started;
    await second.leave(request.playerId);
    await second.join(request);
    const replacement = (await second.ticketForPlayer(request.playerId))!;
    failAllocation(new Error("Fixture: old server allocation failed"));
    expect(await failedJoin).toMatchObject({ status: 503 });
    expect((await second.ticketForPlayer(request.playerId))?.id).toBe(replacement.id);
    await second.leave(request.playerId);
  });

  it("assigns drop-in Deathmatch immediately and refreshes human-only occupancy", async () => {
    const matchId = randomUUID();
    const firstPlayer = "drop-in-player-1";
    const secondPlayer = "drop-in-player-2";
    await first.join({
      playerId: firstPlayer,
      regions: ["NA Central"],
      maps: [],
      mode: "deathmatch"
    });
    const firstTicket = await first.ticketForPlayer(firstPlayer);
    expect(firstTicket).not.toBeNull();
    const baseAssignment = {
      mode: "deathmatch" as const,
      matchId,
      map: "Mirage",
      region: "NA Central",
      serverLabel: "Drop-in DM",
      address: "127.0.0.1:27115",
      connectUrl: "steam://connect/127.0.0.1:27115/dropin",
      launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=dropin",
      humanPlayers: 1,
      botPlayers: 13,
      capacity: 14
    };
    await first.assignDeathmatch(firstTicket!, baseAssignment);
    expect(await second.cancelDeathmatchTicket(firstTicket!)).toBe(false);
    expect(await firstClient.zScore(`${prefix}queue:tickets`, firstTicket!.id)).toBeNull();
    await expect(second.getQueueRuntime(firstPlayer)).resolves.toMatchObject({
      queue: { phase: "assigned", playersFound: 1 },
      assignment: { matchId, humanPlayers: 1, botPlayers: 13, capacity: 14 }
    });

    await second.join({
      playerId: secondPlayer,
      regions: ["NA Central"],
      maps: [],
      mode: "deathmatch"
    });
    const secondTicket = await second.ticketForPlayer(secondPlayer);
    expect(secondTicket).not.toBeNull();
    const filledAssignment = { ...baseAssignment, humanPlayers: 2, botPlayers: 12 };
    await second.assignDeathmatch(secondTicket!, filledAssignment);
    await second.refreshDeathmatchPopulation(filledAssignment);
    await expect(first.getQueueRuntime(firstPlayer)).resolves.toMatchObject({
      queue: { phase: "assigned", playersFound: 2 },
      assignment: { matchId, humanPlayers: 2, botPlayers: 12, capacity: 14 }
    });

    await Promise.all([first.touchPresence(firstPlayer), second.touchPresence(secondPlayer)]);
    await expect(first.getPlatformPopulation()).resolves.toMatchObject({
      onlinePlayers: 2,
      deathmatchQueuePlayers: 0
    });

    expect(await first.completeDeathmatch(matchId)).toBe(2);
    await expect(second.getQueueRuntime(firstPlayer)).resolves.toMatchObject({
      queue: { phase: "idle" },
      assignment: null
    });
    await expect(first.getQueueRuntime(secondPlayer)).resolves.toMatchObject({
      queue: { phase: "idle" },
      assignment: null
    });
    expect(await first.completeDeathmatch(matchId)).toBe(0);
  });

  it("atomically moves every assigned ticket to an operator-created remake", async () => {
    const playerIds = Array.from({ length: 10 }, (_, index) => `remake-player-${index + 1}`);
    await Promise.all(playerIds.map((playerId) => first.join({
      playerId,
      regions: ["NA Central"],
      maps: ["Mirage"]
    })));
    const tickets = (await first.listSearchingTickets()).filter((ticket) =>
      ticket.memberPlayerIds.some((playerId) => playerIds.includes(playerId))
    );
    const oldMatchId = randomUUID();
    await first.createReadyCheck({
      matchId: oldMatchId,
      tickets,
      map: "Mirage",
      region: "NA Central",
      durationSeconds: 30,
      assignment: {
        map: "Mirage",
        region: "NA Central",
        serverLabel: "Original server",
        address: "127.0.0.1:27015",
        connectUrl: "steam://connect/127.0.0.1:27015/original",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27015&password=original"
      }
    });
    for (const playerId of playerIds) await first.accept(playerId, oldMatchId);

    const replacement = {
      matchId: randomUUID(),
      map: "Mirage",
      region: "NA Central",
      serverLabel: "Replacement server",
      address: "127.0.0.1:27025",
      connectUrl: "steam://connect/127.0.0.1:27025/replacement",
      launcherUrl: "b2g://connect?server=127.0.0.1%3A27025&password=replacement"
    };
    const delivered = new Promise<ServerEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for remake assignment.")), 2_000);
      void second.subscribe(playerIds[0]!, (event) => {
        if (event.type === "match.assigned" && event.payload.matchId === replacement.matchId) {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });

    await expect(second.reassignMatch(oldMatchId, replacement, playerIds))
      .resolves.toEqual({ players: 10, tickets: 10 });
    await expect(delivered).resolves.toMatchObject({
      type: "match.assigned",
      payload: { matchId: replacement.matchId, address: replacement.address }
    });
    const restored = await Promise.all(playerIds.map((playerId) => first.getQueueRuntime(playerId)));
    expect(restored.every((runtime) => runtime.assignment?.matchId === replacement.matchId)).toBe(true);
    await expect(first.reassignMatch(oldMatchId, replacement, playerIds))
      .resolves.toEqual({ players: 0, tickets: 0 });
  });
});
