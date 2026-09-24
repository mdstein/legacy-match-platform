import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, type Sql } from "../src/connection.js";
import { runMigrations } from "../src/migrations.js";
import { FOUNDERS_SEASON_ID, runSeeds } from "../src/seeds.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("database migrations", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: Sql;
  let sql: Sql;

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it("applies the schema transactionally and is repeatable", async () => {
    const first = await runMigrations(sql);
    expect(first.applied).toEqual([
      "001_initial_schema",
      "002_server_control_plane",
      "003_match_ingestion",
      "004_node_command_retries",
      "005_demo_artifacts",
      "006_demo_analysis_failures",
      "007_platform_operations",
      "008_data_retention",
      "009_match_recovery",
      "010_latency_probes",
      "011_map_veto",
      "012_srcds_failure_recovery",
      "013_participation_penalties",
      "014_product_accounts_and_modes",
      "016_drop_in_deathmatch",
      "017_owned_cosmetic_loadouts",
      "018_owned_native_inventory",
      "019_launcher_device_authorization",
      "020_player_profile_progression",
      "021_player_service_drops",
      "022_b2g_case_inventory",
      "023_b2g_trade_ups",
      "024_case_specific_special_rewards",
      "025_service_reward_containers",
      "026_service_graffiti_and_drop_announcements",
      "027_souvenir_full_rarity_odds",
      "028_inventory_position_revision_stability",
      "029_case_catalog_wear_inheritance",
      "030_live_inventory_sync",
      "031_service_medal_prestige",
      "032_player_trading",
      "033_profile_xp_1000",
      "034_player_friends"
    ]);

    const second = await runMigrations(sql);
    expect(second.applied).toEqual([]);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schema}
      ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      "audit_log",
      "b2g_trade_events",
      "b2g_trade_items",
      "b2g_trade_offers",
      "b2g_trade_requests",
      "b2g_trade_versions",
      "b2g_trading_profiles",
      "game_nodes",
      "latency_probe_challenges",
      "launcher_credentials",
      "launcher_device_authorizations",
      "launcher_inventory_grants",
      "match_demo_artifacts",
      "match_demo_conflicts",
      "match_event_conflicts",
      "match_events",
      "match_map_veto_actions",
      "match_participation_violations",
      "match_player_presence",
      "match_recovery_incidents",
      "match_result_conflicts",
      "match_results",
      "match_stats",
      "matches",
      "node_commands",
      "platform_controls",
      "player_b2g_case_grants",
      "player_b2g_container_grants",
      "player_b2g_direct_reward_grants",
      "player_b2g_inventory_items",
      "player_b2g_trade_ups",
      "player_cosmetic_loadouts",
      "player_friendships",
      "player_inventory_items",
      "player_inventory_snapshots",
      "player_latency_measurements",
      "player_service_drops",
      "player_service_medal_redemptions",
      "player_service_medals",
      "player_xp_conversion_1000",
      "player_xp_ledger",
      "players",
      "rating_changes",
      "reports",
      "rosters",
      "sanction_appeals",
      "sanctions",
      "schema_migrations",
      "seasons",
      "server_instances",
      "server_leases"
    ]);

    const records = await sql<{ version: string; checksum: string }[]>`
      SELECT version, checksum FROM schema_migrations ORDER BY version
    `;
    expect(records.map((migration) => migration.version)).toEqual([
      "001_initial_schema",
      "002_server_control_plane",
      "003_match_ingestion",
      "004_node_command_retries",
      "005_demo_artifacts",
      "006_demo_analysis_failures",
      "007_platform_operations",
      "008_data_retention",
      "009_match_recovery",
      "010_latency_probes",
      "011_map_veto",
      "012_srcds_failure_recovery",
      "013_participation_penalties",
      "014_product_accounts_and_modes",
      "016_drop_in_deathmatch",
      "017_owned_cosmetic_loadouts",
      "018_owned_native_inventory",
      "019_launcher_device_authorization",
      "020_player_profile_progression",
      "021_player_service_drops",
      "022_b2g_case_inventory",
      "023_b2g_trade_ups",
      "024_case_specific_special_rewards",
      "025_service_reward_containers",
      "026_service_graffiti_and_drop_announcements",
      "027_souvenir_full_rarity_odds",
      "028_inventory_position_revision_stability",
      "029_case_catalog_wear_inheritance",
      "030_live_inventory_sync",
      "031_service_medal_prestige",
      "032_player_trading",
      "033_profile_xp_1000",
      "034_player_friends"
    ]);
    expect(records.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum))).toBe(true);

    const [recoveryReasonConstraint] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class relation on relation.oid = c.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = ${schema}
        and relation.relname = 'match_recovery_incidents'
        and c.conname = 'match_recovery_incidents_reason_check'
    `;
    expect(recoveryReasonConstraint?.definition).toContain("server_lease_expired");
    expect(recoveryReasonConstraint?.definition).toContain("srcds_unreachable");
  });

  it("enforces immutable audit records and initializes safe platform controls", async () => {
    await runMigrations(sql);
    const [controls] = await sql<{
      registration_enabled: boolean;
      queue_enabled: boolean;
      server_allocation_enabled: boolean;
      version: number;
    }[]>`select registration_enabled, queue_enabled, server_allocation_enabled, version::int from platform_controls`;
    expect(controls).toEqual({
      registration_enabled: true,
      queue_enabled: true,
      server_allocation_enabled: true,
      version: 1
    });

    const [audit] = await sql<{ id: string }[]>`
      insert into audit_log (action, target_type, detail)
      values ('test.append', 'migration', '{}') returning id
    `;
    await expect(sql`update audit_log set action = 'test.changed' where id = ${audit!.id}`)
      .rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_log where id = ${audit!.id}`)
      .rejects.toThrow(/append-only/);
  });

  it("seeds the founders season and optional test roster idempotently", async () => {
    await runMigrations(sql);
    const first = await runSeeds(sql, { includeTestPlayers: true });
    const second = await runSeeds(sql, { includeTestPlayers: true });

    expect(first).toEqual({ seasonId: FOUNDERS_SEASON_ID, testPlayers: 10 });
    expect(second).toEqual(first);

    const [season] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from seasons
      where id = ${FOUNDERS_SEASON_ID} and is_active = true
    `;
    const [players] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from players
      where steam_id like '9000000000000000%'
    `;
    expect(season?.count).toBe(1);
    expect(players?.count).toBe(10);
  });
});
