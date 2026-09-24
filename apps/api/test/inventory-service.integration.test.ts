import { randomUUID } from "node:crypto";
import { generateHex } from "@csfloat/cs2-inspect-serializer";
import { B2G_CASES, B2G_DROP_ODDS, B2G_PIN_PACKAGES, B2G_SOUVENIR_PACKAGES, B2G_SERVICE_DROP_ODDS, createConnection, runMigrations, type Sql } from "@aftertick/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InventoryService } from "../src/inventory-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("launcher-owned inventory grants", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  let admin!: Sql;
  let sql!: Sql;

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it.each([
    { definition: 4, weaponKey: "glock", paint: 479, wear: 0.7867094278335571, slot: 2,
      name: "StatTrak™ Glock-18 | Bunsen Burner (Battle-Scarred)", quality: 9 },
    { definition: 507, weaponKey: "knife_karambit", paint: 572, wear: 0.02451576478779316, slot: 0,
      name: "★ Karambit | Gamma Doppler (Factory New)", quality: 3 }
  ])("imports and equips an exact Steam $weaponKey before manifest creation", async ({ definition, weaponKey, paint, wear, slot, name, quality }) => {
    const playerId = randomUUID();
    const steamId = (76561198000100000n + BigInt(definition)).toString();
    const assetId = "52618066533";
    const certificate = generateHex({
      itemid: BigInt(assetId),
      defindex: definition,
      paintindex: paint,
      paintwear: wear,
      paintseed: 620,
      rarity: 3,
      quality,
      inventory: 8,
      origin: 4,
      stickers: [],
      keychains: [],
      variations: []
    });
    await sql`
      insert into players (id, steam_id, display_name)
      values (${playerId}, ${steamId}, 'Automatic Inventory Tester')
    `;
    const fetchInventory = (async () => new Response(JSON.stringify({
      success: 1,
      total_inventory_count: 1,
      assets: [{ assetid: assetId, classid: "7993038191", instanceid: "188530721" }],
      descriptions: [{
        classid: "7993038191",
        instanceid: "188530721",
        name,
        market_hash_name: name,
        actions: [{ link: "steam://run/730//+csgo_econ_action_preview%20%propid:6%" }]
      }],
      asset_properties: [{
        assetid: assetId,
        asset_properties: [{ propertyid: 6, string_value: certificate }]
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;
    const service = new InventoryService(sql, fetchInventory);

    const beforeRevision = (await sql<{ value: number }[]>`select b2g_inventory_revision::int as value from players where id = ${playerId}`)[0]!.value;
    await service.ensureFreshForPlayers([playerId]);
    const afterRevision = (await sql<{ value: number }[]>`select b2g_inventory_revision::int as value from players where id = ${playerId}`)[0]!.value;
    expect(afterRevision).toBeGreaterThan(beforeRevision);

    await expect(service.view(playerId)).resolves.toMatchObject({
      status: "public",
      itemCount: 1,
      items: [expect.objectContaining({ assetId, weaponKey, paintIndex: paint, loadoutSlot: slot })]
    });
    await expect(service.launcherAccountBundle(playerId)).resolves.toMatchObject({
      version: 1,
      inventoryVersion: expect.any(Number),
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      players: [{
        playerId,
        steamId,
        items: expect.arrayContaining([
          expect.objectContaining({ assetId, weaponKey, paintIndex: paint, loadoutSlot: slot })
        ])
      }]
    });

    await service.saveLoadout(playerId, [{ weaponKey, assetId }]);
    const equipped = (await service.launcherAccountBundle(playerId)).players[0]?.items.find(item => item.assetId === assetId);
    expect(equipped).toMatchObject({ definitionIndex: definition, loadoutSlot: slot, equipped: true,
      paintIndex: paint, paintWear: expect.closeTo(wear), paintSeed: 620 });

    for (const status of ["private", "unavailable", "public"]) {
      await sql`
        update player_inventory_snapshots
        set status = ${status}, refreshed_at = now() - interval '7 days',
            next_refresh_at = now() + interval '1 hour'
        where player_id = ${playerId}
      `;
      const restricted = await service.launcherAccountBundle(playerId);
      expect(restricted.players[0]?.steamId).toBe(steamId);
      expect(restricted.players[0]?.items.some((item) => item.source === "steam")).toBe(false);
      expect(Date.parse(restricted.expiresAt)).toBeGreaterThan(Date.now() + 60_000);
      await expect(service.saveLoadout(playerId, [{ weaponKey, assetId }]))
        .rejects.toMatchObject({ status: 409 });
    }
  });

  it.each([200, 403, 404, 502])("allows first launch with an empty or unreadable Steam inventory (HTTP %i)", async (status) => {
    const playerId = randomUUID();
    const steamId = (76561198000000300n + BigInt(status)).toString();
    await sql`
      insert into players (id, steam_id, display_name)
      values (${playerId}, ${steamId}, ${`New Inventory Tester ${status}`})
    `;
    const service = new InventoryService(sql, (async () => new Response(
      JSON.stringify({ success: 1, assets: [], descriptions: [] }),
      { status, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch);
    const bundle = await service.launcherAccountBundle(playerId);
    expect(bundle.players).toHaveLength(1);
    expect(bundle.players[0]).toMatchObject({ playerId, steamId });
    expect(bundle.players[0]!.items.every((item) => item.source === "b2g")).toBe(true);
    expect(Date.parse(bundle.expiresAt)).toBeGreaterThan(Date.now() + 60_000);
  });

  it("persists Panorama positions without triggering full-inventory refresh churn", async () => {
    const playerId = randomUUID();
    const assetId = "8000000000000000990";
    await sql`
      insert into players (id, steam_id, display_name)
      values (${playerId}, '76561198000000009', 'Position Tester')
    `;
    await sql`
      insert into player_b2g_inventory_items (
        player_id, asset_id, item_kind, definition_index, weapon_key,
        display_name, inventory_position, quality, rarity, origin, loadout_slot
      ) values (
        ${playerId}, ${assetId}, 'cosmetic', 7, 'ak47',
        'AK-47 | Test', 1073741900, 4, 3, 8, 15
      )
    `;
    const service = new InventoryService(sql);
    const revision = async () => (await sql<{ value: number }[]>`
      select b2g_inventory_revision::int as value from players where id = ${playerId}
    `)[0]!.value;
    const initialRevision = await revision();

    await service.acknowledgeB2GItems(playerId, [{ assetId, position: 1900 }]);
    expect(await revision()).toBe(initialRevision);
    await service.acknowledgeB2GItems(playerId, [{ assetId, position: 1900 }]);
    expect(await revision()).toBe(initialRevision);

    const [item] = await sql<{ inventory_position: number }[]>`
      select inventory_position::int as inventory_position
      from player_b2g_inventory_items where player_id = ${playerId} and asset_id = ${assetId}
    `;
    expect(item?.inventory_position).toBe(1900);
  });

  it("redeems a live bearer grant against a real PostgreSQL lease transaction", async () => {
    const playerId = randomUUID();
    const matchId = randomUUID();
    const nodeId = randomUUID();
    const instanceId = randomUUID();
    await sql`
      insert into players (id, steam_id, display_name)
      values (${playerId}, '76561198000000001', 'Inventory Tester')
    `;
    await sql`
      insert into matches (id, map, region, status)
      values (${matchId}, 'de_dust2', 'NA Central', 'live')
    `;
    await sql`
      insert into game_nodes (id, name, region, token_sha256, status)
      values (${nodeId}, ${`inventory-node-${nodeId}`}, 'NA Central', ${"a".repeat(64)}, 'active')
    `;
    await sql`
      insert into server_instances (
        id, node_id, instance_key, state, address, game_port
      ) values (
        ${instanceId}, ${nodeId}, 'inventory-01', 'leased', '127.0.0.1:27115', 27115
      )
    `;
    const manifest = {
      cosmetics: [{
        playerId,
        steamId: "76561198000000001",
        items: []
      }]
    };
    await sql`
      insert into server_leases (
        match_id, server_instance_id, manifest, manifest_signature, expires_at
      ) values (
        ${matchId}, ${instanceId}, ${sql.json(manifest)}, ${"b".repeat(64)}, now() + interval '1 hour'
      )
    `;

    const service = new InventoryService(sql);
    const grant = await service.issueLauncherGrant(matchId);
    const bundle = await service.launcherBundle(grant.id, grant.token);

    expect(bundle).toMatchObject({
      version: 1,
      matchId,
      players: manifest.cosmetics
    });
    expect(bundle.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
    const [stored] = await sql<{ redemption_count: number }[]>`
      select redemption_count
      from launcher_inventory_grants
      where id = ${grant.id}
    `;
    expect(stored?.redemption_count).toBe(1);
    await expect(service.launcherBundle(grant.id, "0".repeat(64))).rejects.toMatchObject({
      status: 401,
      message: "Invalid launcher inventory grant."
    });
  });

  it.each([
    ["b2g-service-drops-v3", "pin_package", B2G_PIN_PACKAGES[0]!],
    ["b2g-service-drops-v3", "souvenir_package", B2G_SOUVENIR_PACKAGES[0]!],
    [B2G_SERVICE_DROP_ODDS.version, "pin_package", B2G_PIN_PACKAGES[0]!],
    [B2G_SERVICE_DROP_ODDS.version, "souvenir_package", B2G_SOUVENIR_PACKAGES[0]!]
  ] as const)("opens and replays %s %s after the level-up odds change", async (version, kind, container) => {
    const playerId = randomUUID();
    const grantId = randomUUID();
    const allocated = await sql<{ asset_id: string }[]>`
      select nextval('b2g_inventory_asset_id_seq')::text as asset_id
    `;
    const assetId = allocated[0]!.asset_id;
    const steamId = (BigInt(assetId) - 8_000_000_000_000_000_000n + 76_561_198_000_001_000n).toString();
    await sql`insert into players (id, steam_id, display_name) values (${playerId}, ${steamId}, 'Container Compatibility Tester')`;
    await sql`
      insert into player_b2g_container_grants (
        id, player_id, grant_type, batch_id, container_type,
        container_definition_index, container_asset_id, odds_version
      ) values (
        ${grantId}, ${playerId}, 'admin', ${randomUUID()}, ${kind},
        ${container.definitionIndex}, ${assetId!}, ${version}
      )
    `;
    await sql`
      insert into player_b2g_inventory_items (
        player_id, asset_id, container_grant_id, item_kind, definition_index,
        weapon_key, display_name, inventory_position, quality, rarity, origin, loadout_slot
      ) values (
        ${playerId}, ${assetId}, ${grantId}, 'case', ${container.definitionIndex},
        ${`b2g_${kind}`}, ${container.displayName}, 1073741842, 4, 1, 24, 0
      )
    `;
    const service = new InventoryService(sql);
    const opened = await service.openB2GCase(playerId, assetId!, "0");
    const retries = await Promise.all([
      service.openB2GCase(playerId, assetId!, "0"),
      service.openB2GCase(playerId, assetId!, "0")
    ]);
    expect(opened).toMatchObject({ alreadyOpened: false, oddsVersion: version });
    for (const retry of retries) {
      expect(retry).toMatchObject({ alreadyOpened: true, oddsVersion: version, item: { assetId: opened.item.assetId } });
    }
    const [count] = await sql<{ count: number }[]>`
      select count(*)::int as count from player_b2g_inventory_items
      where player_id = ${playerId} and item_kind = 'cosmetic' and state = 'active'
    `;
    expect(count?.count).toBe(1);
  });

  it("atomically opens keyless B2G cases with hidden fungible entitlements", async () => {
    const playerId = randomUUID();
    const otherPlayerId = randomUUID();
    const caseGrantId = randomUUID();
    const secondCaseGrantId = randomUUID();
    const batchId = randomUUID();
    const caseAssetId = "8000000000000000100";
    const keyAssetId = "8000000000000000101";
    const secondCaseAssetId = "8000000000000000102";
    const secondKeyAssetId = "8000000000000000103";
    const droppedCase = B2G_CASES[0]!;
    await sql`
      insert into players (id, steam_id, display_name)
      values
        (${playerId}, '76561198000000003', 'Case Tester'),
        (${otherPlayerId}, '76561198000000004', 'Case Thief')
    `;
    await sql`
      insert into player_inventory_snapshots (
        player_id, status, item_count, refreshed_at, next_refresh_at
      ) values (${playerId}, 'public', 0, now(), now() + interval '5 minutes')
    `;
    await sql`
      insert into player_b2g_case_grants (
        id, player_id, grant_type, batch_id,
        case_definition_index, key_definition_index,
        case_asset_id, key_asset_id, odds_version
      ) values
      (
        ${caseGrantId}, ${playerId}, 'admin', ${batchId},
        ${droppedCase.definitionIndex}, ${droppedCase.keyDefinitionIndex},
        ${caseAssetId}, ${keyAssetId}, ${B2G_DROP_ODDS.version}
      ),
      (
        ${secondCaseGrantId}, ${playerId}, 'admin', ${batchId},
        ${droppedCase.definitionIndex}, ${droppedCase.keyDefinitionIndex},
        ${secondCaseAssetId}, ${secondKeyAssetId}, ${B2G_DROP_ODDS.version}
      )
    `;
    await sql`
      insert into player_b2g_inventory_items (
        player_id, asset_id, case_grant_id, item_kind, definition_index,
        weapon_key, display_name, inventory_position, quality, rarity, origin, loadout_slot
      ) values
        (${playerId}, ${caseAssetId}, ${caseGrantId}, 'case', ${droppedCase.definitionIndex},
         'b2g_case', ${droppedCase.displayName}, 1073741842, 4, 1, 24, 0),
        (${playerId}, ${keyAssetId}, ${caseGrantId}, 'key', ${droppedCase.keyDefinitionIndex},
         'b2g_key', 'B2G Case Key', 1, 4, 1, 24, 0),
        (${playerId}, ${secondCaseAssetId}, ${secondCaseGrantId}, 'case', ${droppedCase.definitionIndex},
         'b2g_case', ${droppedCase.displayName}, 1073741844, 4, 1, 24, 0),
        (${playerId}, ${secondKeyAssetId}, ${secondCaseGrantId}, 'key', ${droppedCase.keyDefinitionIndex},
         'b2g_key', 'B2G Case Key', 2, 4, 1, 24, 0)
    `;

    const service = new InventoryService(sql);
    await expect(service.openB2GCase(otherPlayerId, caseAssetId)).rejects.toMatchObject({
      status: 404,
      message: "That B2G case and virtual key are not available."
    });
    await expect(sql`
      insert into player_cosmetic_loadouts (player_id, weapon_key, asset_id)
      values (${playerId}, 'b2g_case', ${caseAssetId})
    `).rejects.toMatchObject({ code: "23503" });
    const unopened = await service.launcherAccountBundle(playerId);
    const unopenedVersion = unopened.inventoryVersion!;
    expect(unopened.players[0]?.items.map((item) => item.itemKind).sort()).toEqual(["case", "case", "cosmetic"]);
    expect(unopened.players[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ definitionIndex: 1200, weaponKey: "b2g_name_tag" })
    ]));
    const first = await service.openB2GCase(playerId, caseAssetId, secondKeyAssetId);
    const [retry, concurrentRetry] = await Promise.all([
      service.openB2GCase(playerId, caseAssetId),
      service.openB2GCase(playerId, caseAssetId)
    ]);
    expect(first.item.assetId).toBe(retry.item.assetId);
    expect(first.item.assetId).toBe(concurrentRetry.item.assetId);
    expect(first.alreadyOpened).toBe(false);
    expect(retry.alreadyOpened).toBe(true);
    expect(concurrentRetry.alreadyOpened).toBe(true);
    expect(first.item).toMatchObject({ source: "b2g", itemKind: "cosmetic", origin: 8 });

    const second = await service.openB2GCase(playerId, secondCaseAssetId);
    expect(second.alreadyOpened).toBe(false);
    const bundle = await service.launcherAccountBundle(playerId);
    expect(bundle.inventoryVersion).toBeGreaterThan(unopenedVersion);
    expect(bundle.players[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId: first.item.assetId,
        source: "b2g",
        itemKind: "cosmetic"
      }),
      expect.objectContaining({
        assetId: second.item.assetId,
        source: "b2g",
        itemKind: "cosmetic"
      })
    ]));
    expect(bundle.players[0]?.items).toHaveLength(3);
    const states = await sql<{ item_kind: string; state: string; count: number }[]>`
      select item_kind, state, count(*)::int as count from player_b2g_inventory_items
      where player_id = ${playerId} group by item_kind, state order by item_kind, state
    `;
    expect(states).toEqual([
      { item_kind: "case", state: "consumed", count: 2 },
      { item_kind: "cosmetic", state: "active", count: 3 },
      { item_kind: "key", state: "consumed", count: 2 }
    ]);
    await sql`
      insert into player_cosmetic_loadouts (player_id, weapon_key, asset_id)
      values (${playerId}, ${first.item.weaponKey}, ${first.item.assetId})
    `;
    await sql`
      update player_b2g_inventory_items
      set state = 'consumed', consumed_at = now()
      where player_id = ${playerId} and asset_id = ${first.item.assetId}
    `;
    const [loadoutCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from player_cosmetic_loadouts
      where player_id = ${playerId} and asset_id = ${first.item.assetId}
    `;
    expect(loadoutCount?.count).toBe(0);
  });

  it("atomically consumes ten B2G cosmetics in an authoritative Trade Up Contract", async () => {
    const playerId = randomUUID();
    const otherPlayerId = randomUUID();
    const collection = B2G_CASES.find((entry) =>
      entry.rewards.some((reward) => reward.rarity === 3)
      && entry.rewards.some((reward) => reward.rarity === 4)
    )!;
    const input = collection.rewards.find((reward) => reward.rarity === 3)!;
    const inputAssetIds = Array.from(
      { length: 10 },
      (_, index) => (8_000_000_000_000_003_000n + BigInt(index)).toString()
    );
    await sql`
      insert into players (id, steam_id, display_name)
      values
        (${playerId}, '76561198000000005', 'Trade Up Tester'),
        (${otherPlayerId}, '76561198000000006', 'Trade Up Thief')
    `;
    for (const [index, assetId] of inputAssetIds.entries()) {
      await sql`
        insert into player_b2g_inventory_items (
          player_id, asset_id, item_kind, definition_index, weapon_key,
          display_name, inventory_position, paint_index, paint_wear, paint_seed,
          quality, rarity, origin, loadout_slot, collection_definition_index
        ) values (
          ${playerId}, ${assetId}, 'cosmetic', ${input.definitionIndex}, ${input.weaponKey},
          ${input.displayName}, ${1_073_743_000 + index}, ${input.paintIndex}, ${0.05 + index / 100},
          ${index + 1}, 4, 3, 8, ${input.loadoutSlot}, ${collection.definitionIndex}
        )
      `;
    }

    const service = new InventoryService(sql);
    await expect(service.tradeUpB2G(otherPlayerId, inputAssetIds)).rejects.toMatchObject({
      status: 409
    });
    const traded = await service.tradeUpB2G(playerId, [...inputAssetIds].reverse());
    expect(traded.alreadyCompleted).toBe(false);
    expect(traded.inputAssetIds).toEqual(inputAssetIds);
    expect(traded.recipeIndex).toBe(2);
    expect(traded.item).toMatchObject({
      source: "b2g",
      itemKind: "cosmetic",
      rarity: 4,
      quality: 4,
      origin: 8
    });
    expect(collection.rewards.some((reward) =>
      reward.rarity === 4
      && reward.definitionIndex === traded.item.definitionIndex
      && reward.paintIndex === traded.item.paintIndex
    )).toBe(true);

    const retry = await service.tradeUpB2G(playerId, inputAssetIds);
    expect(retry.alreadyCompleted).toBe(true);
    expect(retry.item.assetId).toBe(traded.item.assetId);
    const states = await sql<{ state: string; count: number }[]>`
      select state, count(*)::int as count
      from player_b2g_inventory_items
      where player_id = ${playerId}
      group by state order by state
    `;
    expect(states).toEqual([
      { state: "active", count: 1 },
      { state: "consumed", count: 10 }
    ]);
    const [audit] = await sql<{
      input_asset_ids: string[];
      result_asset_id: string;
      input_rarity: number;
      output_rarity: number;
    }[]>`
      select input_asset_ids, result_asset_id, input_rarity, output_rarity
      from player_b2g_trade_ups where player_id = ${playerId}
    `;
    expect(audit).toMatchObject({
      input_asset_ids: inputAssetIds,
      result_asset_id: traded.item.assetId,
      input_rarity: 3,
      output_rarity: 4
    });
  });
});
