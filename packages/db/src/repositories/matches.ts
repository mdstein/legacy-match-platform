import type { Sql } from "../connection.js";

export interface MatchRow {
  id: string;
  season_id: string | null;
  map: string;
  region: string;
  server_address: string | null;
  status: "pending" | "live" | "completed" | "cancelled" | "disputed";
  alpha_rounds: number | null;
  bravo_rounds: number | null;
  ruleset_version: string;
  started_at: Date | null;
  ended_at: Date | null;
  cancelled_reason: string | null;
  demo_url: string | null;
  demo_checksum: string | null;
  created_at: Date;
  mode: "competitive" | "deathmatch";
  frag_limit: number | null;
  time_limit_seconds: number | null;
}

export interface RosterRow {
  id: string;
  match_id: string;
  player_id: string;
  team: "alpha" | "bravo" | "ffa";
  slot: number;
  rating_at_match: number;
  created_at: Date;
}

export interface CreateMatchInput {
  map: string;
  region: string;
  seasonId?: string;
  serverAddress?: string;
  mode?: "competitive" | "deathmatch";
}

export interface RosterEntry {
  playerId: string;
  team: "alpha" | "bravo" | "ffa";
  slot: number;
  ratingAtMatch: number;
}

export function matchRepository(sql: Sql) {
  return {
    async findById(id: string): Promise<MatchRow | null> {
      const rows = await sql<MatchRow[]>`
        SELECT * FROM matches WHERE id = ${id}
      `;
      return rows[0] ?? null;
    },

    async create(input: CreateMatchInput): Promise<MatchRow> {
      const mode = input.mode ?? "competitive";
      const rows = await sql<MatchRow[]>`
        INSERT INTO matches (
          map, region, season_id, server_address, mode, frag_limit, time_limit_seconds
        )
        VALUES (
          ${input.map},
          ${input.region},
          ${input.seasonId ?? null},
          ${input.serverAddress ?? null},
          ${mode},
          ${mode === "deathmatch" ? 40 : null},
          ${mode === "deathmatch" ? 600 : null}
        )
        RETURNING *
      `;
      return rows[0]!;
    },

    async addRoster(
      matchId: string,
      entries: RosterEntry[]
    ): Promise<RosterRow[]> {
      const values = entries.map((e) => ({
        match_id: matchId,
        player_id: e.playerId,
        team: e.team,
        slot: e.slot,
        rating_at_match: e.ratingAtMatch
      }));

      return sql<RosterRow[]>`
        INSERT INTO rosters ${sql(values)}
        RETURNING *
      `;
    },

    async getRoster(matchId: string): Promise<RosterRow[]> {
      return sql<RosterRow[]>`
        SELECT * FROM rosters
        WHERE match_id = ${matchId}
        ORDER BY team, slot
      `;
    },

    async start(matchId: string): Promise<MatchRow> {
      const rows = await sql<MatchRow[]>`
        UPDATE matches
        SET status = 'live', started_at = NOW()
        WHERE id = ${matchId} AND status = 'pending'
        RETURNING *
      `;
      if (rows.length === 0) {
        throw new Error(`Match ${matchId} cannot be started (not pending).`);
      }
      return rows[0]!;
    },

    async complete(
      matchId: string,
      alphaRounds: number,
      bravoRounds: number
    ): Promise<MatchRow> {
      const rows = await sql<MatchRow[]>`
        UPDATE matches
        SET
          status = 'completed',
          alpha_rounds = ${alphaRounds},
          bravo_rounds = ${bravoRounds},
          ended_at = NOW()
        WHERE id = ${matchId} AND status = 'live'
        RETURNING *
      `;
      if (rows.length === 0) {
        throw new Error(`Match ${matchId} cannot be completed (not live).`);
      }
      return rows[0]!;
    },

    async cancel(matchId: string, reason: string): Promise<MatchRow> {
      const rows = await sql<MatchRow[]>`
        UPDATE matches
        SET status = 'cancelled', cancelled_reason = ${reason}, ended_at = NOW()
        WHERE id = ${matchId} AND status IN ('pending', 'live')
        RETURNING *
      `;
      if (rows.length === 0) {
        throw new Error(`Match ${matchId} cannot be cancelled.`);
      }
      return rows[0]!;
    },

    async recentForPlayer(
      playerId: string,
      limit: number,
      offset = 0
    ): Promise<
      (MatchRow & {
        team: string;
        kills: number;
        deaths: number;
        adr: number;
        rating_delta: number;
        demo_status: "uploaded" | "analyzed" | "invalid" | "deleted" | null;
      })[]
    > {
      return sql`
        SELECT
          m.*,
          r.team,
          COALESCE(s.kills, 0) AS kills,
          COALESCE(s.deaths, 0) AS deaths,
          COALESCE(s.adr, 0) AS adr,
          COALESCE(rc.delta, 0) AS rating_delta,
          artifact.status AS demo_status
        FROM matches m
        JOIN rosters r ON r.match_id = m.id AND r.player_id = ${playerId}
        LEFT JOIN match_stats s ON s.match_id = m.id AND s.player_id = ${playerId}
        LEFT JOIN rating_changes rc ON rc.match_id = m.id AND rc.player_id = ${playerId}
        LEFT JOIN match_demo_artifacts artifact ON artifact.match_id = m.id
        WHERE m.status = 'completed'
        ORDER BY m.ended_at DESC, m.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      ` as any;
    },

    async attachDemo(
      matchId: string,
      demoUrl: string,
      checksum: string
    ): Promise<void> {
      await sql`
        UPDATE matches
        SET demo_url = ${demoUrl}, demo_checksum = ${checksum}
        WHERE id = ${matchId}
      `;
    }
  };
}
