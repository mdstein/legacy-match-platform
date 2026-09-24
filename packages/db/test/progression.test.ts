import { describe, expect, it } from "vitest";
import { chooseServiceRewardKind } from "../src/services/settle-match.js";
import {
  advanceProfile,
  competitiveMatchXp,
  deathmatchMatchXp
} from "../src/services/progression.js";

describe("profile progression", () => {
  it("allocates exactly 93% cases, 5% souvenirs and 2% pins across the complete roll space", () => {
    const counts = { case: 0, pin_package: 0, souvenir_package: 0 };
    for (let roll = 0; roll < 10_000; roll++) counts[chooseServiceRewardKind(roll)]++;
    expect(counts).toEqual({ case: 9_300, souvenir_package: 500, pin_package: 200 });
    for (const roll of [-1, 10_000, 1.5, Number.NaN]) {
      expect(() => chooseServiceRewardKind(roll)).toThrow(RangeError);
    }
  });

  it("uses rounds won for competitive XP", () => {
    expect(competitiveMatchXp(16)).toBe(480);
    expect(competitiveMatchXp(12)).toBe(360);
  });

  it("uses authenticated human kills for deathmatch XP with a ceiling", () => {
    expect(deathmatchMatchXp(40)).toBe(160);
    expect(deathmatchMatchXp(10_000)).toBe(1_000);
  });

  it("advances levels and caps level forty pending a service-medal policy", () => {
    expect(advanceProfile({ level: 3, xp: 900 }, 480)).toEqual({
      level: 4,
      xp: 380,
      earnedXp: 480
    });
    expect(advanceProfile({ level: 40, xp: 900 }, 480)).toEqual({
      level: 40,
      xp: 999,
      earnedXp: 480
    });
  });

  it("rejects corrupt progression inputs", () => {
    expect(() => advanceProfile({ level: 0, xp: 0 }, 1)).toThrow();
    expect(() => competitiveMatchXp(-1)).toThrow();
    expect(() => deathmatchMatchXp(1.5)).toThrow();
  });
});
