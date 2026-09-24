import type { Sql } from "../connection.js";

export interface RatingChangeRow {
  id: string;
  player_id: string;
  match_id: string;
  idempotency_key: string;
  previous_rating: number;
  next_rating: number;
  delta: number;
  outcome: "win" | "loss" | "draw";
  expected_win_prob: number;
  component_result: number;
  component_round_margin: number;
  component_performance: number;
  component_placement: number;
  engine_version: string;
  settled_at: Date;
}

export interface SettleRatingInput {
  playerId: string;
  matchId: string;
  previousRating: number;
  nextRating: number;
  delta: number;
  outcome: "win" | "loss" | "draw";
  expectedWinProb: number;
  components: {
    result: number;
    roundMargin: number;
    performance: number;
    placementMultiplier: number;
  };
  engineVersion: string;
}

export function ratingLedgerRepository(sql: Sql) {
  return {
    async settle(entries: SettleRatingInput[]): Promise<RatingChangeRow[]> {
      const values = entries.map((e) => ({
        player_id: e.playerId,
        match_id: e.matchId,
        idempotency_key: `${e.matchId}:${e.playerId}`,
        previous_rating: e.previousRating,
        next_rating: e.nextRating,
        delta: e.delta,
        outcome: e.outcome,
        expected_win_prob: e.expectedWinProb,
        component_result: e.components.result,
        component_round_margin: e.components.roundMargin,
        component_performance: e.components.performance,
        component_placement: e.components.placementMultiplier,
        engine_version: e.engineVersion
      }));

      return sql<RatingChangeRow[]>`
        INSERT INTO rating_changes ${sql(values)}
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `;
    },

    async historyForPlayer(
      playerId: string,
      limit: number,
      offset: number
    ): Promise<RatingChangeRow[]> {
      return sql<RatingChangeRow[]>`
        SELECT * FROM rating_changes
        WHERE player_id = ${playerId}
        ORDER BY settled_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async forMatch(matchId: string): Promise<RatingChangeRow[]> {
      return sql<RatingChangeRow[]>`
        SELECT * FROM rating_changes
        WHERE match_id = ${matchId}
        ORDER BY delta DESC
      `;
    },

    async replayCheck(
      matchId: string,
      playerId: string
    ): Promise<RatingChangeRow | null> {
      const rows = await sql<RatingChangeRow[]>`
        SELECT * FROM rating_changes
        WHERE idempotency_key = ${`${matchId}:${playerId}`}
      `;
      return rows[0] ?? null;
    }
  };
}
