import { randomUUID } from "node:crypto";
import { createConnection, runMigrations, SERVICE_MEDAL_SEQUENCE, nextServiceMedal, type Sql } from "@aftertick/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceMedalService } from "../src/service-medal-service.js";
import { InventoryService } from "../src/inventory-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;
integration("persistent service medal prestige", () => {
  const schema = `medals_${randomUUID().replaceAll("-", "")}`;
  let admin: Sql;
  let sql: Sql;
  let medals: ServiceMedalService;
  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`create schema "${schema}"`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    sql = createConnection(scoped.toString());
    await runMigrations(sql);
    medals = new ServiceMedalService(sql);
  });
  afterAll(async () => {
    await sql?.end();
    if (admin) { await admin.unsafe(`drop schema "${schema}" cascade`); await admin.end(); }
  });
  async function player(level = 40) {
    const id = randomUUID();
    const steam = `76561198${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    await sql`insert into players(id, steam_id, display_name, profile_level, profile_xp, lifetime_xp)
      values (${id}, ${steam}, ${`Medal ${id}`}, ${level}, 123, 195000)`;
    await sql`insert into player_inventory_snapshots(player_id, status, item_count, refreshed_at, next_refresh_at)
      values (${id}, 'public', 0, now(), now() + interval '5 minutes')`;
    return id;
  }
  it("previews without mutation and rejects early, wrong-year and unknown claims", async () => {
    const id = await player(39);
    const preview = await medals.preview(id);
    expect(preview).toMatchObject({ canRedeem: false, completedPrestiges: 0,
      medal: { year: 2015, tier: 1, definitionIndex: 1331, upgradeAssetId: null } });
    await expect(medals.redeem(id, 1331)).rejects.toMatchObject({ status: 409 });
    await sql`update players set profile_level=40 where id=${id}`;
    await expect(medals.redeem(id, 1339)).rejects.toMatchObject({ status: 409 });
    await expect(medals.redeem(id, 65535)).rejects.toMatchObject({ status: 409 });
    expect((await sql`select * from player_service_medal_redemptions where player_id=${id}`).length).toBe(0);
  });
  it("serializes double redemption, recovers lost receipts, and publishes a real owned medal", async () => {
    const id = await player();
    const results = await Promise.all(Array.from({ length: 4 }, () => medals.redeem(id, 1331)));
    expect(results.filter((result) => !result.alreadyCompleted)).toHaveLength(1);
    expect(new Set(results.map((result) => result.assetId)).size).toBe(1);
    expect(await medals.redeem(id, 1331)).toMatchObject({ alreadyCompleted: true, playerLevel: 1, playerXp: 0 });
    const [profile] = await sql`select service_prestige, profile_level, profile_xp, lifetime_xp from players where id=${id}`;
    expect(profile).toMatchObject({ service_prestige: 1, profile_level: 1, profile_xp: 0, lifetime_xp: 195000n });
    const bundle = await new InventoryService(sql).launcherAccountBundle(id);
    expect(bundle.players[0]!.items).toContainEqual(expect.objectContaining({
      assetId: results[0]!.assetId, definitionIndex: 1331, itemKind: "cosmetic", source: "b2g",
      origin: 24, loadoutSlot: 55
    }));
    expect(await sql`select * from audit_log where actor_id=${id} and action='service_medal.redeemed'`).toHaveLength(1);
  });
  it("cycles years, skips unavailable tiers, upgrades each year's existing asset and stops at exhaustion", async () => {
    const id = await player();
    const assets = new Map<number, string>();
    expect(SERVICE_MEDAL_SEQUENCE).toHaveLength(51);
    expect(nextServiceMedal(9)).toMatchObject({ year: 2015, tier: 2 });
    expect(nextServiceMedal(18)).toMatchObject({ year: 2016, tier: 3 });
    for (const medal of SERVICE_MEDAL_SEQUENCE) {
      await sql`update players set profile_level=40 where id=${id}`;
      const preview = await medals.preview(id);
      expect(preview.medal).toMatchObject(medal);
      expect(preview.medal!.upgradeAssetId).toBe(assets.get(medal.year) ?? null);
      const result = await medals.redeem(id, medal.definitionIndex);
      if (assets.has(medal.year)) expect(result.assetId).toBe(assets.get(medal.year));
      assets.set(medal.year, result.assetId);
      expect(result).toMatchObject({ playerLevel: 1, playerXp: 0, prestige: medal.prestige });
      if (medal.prestige === 1) await new InventoryService(sql).syncLauncherLoadout(id, [result.assetId]);
      if (medal.year === 2015) {
        const bundle = await new InventoryService(sql).launcherAccountBundle(id);
        expect(bundle.players[0]!.items).toContainEqual(expect.objectContaining({
          assetId: result.assetId, definitionIndex: medal.definitionIndex, equipped: true, loadoutSlot: 55
        }));
      }
    }
    expect(await sql`select * from player_b2g_inventory_items where player_id=${id} and weapon_key='service_medal'`).toHaveLength(9);
    expect(await sql`select * from player_service_medal_redemptions where player_id=${id}`).toHaveLength(51);
    await sql`update players set profile_level=40 where id=${id}`;
    expect(await medals.preview(id)).toMatchObject({ canRedeem: false, medal: null, completedPrestiges: 51 });
    await expect(medals.redeem(id, 1)).rejects.toMatchObject({ status: 409 });
    expect((await medals.preview(id)).playerLevel).toBe(40);
  });
  it("rolls back the reset and receipt when the inventory transition cannot be completed", async () => {
    const id = await player();
    await sql`update players set service_prestige=9 where id=${id}`;
    await expect(medals.redeem(id, 1332)).rejects.toMatchObject({ status: 409 });
    expect(await medals.preview(id)).toMatchObject({ playerLevel: 40, completedPrestiges: 9 });
    expect(await sql`select * from player_service_medal_redemptions where player_id=${id}`).toHaveLength(0);
  });
  it("allows level drops again after prestige, but rejects duplicate drops in the same prestige", async () => {
    const id = await player();
    await sql`insert into player_service_drops(player_id, service_level, service_prestige) values (${id}, 2, 0)`;
    await medals.redeem(id, 1331);
    await sql`insert into player_service_drops(player_id, service_level, service_prestige)
      select id, 2, service_prestige from players where id=${id}`;
    await expect(sql`insert into player_service_drops(player_id, service_level, service_prestige)
      values (${id}, 2, 1)`).rejects.toMatchObject({ code: "23505" });
  });
  it("explains full inventory before confirmation and leaves progress intact", async () => {
    const id = await player();
    await sql`insert into player_b2g_inventory_items
      (player_id, asset_id, item_kind, definition_index, weapon_key, display_name, loadout_slot, inventory_position, quality, rarity, origin)
      select ${id}, nextval('b2g_inventory_asset_id_seq')::text, 'cosmetic', 7, 'ak47', 'Capacity fixture', 15, 1, 4, 4, 24
      from generate_series(1,512)`;
    expect(await medals.preview(id)).toMatchObject({ canRedeem: false, failureReason: 2, playerLevel: 40 });
    await expect(medals.redeem(id,1331)).rejects.toMatchObject({ status: 409 });
    expect((await medals.preview(id)).playerLevel).toBe(40);
    expect(await sql`select * from player_service_medal_redemptions where player_id=${id}`).toHaveLength(0);
  });
});
