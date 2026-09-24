import type { Sql } from "./connection.js";

export const FOUNDERS_SEASON_ID = "00000000-0000-4000-8000-000000000100";

export interface SeedOptions {
  includeTestPlayers?: boolean | undefined;
}

export interface SeedResult {
  seasonId: string;
  testPlayers: number;
}

const TEST_PLAYERS = Array.from({ length: 10 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  steamId: `9000000000000000${index}`,
  displayName: `Aftertick Test ${index + 1}`,
  rating: 950 + index * 10
}));

export async function runSeeds(sql: Sql, options: SeedOptions = {}): Promise<SeedResult> {
  return sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(2483101948)`;
    await transaction`
      insert into seasons (id, name, starts_at, is_active)
      values (
        ${FOUNDERS_SEASON_ID},
        'Founders Season',
        '2026-08-29T00:00:00.000Z'::timestamptz,
        true
      )
      on conflict (id) do update set
        name = excluded.name,
        starts_at = excluded.starts_at
    `;

    if (options.includeTestPlayers) {
      for (const player of TEST_PLAYERS) {
        await transaction`
          insert into players (id, steam_id, display_name, region, rating, ingame_name_set_at)
          values (
            ${player.id},
            ${player.steamId},
            ${player.displayName},
            'NA Central',
            ${player.rating},
            now()
          )
          on conflict (id) do update set
            steam_id = excluded.steam_id,
            display_name = excluded.display_name,
            ingame_name_set_at = coalesce(players.ingame_name_set_at, now()),
            region = excluded.region,
            rating = excluded.rating,
            updated_at = now()
        `;
      }
    }

    return {
      seasonId: FOUNDERS_SEASON_ID,
      testPlayers: options.includeTestPlayers ? TEST_PLAYERS.length : 0
    };
  });
}
