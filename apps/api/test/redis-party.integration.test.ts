import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisPartyService } from "../src/redis-party-service.js";
import { RedisQueueService } from "../src/redis-queue-service.js";

const redisUrl = process.env["TEST_REDIS_URL"] ?? "";
const integration = redisUrl ? describe : describe.skip;

integration("Redis party and atomic queue ticket", () => {
  const prefix = `aftertick:test:${randomUUID()}:`;
  const firstClient = createClient({ url: redisUrl });
  const secondClient = createClient({ url: redisUrl });
  let firstQueue!: RedisQueueService;
  let secondQueue!: RedisQueueService;
  let firstParty!: RedisPartyService;
  let secondParty!: RedisPartyService;

  beforeAll(async () => {
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    [firstQueue, secondQueue] = await Promise.all([
      RedisQueueService.create(firstClient, { prefix }),
      RedisQueueService.create(secondClient, { prefix })
    ]);
    firstParty = new RedisPartyService(firstClient, { prefix, inviteTtlMs: 75 });
    secondParty = new RedisPartyService(secondClient, { prefix, inviteTtlMs: 75 });
  });

  afterAll(async () => {
    await Promise.all([firstQueue.close(), secondQueue.close()]);
    const keys = await firstClient.keys(`${prefix}*`);
    if (keys.length > 0) await firstClient.del(keys);
    await Promise.all([firstClient.quit(), secondClient.quit()]);
  });

  it("persists a party across instances and gives all members one fenced ticket", async () => {
    const leader = "party-leader";
    const member = "party-member";
    const created = await firstParty.create(leader);
    const invite = await firstParty.invite(leader, member);

    expect(await secondParty.listInvites(member)).toEqual([invite]);
    const joined = await secondParty.acceptInvite(member, invite.id);
    expect(joined.id).toBe(created.id);
    expect((await firstParty.getForPlayer(member))?.members).toHaveLength(2);

    const queueRequest = { playerId: leader, regions: ["NA Central"], maps: ["Mirage"] };
    await expect(firstQueue.join(queueRequest)).rejects.toThrow(
      "Every party member must be ready"
    );

    await secondParty.setReady(member, true);
    const joins = await Promise.all(
      Array.from({ length: 16 }, (_, index) => (index % 2 ? firstQueue : secondQueue).join(queueRequest))
    );
    expect(new Set(joins.map((queue) => queue.joinedAt))).toHaveLength(1);
    expect(await firstClient.zCard(`${prefix}queue:tickets`)).toBe(1);
    expect((await secondQueue.getQueueRuntime(member)).queue.phase).toBe("searching");

    await expect(secondQueue.leave(member)).rejects.toThrow(
      "Only the party leader can control the queue ticket"
    );
    await expect(secondParty.leave(member)).rejects.toThrow(
      "Leave the queue before changing the party roster"
    );

    await firstQueue.leave(leader);
    expect((await secondQueue.getQueueRuntime(member)).queue.phase).toBe("idle");
    expect((await secondParty.leave(member))?.leaderPlayerId).toBe(leader);
  });

  it("creates one fenced ticket from a launcher-verified native Steam lobby", async () => {
    const leader = "native-lobby-leader";
    const member = "native-lobby-member";
    await firstQueue.joinVerifiedParty(
      {
        playerId: leader,
        regions: ["NA Central"],
        maps: ["Mirage"],
        mode: "competitive"
      },
      {
        partyId: "steam-lobby:109775241234567890",
        leaderPlayerId: leader,
        memberPlayerIds: [leader, member]
      }
    );

    const leaderTicket = await firstQueue.ticketForPlayer(leader);
    const memberTicket = await secondQueue.ticketForPlayer(member);
    expect(leaderTicket?.id).toBe(memberTicket?.id);
    expect(leaderTicket).toMatchObject({
      partyId: "steam-lobby:109775241234567890",
      leaderPlayerId: leader,
      memberPlayerIds: [leader, member]
    });
    expect((await firstQueue.getPlatformPopulation()).competitiveQueuePlayers).toBeGreaterThanOrEqual(2);
    await expect(secondQueue.leave(member)).rejects.toThrow(
      "Only the party leader can control the queue ticket"
    );
    await firstQueue.leave(leader);
    expect((await secondQueue.getQueueRuntime(member)).queue.phase).toBe("idle");
  });

  it("rejects malformed launcher party claims before Redis", async () => {
    await expect(firstQueue.joinVerifiedParty(
      { playerId: "leader", regions: ["NA Central"], maps: ["Mirage"] },
      {
        partyId: "steam-lobby:not-a-lobby",
        leaderPlayerId: "leader",
        memberPlayerIds: ["leader", "leader"]
      }
    )).rejects.toThrow("verified Steam party is invalid");
  });

  it("atomically caps concurrent invite acceptance at five members", async () => {
    const leader = "capacity-leader";
    await firstParty.create(leader);
    const candidates = Array.from({ length: 6 }, (_, index) => `capacity-${index}`);
    const invites = await Promise.all(
      candidates.map((candidate) => firstParty.invite(leader, candidate))
    );
    const results = await Promise.allSettled(
      invites.map((invite) => secondParty.acceptInvite(invite.invitedPlayerId, invite.id))
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect((await firstParty.getForPlayer(leader))?.members).toHaveLength(5);
  });

  it("expires invites in Redis", async () => {
    await firstParty.create("expiry-leader");
    await firstParty.invite("expiry-leader", "expiry-member");
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(await secondParty.listInvites("expiry-member")).toEqual([]);
  });
});
