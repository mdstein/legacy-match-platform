import { describe, expect, it } from "vitest";
import {
  participationPenaltyMinutes,
  statTrakAssetForKill,
  validatedAntiCheatSignalPayload
} from "../src/match-ingestion-service.js";

describe("authoritative StatTrak attribution", () => {
  const attackerSteamId = "76561198000000001";
  const victimSteamId = "76561198000000002";
  const equippedItem = {
    assetId: "900000000000000001",
    source: "b2g" as const,
    itemKind: "cosmetic" as const,
    definitionIndex: 7,
    weaponKey: "ak47",
    inventoryPosition: 1,
    paintIndex: 180,
    paintWear: 0.1,
    paintSeed: 10,
    quality: 9,
    rarity: 5,
    origin: 8,
    killEaterScoreType: 0,
    killEaterValue: 4,
    customName: null,
    stickers: [],
    loadoutSlot: 15,
    equipped: true
  };
  const manifest = {
    cosmetics: [{
      playerId: "00000000-0000-4000-8000-000000000001",
      steamId: attackerSteamId,
      items: [equippedItem]
    }]
  };
  const kill = {
    attackerSteamId,
    victimSteamId,
    weapon: "ak47",
    weaponItemId: equippedItem.assetId,
    weaponOriginalOwnerSteamId: attackerSteamId
  };

  it("attributes the exact owned B2G StatTrak item in a signed non-suicide kill", () => {
    expect(statTrakAssetForKill(manifest, kill)).toEqual({
      playerId: manifest.cosmetics[0]!.playerId,
      assetId: equippedItem.assetId
    });
    expect(statTrakAssetForKill(manifest, {
      ...kill,
      victimSteamId: attackerSteamId,
    })).toBeNull();
    expect(statTrakAssetForKill(manifest, {
      ...kill,
      weapon: "awp"
    })).toBeNull();
  });

  it("requires capture-time ownership generations for transferred items", () => {
    const current = { cosmetics: [{ ...manifest.cosmetics[0]!, items: [{ ...equippedItem, ownershipGeneration: "2" }] }] };
    expect(statTrakAssetForKill(current, { ...kill, weaponOwnershipGeneration: "2" }))
      .toEqual({ playerId: manifest.cosmetics[0]!.playerId, assetId: equippedItem.assetId, ownershipGeneration: "2" });
    for (const weaponOwnershipGeneration of [undefined, "0", "1", "3", "-1", "02", 2, "9223372036854775808"]) {
      expect(statTrakAssetForKill(current, { ...kill, weaponOwnershipGeneration })).toBeNull();
    }
  });

  it("normalizes Source weapon names and never changes Steam-owned counters", () => {
    const m4Manifest = {
      cosmetics: [{
        ...manifest.cosmetics[0]!,
        items: [{ ...equippedItem, assetId: "900000000000000002", weaponKey: "m4a4" }]
      }]
    };
    expect(statTrakAssetForKill(m4Manifest, {
      ...kill,
      weapon: "weapon_m4a1",
      weaponItemId: "900000000000000002"
    })?.assetId).toBe("900000000000000002");
    expect(statTrakAssetForKill({
      cosmetics: [{ ...manifest.cosmetics[0]!, items: [{ ...equippedItem, source: "steam" as const }] }]
    }, kill)).toBeNull();
  });

  it("uses the observed asset after team/loadout changes, regardless of item order", () => {
    const secondItem = { ...equippedItem, assetId: "8000000000000001131", equipped: false };
    for (const items of [[equippedItem, secondItem], [secondItem, equippedItem]]) {
      expect(statTrakAssetForKill({
        cosmetics: [{ ...manifest.cosmetics[0]!, items }]
      }, { ...kill, weaponItemId: secondItem.assetId })?.assetId).toBe(secondItem.assetId);
    }
  });

  it("never guesses from a slot when item or original-owner evidence is absent or invalid", () => {
    for (const weaponItemId of [undefined, null, 8000000000000001131, "", "0", "01",
      "-1", "1e18", "8000000000000001131\"", "18446744073709551616", "999999999999999999999"]) {
      expect(statTrakAssetForKill(manifest, { ...kill, weaponItemId })).toBeNull();
    }
    for (const weaponOriginalOwnerSteamId of [undefined, null, "", "0", victimSteamId]) {
      expect(statTrakAssetForKill(manifest, { ...kill, weaponOriginalOwnerSteamId })).toBeNull();
    }
    expect(statTrakAssetForKill(manifest, {
      attackerSteamId, victimSteamId, weapon: "ak47"
    })).toBeNull();
  });

  it("does not credit another player's dropped weapon or an unknown asset", () => {
    const otherItem = { ...equippedItem, assetId: "8000000000000001140" };
    const twoPlayerManifest = {
      cosmetics: [...manifest.cosmetics, {
        playerId: "00000000-0000-4000-8000-000000000002",
        steamId: victimSteamId,
        items: [otherItem]
      }]
    };
    expect(statTrakAssetForKill(twoPlayerManifest, {
      ...kill, weaponItemId: otherItem.assetId, weaponOriginalOwnerSteamId: victimSteamId
    })).toBeNull();
    expect(statTrakAssetForKill(twoPlayerManifest, {
      ...kill, weaponItemId: otherItem.assetId
    })).toBeNull();
    expect(statTrakAssetForKill(manifest, { ...kill, weaponItemId: "8000000000000001141" })).toBeNull();
  });

  it("credits a specific owned knife and preserves the existing DM bot-kill policy", () => {
    const knife = { ...equippedItem, weaponKey: "knife_m9_bayonet", loadoutSlot: 0 };
    const knifeManifest = { cosmetics: [{ ...manifest.cosmetics[0]!, items: [knife] }] };
    for (const weapon of ["knife", "knife_t", "knife_m9_bayonet"]) {
      expect(statTrakAssetForKill(knifeManifest, { ...kill, weapon })?.assetId).toBe(knife.assetId);
    }
    expect(statTrakAssetForKill(manifest, { ...kill, victimSteamId: "" })?.assetId)
      .toBe(equippedItem.assetId);
    expect(statTrakAssetForKill(manifest, { ...kill, victimSteamId: "invalid" })).toBeNull();
  });
});

describe("participation penalty policy", () => {
  it("uses the version-one escalation ladders and caps fifth-plus offenses", () => {
    expect(Array.from({ length: 7 }, (_, index) =>
      participationPenaltyMinutes("no_show", index + 1)
    )).toEqual([15, 60, 360, 1_440, 10_080, 10_080, 10_080]);
    expect(Array.from({ length: 7 }, (_, index) =>
      participationPenaltyMinutes("abandon", index + 1)
    )).toEqual([30, 120, 720, 2_880, 10_080, 10_080, 10_080]);
    expect(() => participationPenaltyMinutes("abandon", 0)).toThrow("positive integer");
  });
});

describe("anti-cheat evidence policy", () => {
  const realSignal = {
    policyVersion: 1,
    steamId: "76561198000000001",
    module: "smac_aimbot.smx",
    detectionType: 100,
    mode: "competitive",
    automaticAction: false,
    synthetic: false
  };

  it("accepts non-punitive detector evidence and the exact synthetic test marker", () => {
    expect(validatedAntiCheatSignalPayload(realSignal)).toEqual({
      steamId: realSignal.steamId,
      mode: "competitive"
    });
    expect(validatedAntiCheatSignalPayload({
      ...realSignal,
      module: "b2g_pipeline_self_test",
      detectionType: 0,
      synthetic: true
    })).toEqual({ steamId: realSignal.steamId, mode: "competitive" });
  });

  it("rejects punitive, malformed, or disguised self-test evidence", () => {
    expect(() => validatedAntiCheatSignalPayload({ ...realSignal, automaticAction: true }))
      .toThrow("malformed");
    expect(() => validatedAntiCheatSignalPayload({ ...realSignal, steamId: "not-steam" }))
      .toThrow("malformed");
    expect(() => validatedAntiCheatSignalPayload({ ...realSignal, module: "b2g_pipeline_self_test" }))
      .toThrow("malformed");
  });
});
