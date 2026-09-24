import { describe, expect, it } from "vitest";
import { generateHex, generateLink } from "@csfloat/cs2-inspect-serializer";
import { parseCommunityInventoryPage } from "../src/inventory-service.js";

describe("public Steam inventory normalization", () => {
  function knifePage({
    name = "★ Karambit | Gamma Doppler (Factory New)",
    definition = 507,
    paint = 572,
    itemId = 51_000_000_001n,
    statTrak = false,
    appDefinition
  }: {
    name?: string; definition?: number; paint?: number; itemId?: bigint;
    statTrak?: boolean; appDefinition?: number;
  } = {}) {
    return {
      assets: [{ assetid: "51000000001", classid: "100", instanceid: "0" }],
      descriptions: [{
        classid: "100", instanceid: "0", name, market_hash_name: name,
        ...(appDefinition === undefined ? {} : { app_data: { def_index: appDefinition } }),
        actions: [{ link: "steam://run/730//+csgo_econ_action_preview%20%propid:6%" }]
      }],
      asset_properties: [{
        assetid: "51000000001",
        asset_properties: [{ propertyid: 6, string_value: generateHex({
          itemid: itemId, defindex: definition, paintindex: paint,
          paintwear: 0.02451576478779316, paintseed: 205,
          quality: statTrak ? 9 : 3, rarity: 6, inventory: 9, origin: 8,
          ...(statTrak ? { killeaterscoretype: 0, killeatervalue: 147 } : {}),
          stickers: [], keychains: [], variations: []
        }) }]
      }]
    };
  }

  it("imports a property-backed Karambit Gamma Doppler Phase 4 with its exact finish and knife slot", () => {
    expect(parseCommunityInventoryPage(knifePage())).toEqual([expect.objectContaining({
      assetId: "51000000001", definitionIndex: 507, weaponKey: "knife_karambit",
      paintIndex: 572, paintWear: expect.closeTo(0.02451576478779316), paintSeed: 205,
      loadoutSlot: 0, quality: 3, killEaterValue: null
    })]);
  });

  it("recognizes the star and StatTrak prefix without changing the imported counter", () => {
    const items = parseCommunityInventoryPage(knifePage({
      name: "★ StatTrak™ M9 Bayonet | Gamma Doppler (Factory New)",
      definition: 508, statTrak: true
    }));
    expect(items).toEqual([expect.objectContaining({
      definitionIndex: 508, weaponKey: "knife_m9_bayonet", paintIndex: 572,
      loadoutSlot: 0, quality: 9, killEaterScoreType: 0, killEaterValue: 147
    })]);
  });

  it("imports unpainted knives and uses the Steam definition when provided", () => {
    expect(parseCommunityInventoryPage(knifePage({ name: "★ Karambit", paint: 0 })))
      .toEqual([expect.objectContaining({ definitionIndex: 507, paintIndex: 0, loadoutSlot: 0 })]);
    expect(parseCommunityInventoryPage(knifePage({ name: "Localized knife name", appDefinition: 507 })))
      .toEqual([expect.objectContaining({ definitionIndex: 507, weaponKey: "knife_karambit" })]);
  });

  it.each([
    { itemId: 51_000_000_002n },
    { definition: 508 },
    { paint: 4_000_000_000 },
    { name: "★ Kukri Knife | Gamma Doppler (Factory New)", definition: 526, appDefinition: 526 }
  ])("rejects unowned, mismatched, or unsupported knife metadata: %o", (input) => {
    expect(parseCommunityInventoryPage(knifePage(input))).toEqual([]);
  });

  it("imports supported firearms and binds each row to its Steam asset ID", () => {
    const items = parseCommunityInventoryPage({
      success: 1,
      assets: [{ assetid: "50286157940", classid: "10", instanceid: "0" }],
      descriptions: [{
        classid: "10",
        instanceid: "0",
        name: "AK-47 | Redline",
        market_hash_name: "AK-47 | Redline (Field-Tested)",
        icon_url: "abc/DEF_123",
        tradable: 1,
        marketable: 1,
        actions: [{ link: generateLink({
          itemid: 50286157940n,
          defindex: 7,
          paintindex: 282,
          paintwear: 0.22740158438682556,
          paintseed: 49,
          rarity: 5,
          quality: 4,
          inventory: 11,
          origin: 8,
          stickers: [],
          keychains: [],
          variations: []
        }) }],
        app_data: { def_index: "7" }
      }]
    });

    expect(items).toEqual([expect.objectContaining({
      assetId: "50286157940",
      definitionIndex: 7,
      weaponKey: "ak47",
      displayName: "AK-47 | Redline",
      paintIndex: 282,
      paintSeed: 49,
      paintWear: expect.closeTo(0.22740158438682556)
    })]);
  });

  it("imports Steam's property-backed inspect certificates", () => {
    const itemId = 52_618_066_533n;
    const certificate = generateHex({
      itemid: itemId,
      defindex: 4,
      paintindex: 479,
      paintwear: 0.7867094278335571,
      paintseed: 620,
      rarity: 3,
      quality: 9,
      inventory: 8,
      origin: 4,
      stickers: [],
      keychains: [],
      variations: []
    });
    const items = parseCommunityInventoryPage({
      success: 1,
      assets: [{ assetid: itemId.toString(), classid: "7993038191", instanceid: "188530721" }],
      descriptions: [{
        classid: "7993038191",
        instanceid: "188530721",
        name: "StatTrak™ Glock-18 | Bunsen Burner",
        market_hash_name: "StatTrak™ Glock-18 | Bunsen Burner (Battle-Scarred)",
        actions: [{ link: "steam://run/730//+csgo_econ_action_preview%20%propid:6%" }]
      }],
      asset_properties: [{
        assetid: itemId.toString(),
        asset_properties: [{ propertyid: 6, string_value: certificate }]
      }]
    });

    expect(items).toEqual([expect.objectContaining({
      assetId: itemId.toString(),
      definitionIndex: 4,
      weaponKey: "glock",
      paintIndex: 479,
      paintSeed: 620,
      paintWear: expect.closeTo(0.7867094278335571)
    })]);
  });

  it("drops unsupported, malformed, and attacker-controlled image records", () => {
    const items = parseCommunityInventoryPage({
      assets: [
        { assetid: "50286157940", classid: "11", instanceid: "0" },
        { assetid: "2;quit", classid: "12", instanceid: "0" }
      ],
      descriptions: [{
        classid: "11",
        instanceid: "0",
        name: "AK-47 | Safe",
        market_hash_name: "AK-47 | Safe (Factory New)",
        icon_url: "https://attacker.invalid/pixel",
        actions: [{ link: generateLink({
          itemid: 50286157940n,
          defindex: 7,
          paintindex: 282,
          paintwear: 0.01,
          paintseed: 1,
          rarity: 5,
          quality: 4,
          inventory: 1,
          origin: 8,
          stickers: [],
          keychains: [],
          variations: []
        }) }],
        app_data: { def_index: 7 }
      }]
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.iconPath).toBeNull();
  });

  it("rejects metadata whose inspect identity or paint kit is not in the legacy client", () => {
    const items = parseCommunityInventoryPage({
      assets: [{ assetid: "42", classid: "12", instanceid: "0" }],
      descriptions: [{
        classid: "12",
        instanceid: "0",
        name: "AK-47 | Future",
        market_hash_name: "AK-47 | Future (Factory New)",
        actions: [{ link: generateLink({
          itemid: 42n,
          defindex: 7,
          paintindex: 4_000_000_000,
          paintwear: 0.01,
          paintseed: 1,
          rarity: 5,
          quality: 4,
          inventory: 1,
          origin: 8,
          stickers: [],
          keychains: [],
          variations: []
        }) }],
        app_data: { def_index: 7 }
      }]
    });

    expect(items).toEqual([]);
  });
});
