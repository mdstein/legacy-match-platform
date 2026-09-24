import { describe, expect, it } from "vitest";
import {
  calculateRatingChanges,
  type PerformanceLine,
  type RatingParticipant
} from "../src/index.js";

const averageLine: PerformanceLine = {
  kills: 20,
  deaths: 18,
  assists: 5,
  adr: 79,
  kast: 71,
  openingKills: 3,
  openingDeaths: 3,
  trades: 4,
  clutches: 1,
  flashAssists: 2,
  utilityDamage: 110,
  roundsPlayed: 30
};

function lobby(
  alphaRating = 1800,
  bravoRating = 1800,
  matchesPlayed = 50
): RatingParticipant[] {
  return Array.from({ length: 10 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    team: index < 5 ? "alpha" : "bravo",
    rating: index < 5 ? alphaRating : bravoRating,
    matchesPlayed,
    performance: { ...averageLine }
  }));
}

describe("performance-aware visible rating", () => {
  it("centers a balanced lobby near the familiar +25/-25 expectation", () => {
    const changes = calculateRatingChanges({
      participants: lobby(),
      alphaRounds: 16,
      bravoRounds: 14
    });

    expect(changes.slice(0, 5).every((change) => change.delta === 25)).toBe(true);
    expect(changes.slice(5).every((change) => change.delta === -25)).toBe(true);
  });

  it("rewards an upset and punishes the favored team more", () => {
    const changes = calculateRatingChanges({
      participants: lobby(1600, 2000),
      alphaRounds: 16,
      bravoRounds: 12
    });

    expect(changes[0]?.delta).toBeGreaterThan(30);
    expect(changes[5]?.delta).toBeLessThan(-30);
  });

  it("uses contextual performance without allowing a result inversion", () => {
    const participants = lobby();
    participants[0] = {
      ...participants[0]!,
      performance: {
        ...averageLine,
        kills: 34,
        deaths: 13,
        adr: 118,
        kast: 87,
        openingKills: 7,
        openingDeaths: 1,
        clutches: 3
      }
    };
    participants[1] = {
      ...participants[1]!,
      performance: {
        ...averageLine,
        kills: 8,
        deaths: 25,
        adr: 42,
        kast: 49,
        openingKills: 0,
        openingDeaths: 7
      }
    };
    participants[5] = {
      ...participants[5]!,
      performance: {
        ...averageLine,
        kills: 32,
        deaths: 16,
        adr: 110,
        kast: 83,
        openingKills: 6,
        openingDeaths: 2,
        clutches: 2
      }
    };

    const changes = calculateRatingChanges({
      participants,
      alphaRounds: 16,
      bravoRounds: 13
    });

    expect(changes[0]!.delta).toBeGreaterThan(changes[1]!.delta);
    expect(changes[1]!.delta).toBeGreaterThan(0);
    expect(changes[5]!.delta).toBeLessThan(0);

    const performanceSum = changes.reduce(
      (sum, change) => sum + change.components.performance,
      0
    );
    expect(performanceSum).toBeCloseTo(0, 8);
  });

  it("increases convergence during the ten placement matches", () => {
    const established = calculateRatingChanges({
      participants: lobby(1800, 1800, 50),
      alphaRounds: 16,
      bravoRounds: 14
    });
    const provisional = calculateRatingChanges({
      participants: lobby(1800, 1800, 0),
      alphaRounds: 16,
      bravoRounds: 14
    });

    expect(provisional[0]!.delta).toBeGreaterThan(established[0]!.delta);
    expect(provisional[5]!.delta).toBeLessThan(established[5]!.delta);
  });
});

