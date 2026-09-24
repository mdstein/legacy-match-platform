import {
  B2G_CASES,
  B2G_DROP_ODDS,
  B2G_PIN_PACKAGES,
  B2G_SERVICE_DROP_ODDS,
  B2G_SOUVENIR_PACKAGES
} from "@aftertick/db";
import {
  caseRewardWear,
  chooseCaseReward,
  chooseContainerReward
} from "../src/inventory-service.js";
import { describe, expect, it } from "vitest";

describe("B2G case odds policy", () => {
  it("uses the disclosed v4 non-special rarity distribution", () => {
    expect(B2G_DROP_ODDS).toMatchObject({
      version: "b2g-cases-v4",
      specialBasisPoints: 500,
      nonSpecialRarityBasisPoints: {
        blue: 5_100,
        purple: 2_500,
        pink: 1_600,
        red: 800
      }
    });
    expect(Object.values(B2G_DROP_ODDS.nonSpecialRarityBasisPoints)
      .reduce((total, weight) => total + weight, 0)).toBe(10_000);
  });

  it("keeps every case reward inside its own final-client loot list", () => {
    for (const caseDefinition of B2G_CASES) {
      expect(caseDefinition.rewards.every((reward) => reward.definitionIndex < 1_000)).toBe(true);
      expect(caseDefinition.specialRewards.every((reward) =>
        reward.definitionIndex >= 500 && reward.rarity === 6
      )).toBe(true);
    }
  });

  it("uses each case's own Valve-schema special pool", () => {
    expect(B2G_CASES).toHaveLength(39);
    for (const caseDefinition of B2G_CASES) {
      expect(caseDefinition.specialRewards.length).toBeGreaterThan(0);
      const selected = chooseCaseReward(caseDefinition, () => 0);
      expect(selected.reward).toEqual(caseDefinition.specialRewards[0]);
      expect(selected.roll).toBe(0);
    }

    const gloveCase = B2G_CASES.find((entry) => entry.internalName === "crate_community_15");
    expect(gloveCase?.specialRewards).toHaveLength(24);
    expect(gloveCase?.specialRewards.every((reward) => reward.loadoutSlot === 41)).toBe(true);
    expect(gloveCase?.specialRewards.every((reward) => reward.definitionIndex >= 1_000)).toBe(true);
    expect(gloveCase?.specialRewards.some((reward) => reward.weaponKey.includes("knife"))).toBe(false);
    expect(chooseCaseReward(gloveCase!, () => 0).statTrak).toBe(false);
  });

  it.each([
    ["crate_community_3", ["knife_tactical"]],
    ["crate_community_4", ["knife_butterfly"]],
    ["crate_community_8", ["knife_falchion"]],
    ["crate_community_9", ["knife_push"]],
    ["crate_community_11", ["knife_survival_bowie"]],
    ["crate_community_15", [
      "leather_handwraps", "motorcycle_gloves", "slick_gloves",
      "specialist_gloves", "sporty_gloves", "studded_bloodhound_gloves"
    ]],
    ["crate_community_20", [
      "knife_gypsy_jackknife", "knife_stiletto", "knife_ursus", "knife_widowmaker"
    ]],
    ["crate_community_23", [
      "knife_canis", "knife_cord", "knife_outdoor", "knife_skeleton"
    ]],
    ["crate_community_24", ["knife_css"]],
    ["crate_community_27", [
      "leather_handwraps", "motorcycle_gloves", "slick_gloves",
      "specialist_gloves", "sporty_gloves", "studded_brokenfang_gloves"
    ]]
  ])("keeps %s on its documented rare-special family", (internalName, expectedWeapons) => {
    const caseDefinition = B2G_CASES.find((entry) => entry.internalName === internalName);
    expect(caseDefinition).toBeDefined();
    expect([...new Set(caseDefinition!.specialRewards.map((reward) => reward.weaponKey))].sort())
      .toEqual(expectedWeapons);
  });

  it("generates every case reward inside its Valve paint-kit wear range", () => {
    for (const caseDefinition of B2G_CASES) {
      for (const reward of [...caseDefinition.rewards, ...caseDefinition.specialRewards]) {
        expect(reward.minWear).toBeGreaterThanOrEqual(0);
        expect(reward.maxWear).toBeLessThanOrEqual(1);
        expect(reward.minWear).toBeLessThanOrEqual(reward.maxWear);
        expect(caseRewardWear(reward, () => 0)).toBe(reward.minWear);
        expect(caseRewardWear(reward, (maximum) => maximum - 1)).toBeCloseTo(reward.maxWear, 8);
      }
    }
  });

  it("inherits the final client's 0.06-0.80 default for glove paint kits", () => {
    const gloveRewards = B2G_CASES.flatMap((caseDefinition) =>
      caseDefinition.specialRewards.filter((reward) => reward.loadoutSlot === 41));
    expect(gloveRewards.length).toBeGreaterThan(0);
    expect(gloveRewards.every((reward) => reward.minWear >= 0.06)).toBe(true);
    expect(gloveRewards.every((reward) => reward.maxWear <= 0.8)).toBe(true);
  });

  it("uses official localized finish and case names", () => {
    const gloveCase = B2G_CASES.find((entry) => entry.internalName === "crate_community_15");
    expect(gloveCase?.displayName).toBe("Glove Case");
    expect(gloveCase?.specialRewards).toContainEqual(expect.objectContaining({
      weaponKey: "motorcycle_gloves",
      paintIndex: 10_026,
      displayName: "Moto Gloves | Spearmint"
    }));
  });
});

describe("B2G reward-container odds policy", () => {
  const sequenceRandom = (...values: number[]) => (maximum: number): number => {
    const value = values.shift();
    if (value === undefined || value < 0 || value >= maximum) {
      throw new Error(`Invalid deterministic random value ${String(value)} for ${maximum}.`);
    }
    return value;
  };

  it("preserves the requested pin odds and defines all six souvenir tiers", () => {
    expect(B2G_SERVICE_DROP_ODDS).toMatchObject({
      version: "b2g-service-drops-v4",
      primaryRewardsPerLevel: 2,
      totalRewardsPerLevel: 3,
      kindBasisPoints: { case: 9_300, pinPackage: 200, souvenirPackage: 500 },
      pinRarityBasisPoints: { blue: 4_000, purple: 3_000, pink: 2_000, red: 1_000 },
      souvenirRarityBasisPoints: {
        consumer: 3_800,
        industrial: 2_500,
        blue: 1_500,
        purple: 1_000,
        pink: 700,
        red: 500
      }
    });
    expect(Object.values(B2G_SERVICE_DROP_ODDS.pinRarityBasisPoints)
      .reduce((total, weight) => total + weight, 0)).toBe(10_000);
    expect(Object.values(B2G_SERVICE_DROP_ODDS.souvenirRarityBasisPoints)
      .reduce((total, weight) => total + weight, 0)).toBe(10_000);
    expect(B2G_SOUVENIR_PACKAGES).toHaveLength(26);
    for (const container of B2G_SOUVENIR_PACKAGES) {
      expect([...new Set(container.rewards.map((reward) => reward.rarity))].sort())
        .toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  it.each([
    [0, 1],
    [3_799, 1],
    [3_800, 2],
    [6_299, 2],
    [6_300, 3],
    [7_799, 3],
    [7_800, 4],
    [8_799, 4],
    [8_800, 5],
    [9_499, 5],
    [9_500, 6],
    [9_999, 6]
  ])("maps souvenir roll %i to rarity %i", (roll, rarity) => {
    const reward = chooseContainerReward(
      B2G_SOUVENIR_PACKAGES[0]!,
      sequenceRandom(roll, 0)
    ).reward;
    expect(reward.rarity).toBe(rarity);
  });

  it.each([
    [0, 3],
    [3_999, 3],
    [4_000, 4],
    [6_999, 4],
    [7_000, 5],
    [8_999, 5],
    [9_000, 6],
    [9_999, 6]
  ])("maps pin roll %i to rarity %i", (roll, rarity) => {
    const reward = chooseContainerReward(
      B2G_PIN_PACKAGES[0]!,
      sequenceRandom(roll, 0)
    ).reward;
    expect(reward.rarity).toBe(rarity);
  });
});
