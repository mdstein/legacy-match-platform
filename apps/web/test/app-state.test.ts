import type {
  BootstrapResponse,
  MapVetoState,
  MatchAssignment,
  ReadyCheck
} from "@aftertick/contracts";
import { describe, expect, it } from "vitest";
import {
  applyAcceptResult,
  applyServerEvent,
  hasPlayerAccepted
} from "../src/app-state.js";

const readyCheck: ReadyCheck = {
  matchId: "11111111-1111-4111-8111-111111111111",
  expiresAt: "2026-08-29T05:00:00.000Z",
  acceptedPlayerIds: Array.from({ length: 9 }, (_, index) => `sim-${index + 1}`),
  totalPlayers: 10,
  map: "Mirage",
  mapPool: ["Mirage", "Inferno", "Nuke"],
  region: "NA Central"
};

const mapVeto: MapVetoState = {
  version: 1,
  matchId: readyCheck.matchId,
  region: readyCheck.region,
  captains: { alpha: "steam:76561198000000000", bravo: "sim-2" },
  actingTeam: "alpha",
  remainingMaps: ["Mirage", "Inferno", "Nuke"],
  bans: [],
  status: "active",
  selectedMap: null,
  expiresAt: "2026-08-29T05:00:30.000Z"
};

const assignment: MatchAssignment = {
  matchId: readyCheck.matchId,
  map: readyCheck.map,
  region: readyCheck.region,
  serverLabel: "Prototype Server · Chicago 01",
  address: "127.0.0.1:27015",
  connectUrl: "steam://connect/127.0.0.1:27015/aftertickDemoPassword123",
  launcherUrl: "b2g://connect?server=127.0.0.1%3A27015&password=aftertickDemoPassword123"
};

function bootstrap(): BootstrapResponse {
  return {
    player: {
      id: "steam:76561198000000000",
      displayName: "Player",
      initials: "P",
      region: "NA Central",
      rank: {
        name: "Gold Nova I",
        shortName: "GN1",
        rating: 1000,
        nextRank: "Gold Nova II",
        nextRankFloor: 1125,
        progress: 0
      },
      matchesPlayed: 0,
      winRate: 0,
      recentMatches: []
    },
    queue: {
      phase: "ready-check",
      joinedAt: "2026-08-29T04:00:00.000Z",
      regions: ["NA Central"],
      maps: ["Mirage"],
      playersFound: 10,
      estimatedWaitSeconds: 74,
      ratingWindow: 50
    },
    readyCheck,
    mapVeto: null,
    assignment: null,
    platform: {
      onlinePlayers: 1284,
      activeMatches: 73,
      season: "Founders Season"
    }
  };
}

describe("match assignment state", () => {
  it("moves the queue to assigned when the accept response assigns a server", () => {
    const result = applyAcceptResult(bootstrap(), assignment);

    expect(result.queue.phase).toBe("assigned");
    expect(result.readyCheck).toBeNull();
    expect(result.assignment).toEqual(assignment);
  });

  it("moves the queue to assigned when the SSE assignment arrives", () => {
    const result = applyServerEvent(bootstrap(), {
      type: "match.assigned",
      payload: assignment
    });

    expect(result.queue.phase).toBe("assigned");
    expect(result.readyCheck).toBeNull();
    expect(result.assignment).toEqual(assignment);
  });

  it("moves the accepted roster into the map-veto room", () => {
    const result = applyAcceptResult(bootstrap(), mapVeto);

    expect(result.queue.phase).toBe("map-veto");
    expect(result.readyCheck).toBeNull();
    expect(result.mapVeto).toEqual(mapVeto);
    expect(result.assignment).toBeNull();
  });

  it("restores the map-veto room from its server event", () => {
    const result = applyServerEvent(bootstrap(), {
      type: "match.veto.updated",
      payload: mapVeto
    });

    expect(result.queue.phase).toBe("map-veto");
    expect(result.readyCheck).toBeNull();
    expect(result.mapVeto).toEqual(mapVeto);
  });

  it("recognizes an authenticated Steam player in the ready-check list", () => {
    const playerId = "steam:76561198000000000";
    const accepted = {
      ...readyCheck,
      acceptedPlayerIds: [...readyCheck.acceptedPlayerIds, playerId]
    };

    expect(hasPlayerAccepted(accepted, playerId)).toBe(true);
    expect(hasPlayerAccepted(accepted, "demo-player")).toBe(false);
  });
});
