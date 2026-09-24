import { describe, expect, it } from "vitest";
import type { GameMode } from "@aftertick/contracts";
import {
  findMatch,
  type MatchmakingPlayer,
  type MatchmakingTicket,
  type ModerationBand
} from "../src/matchmaker.js";

const NOW = Date.parse("2026-08-29T17:00:00.000Z");

function player(
  playerId: string,
  rating: number,
  pings = { "NA Central": 35, "NA East": 55 },
  moderationBand: ModerationBand = "normal"
): MatchmakingPlayer {
  return {
    playerId,
    steamId: `76561198${String(Number(playerId.replace(/\D/g, "")) || 1).padStart(9, "0")}`,
    rating,
    uncertainty: 75,
    moderationBand,
    regionPings: pings
  };
}

function ticket(
  id: string,
  players: MatchmakingPlayer[],
  wait = 0,
  regions = ["NA Central", "NA East"],
  maps = ["Mirage", "Inferno"],
  mode: GameMode = "competitive"
): MatchmakingTicket {
  return {
    id,
    fencingToken: Number(id.replace(/\D/g, "")) || 1,
    joinedAt: new Date(NOW - wait * 1000).toISOString(),
    mode,
    regions,
    maps,
    players,
    source: {
      version: 1,
      id,
      fencingToken: Number(id.replace(/\D/g, "")) || 1,
      partyId: players.length > 1 ? `party-${id}` : null,
      leaderPlayerId: players[0]!.playerId,
      memberPlayerIds: players.map((candidate) => candidate.playerId),
      queue: {
        mode,
        phase: "searching",
        joinedAt: new Date(NOW - wait * 1000).toISOString(),
        regions,
        maps,
        playersFound: 0,
        estimatedWaitSeconds: 74,
        ratingWindow: 50
      },
      readyCheck: null,
      mapVeto: null,
      assignment: null
    }
  };
}

describe("deterministic matchmaker", () => {
  it("keeps parties intact while balancing equal stack shapes", () => {
    const tickets = [
      ticket("t1", [player("p1", 980), player("p2", 990), player("p3", 1000)]),
      ticket("t2", [player("p4", 1010), player("p5", 1020)]),
      ticket("t3", [player("p6", 985), player("p7", 995), player("p8", 1005)]),
      ticket("t4", [player("p9", 1015), player("p10", 1025)])
    ];

    const plan = findMatch(tickets, NOW);
    expect(plan).not.toBeNull();
    expect(plan!.alphaPlayerIds).toHaveLength(5);
    expect(plan!.bravoPlayerIds).toHaveLength(5);
    expect(plan!.quality.stackImbalance).toBe(0);
    for (const queued of tickets) {
      const onAlpha = queued.players.every((candidate) => plan!.alphaPlayerIds.includes(candidate.playerId));
      const onBravo = queued.players.every((candidate) => plan!.bravoPlayerIds.includes(candidate.playerId));
      expect(onAlpha || onBravo).toBe(true);
    }
  });

  it("widens rating and moderation constraints only after waiting", () => {
    const fresh = Array.from({ length: 10 }, (_, index) => ticket(
      `r${index}`,
      [player(`rp${index}`, index < 5 ? 900 : 1200, undefined, index === 9 ? "restricted" : "normal")]
    ));
    expect(findMatch(fresh, NOW)).toBeNull();

    const waited = fresh.map((candidate) => ({
      ...candidate,
      joinedAt: new Date(NOW - 5 * 60_000).toISOString()
    }));
    const plan = findMatch(waited, NOW);
    expect(plan).not.toBeNull();
    expect(plan!.quality.ratingWindow).toBe(350);
  });

  it("chooses the common region with the lowest worst-player latency", () => {
    const tickets = Array.from({ length: 10 }, (_, index) => ticket(
      `l${index}`,
      [player(`lp${index}`, 1000 + index, { "NA Central": 62, "NA East": 28 + index })]
    ));
    const plan = findMatch(tickets, NOW);
    expect(plan?.region).toBe("NA East");
    expect(plan?.map).toBe("Mirage");
    expect(plan?.quality.maxPing).toBe(37);
  });

  it("holds a five-stack for another five-stack before widening", () => {
    const fiveStack = ticket(
      "five-stack",
      Array.from({ length: 5 }, (_, index) => player(`five-${index}`, 1000 + index))
    );
    const solos = Array.from({ length: 5 }, (_, index) => ticket(
      `solo-${index}`,
      [player(`solo-player-${index}`, 1005 + index)]
    ));
    expect(findMatch([fiveStack, ...solos], NOW)).toBeNull();
    const waited = [fiveStack, ...solos].map((candidate) => ({
      ...candidate,
      joinedAt: new Date(NOW - 180_000).toISOString()
    }));
    expect(findMatch(waited, NOW)).not.toBeNull();
  });

  it("keeps predicted outcomes near even across a deterministic simulation", () => {
    let state = 0x5eed1234;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const probabilities: number[] = [];
    for (let run = 0; run < 100; run += 1) {
      const tickets = Array.from({ length: 10 }, (_, index) => ticket(
        `s${run}-${index}`,
        [player(`sp${run}-${index}`, 1000 + Math.round((random() - 0.5) * 90))]
      ));
      const plan = findMatch(tickets, NOW);
      expect(plan).not.toBeNull();
      probabilities.push(plan!.quality.predictedAlphaWin);
    }
    expect(Math.min(...probabilities)).toBeGreaterThan(0.47);
    expect(Math.max(...probabilities)).toBeLessThan(0.53);
  });

  it("forms a 14-player Dust II Deathmatch without mixing Competitive tickets", () => {
    const competitive = Array.from({ length: 9 }, (_, index) => ticket(
      `competitive-${index}`,
      [player(`competitive-player-${index}`, 1000)],
      120
    ));
    const deathmatch = Array.from({ length: 14 }, (_, index) => ticket(
      `dm-${index}`,
      [player(`dm-player-${index}`, 700 + index * 50)],
      60,
      ["NA Central"],
      index % 2 ? ["Mirage"] : ["Inferno"],
      "deathmatch"
    ));

    const plan = findMatch([...competitive, ...deathmatch], NOW, 5_000, () => 3);
    expect(plan).toMatchObject({
      mode: "deathmatch",
      map: "Dust II",
      region: "NA Central",
      alphaPlayerIds: [],
      bravoPlayerIds: []
    });
    expect(plan?.tickets).toHaveLength(14);
    expect(plan?.tickets.every((candidate) => candidate.mode === "deathmatch")).toBe(true);
    expect(plan?.mapPool).toEqual(["Dust II"]);
  });

  it("does not let an incomplete older mode starve a ready queue in the other mode", () => {
    const olderDeathmatch = Array.from({ length: 13 }, (_, index) => ticket(
      `old-dm-${index}`,
      [player(`old-dm-player-${index}`, 1000)],
      300,
      ["NA Central"],
      [],
      "deathmatch"
    ));
    const competitive = Array.from({ length: 10 }, (_, index) => ticket(
      `ready-competitive-${index}`,
      [player(`ready-competitive-player-${index}`, 1000 + index)]
    ));

    expect(findMatch([...olderDeathmatch, ...competitive], NOW)?.mode).toBe("competitive");
  });
});
