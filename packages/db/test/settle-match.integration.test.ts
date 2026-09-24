import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, type Sql } from "../src/connection.js";
import { runMigrations } from "../src/migrations.js";
import { settleMatch } from "../src/services/settle-match.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("exactly-once match settlement", () => {
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

  async function createLiveMatch(): Promise<{ matchId: string; playerIds: string[] }> {
    const matchId = randomUUID();
    const playerIds = Array.from({ length: 10 }, () => randomUUID());
    for (let index = 0; index < playerIds.length; index += 1) {
      await sql`
        insert into players (id, steam_id, display_name, rating)
        values (${playerIds[index]!}, ${`7656119${String(index).padStart(10, "0")}`}, ${`Player ${index}`}, 1000)
      `;
    }
    await sql`
      insert into matches (id, map, region, status, started_at)
      values (${matchId}, 'Mirage', 'NA Central', 'live', now())
    `;
    for (let index = 0; index < playerIds.length; index += 1) {
      await sql`
        insert into rosters (match_id, player_id, team, slot, rating_at_match)
        values (
          ${matchId}, ${playerIds[index]!}, ${index < 5 ? "alpha" : "bravo"},
          ${(index % 5) + 1}, 1000
        )
      `;
    }
    return { matchId, playerIds };
  }

  it("applies ratings once across concurrent and repeated settlement", async () => {
    const { matchId, playerIds } = await createLiveMatch();
    const input = { matchId, alphaRounds: 16, bravoRounds: 12 };
    const attempts = await Promise.all([settleMatch(sql, input), settleMatch(sql, input)]);
    expect(attempts[0].changes).toHaveLength(10);
    expect(attempts[0].progression).toHaveLength(10);
    expect(attempts[0].progression.every((entry, index) =>
      entry.earnedXp === (index < 5 ? 480 : 360)
      && entry.previousLevel === 3
      && entry.previousXp === 0
      && entry.nextLevel === 3
      && entry.nextXp === entry.earnedXp
      && entry.xpCategory === 2
    )).toBe(true);
    expect(attempts[1]).toEqual(attempts[0]);

    const repeated = await settleMatch(sql, input);
    expect(repeated).toEqual(attempts[0]);
    const [evidence] = await sql<{
      ledger: number;
      xp_ledger: number;
      total_xp: number;
      plays: number;
      wins: number;
      losses: number;
    }[]>`
      select
        (select count(*)::int from rating_changes where match_id = ${matchId}) as ledger,
        (select count(*)::int from player_xp_ledger where match_id = ${matchId}) as xp_ledger,
        (select sum(lifetime_xp)::int from players where id = any(${playerIds})) as total_xp,
        (select sum(matches_played)::int from players where id = any(${playerIds})) as plays,
        (select sum(wins)::int from players where id = any(${playerIds})) as wins,
        (select sum(losses)::int from players where id = any(${playerIds})) as losses
    `;
    expect(evidence).toEqual({
      ledger: 10,
      xp_ledger: 10,
      total_xp: 4_200,
      plays: 10,
      wins: 5,
      losses: 5
    });
    await expect(settleMatch(sql, { ...input, alphaRounds: 15 })).rejects.toThrow(
      "conflicting score"
    );
  });

  it("completes Deathmatch without changing Competitive Elo", async () => {
    const matchId = randomUUID();
    const playerIds = Array.from({ length: 14 }, () => randomUUID());
    for (let index = 0; index < playerIds.length; index += 1) {
      await sql`
        insert into players (id, steam_id, display_name, rating)
        values (${playerIds[index]!}, ${`7656120${String(index).padStart(10, "0")}`}, ${`DM Player ${index}`}, 1000)
      `;
    }
    await sql`
      insert into matches (
        id, map, region, status, started_at, mode, frag_limit, time_limit_seconds
      ) values (
        ${matchId}, 'Anubis', 'NA Central', 'live', now(), 'deathmatch', 40, 600
      )
    `;
    for (let index = 0; index < playerIds.length; index += 1) {
      await sql`
        insert into rosters (match_id, player_id, team, slot, rating_at_match)
        values (${matchId}, ${playerIds[index]!}, 'ffa', ${index + 1}, 1000)
      `;
    }
    await sql`
      insert into match_stats (match_id, player_id, kills)
      values (${matchId}, ${playerIds[0]!}, 40)
    `;
    await sql`
      update players set profile_xp = 900, service_prestige = 1 where id = ${playerIds[0]!}
    `;
    // The same level was already rewarded before the player's medal reset.
    await sql`insert into player_service_drops (player_id, service_level, service_prestige)
      values (${playerIds[0]!}, 4, 0)`;

    const input = { matchId, alphaRounds: 40, bravoRounds: 37 };
    const first = await settleMatch(sql, input);
    expect(first.changes).toEqual([]);
    expect(first.progression).toEqual([expect.objectContaining({
      playerId: playerIds[0],
      earnedXp: 160,
      previousLevel: 3,
      previousXp: 900,
      nextLevel: 4,
      nextXp: 60,
      xpCategory: 1,
      serviceDrop: expect.objectContaining({
        serviceLevel: 4,
        rewardType: "b2g_service_drop"
      })
    })]);
    expect(await settleMatch(sql, input)).toEqual(first);
    expect(await sql`select service_prestige from player_service_drops where match_id=${matchId}`)
      .toEqual([{ service_prestige: 1 }]);
    const [evidence] = await sql<{
      status: string;
      ledger: number;
      xp_ledger: number;
      service_drops: number;
      drop_items: number;
      total_xp: number;
      plays: number;
      rating_total: number;
    }[]>`
      select match.status::text as status,
             (select count(*)::int from rating_changes where match_id = ${matchId}) as ledger,
             (select count(*)::int from player_xp_ledger where match_id = ${matchId}) as xp_ledger,
             (select count(*)::int from player_service_drops where match_id = ${matchId}) as service_drops,
             ((select count(*)::int from player_b2g_case_grants case_grant
                join player_service_drops reward on reward.id = case_grant.service_drop_id
               where reward.match_id = ${matchId})
              + (select count(*)::int from player_b2g_container_grants container_grant
                join player_service_drops reward on reward.id = container_grant.service_drop_id
               where reward.match_id = ${matchId})
              + (select count(*)::int from player_b2g_direct_reward_grants direct_grant
                join player_service_drops reward on reward.id = direct_grant.service_drop_id
               where reward.match_id = ${matchId})) as drop_items,
             (select sum(lifetime_xp)::int from players where id = any(${playerIds})) as total_xp,
             (select sum(matches_played)::int from players where id = any(${playerIds})) as plays,
             (select sum(rating)::int from players where id = any(${playerIds})) as rating_total
      from matches match where match.id = ${matchId}
    `;
    expect(evidence).toEqual({
      status: "completed",
      ledger: 0,
      xp_ledger: 1,
      service_drops: 1,
      drop_items: 3,
      total_xp: 160,
      plays: 0,
      rating_total: 14_000
    });
  });
});
