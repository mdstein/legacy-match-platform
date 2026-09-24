import type { Sql } from "../connection.js";

export interface PlayerRow {
  id: string;
  steam_id: string | null;
  display_name: string;
  region: string;
  rating: number;
  matches_played: number;
  wins: number;
  losses: number;
  draws: number;
  is_placement: boolean;
  trust_score: number;
  is_banned: boolean;
  ban_reason: string | null;
  ban_expires_at: Date | null;
  platform_role: "player" | "moderator" | "admin";
  created_at: Date;
  updated_at: Date;
  ingame_name_set_at: Date | null;
  preferred_mode: "competitive" | "deathmatch";
  profile_visibility: "public" | "players" | "private";
  allow_party_invites: boolean;
  match_notifications: boolean;
  product_updates: boolean;
  reduced_motion: boolean;
  profile_level: number;
  profile_xp: number;
  lifetime_xp: number;
}

export interface CreatePlayerInput {
  displayName: string;
  region: string;
  steamId?: string;
}

export function playerRepository(sql: Sql) {
  return {
    async findById(id: string): Promise<PlayerRow | null> {
      const rows = await sql<PlayerRow[]>`
        SELECT * FROM players WHERE id = ${id}
      `;
      return rows[0] ?? null;
    },

    async findBySteamId(steamId: string): Promise<PlayerRow | null> {
      const rows = await sql<PlayerRow[]>`
        SELECT * FROM players WHERE steam_id = ${steamId}
      `;
      return rows[0] ?? null;
    },

    async create(input: CreatePlayerInput): Promise<PlayerRow> {
      const rows = await sql<PlayerRow[]>`
        INSERT INTO players (display_name, region, steam_id)
        VALUES (${input.displayName}, ${input.region}, ${input.steamId ?? null})
        RETURNING *
      `;
      return rows[0]!;
    },

    async completeOnboarding(id: string, displayName: string, region: string): Promise<PlayerRow> {
      const rows = await sql<PlayerRow[]>`
        UPDATE players
        SET display_name = ${displayName}, region = ${region}, ingame_name_set_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND ingame_name_set_at IS NULL
        RETURNING *
      `;
      if (!rows[0]) throw new Error("This account has already completed onboarding.");
      return rows[0];
    },

    async updateSettings(id: string, input: {
      region: string;
      preferredMode: "competitive" | "deathmatch";
      profileVisibility: "public" | "players" | "private";
      allowPartyInvites: boolean;
      matchNotifications: boolean;
      productUpdates: boolean;
      reducedMotion: boolean;
    }): Promise<PlayerRow> {
      const rows = await sql<PlayerRow[]>`
        UPDATE players SET
          region = ${input.region},
          preferred_mode = ${input.preferredMode},
          profile_visibility = ${input.profileVisibility},
          allow_party_invites = ${input.allowPartyInvites},
          match_notifications = ${input.matchNotifications},
          product_updates = ${input.productUpdates},
          reduced_motion = ${input.reducedMotion},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      if (!rows[0]) throw new Error("Player not found.");
      return rows[0];
    },

    async updateRating(
      id: string,
      rating: number,
      outcome: "win" | "loss" | "draw"
    ): Promise<PlayerRow> {
      const winInc = outcome === "win" ? 1 : 0;
      const lossInc = outcome === "loss" ? 1 : 0;
      const drawInc = outcome === "draw" ? 1 : 0;

      const rows = await sql<PlayerRow[]>`
        UPDATE players
        SET
          rating = ${rating},
          matches_played = matches_played + 1,
          wins = wins + ${winInc},
          losses = losses + ${lossInc},
          draws = draws + ${drawInc},
          is_placement = (matches_played + 1) < 10,
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return rows[0]!;
    },

    async findByRatingRange(
      minRating: number,
      maxRating: number,
      region: string,
      excludeIds: string[],
      limit: number
    ): Promise<PlayerRow[]> {
      return sql<PlayerRow[]>`
        SELECT * FROM players
        WHERE rating BETWEEN ${minRating} AND ${maxRating}
          AND region = ${region}
          AND NOT (is_banned AND (ban_expires_at IS NULL OR ban_expires_at > NOW()))
          AND NOT EXISTS (
            SELECT 1 FROM sanctions sanction
            WHERE sanction.player_id = players.id AND sanction.is_active = TRUE
              AND sanction.sanction_type IN ('cooldown', 'temp_ban', 'perm_ban')
              AND (sanction.ends_at IS NULL OR sanction.ends_at > NOW())
          )
          AND id != ALL(${excludeIds})
        ORDER BY rating DESC
        LIMIT ${limit}
      `;
    },

    async leaderboard(
      region: string | null,
      limit: number,
      offset: number
    ): Promise<PlayerRow[]> {
      if (region) {
        return sql<PlayerRow[]>`
          SELECT * FROM players
          WHERE region = ${region}
            AND matches_played >= 10
            AND NOT (is_banned AND (ban_expires_at IS NULL OR ban_expires_at > NOW()))
            AND NOT EXISTS (
              SELECT 1 FROM sanctions sanction
              WHERE sanction.player_id = players.id AND sanction.is_active = TRUE
                AND sanction.sanction_type IN ('temp_ban', 'perm_ban')
                AND (sanction.ends_at IS NULL OR sanction.ends_at > NOW())
            )
          ORDER BY rating DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }
      return sql<PlayerRow[]>`
        SELECT * FROM players
        WHERE matches_played >= 10
          AND NOT (is_banned AND (ban_expires_at IS NULL OR ban_expires_at > NOW()))
          AND NOT EXISTS (
            SELECT 1 FROM sanctions sanction
            WHERE sanction.player_id = players.id AND sanction.is_active = TRUE
              AND sanction.sanction_type IN ('temp_ban', 'perm_ban')
              AND (sanction.ends_at IS NULL OR sanction.ends_at > NOW())
          )
        ORDER BY rating DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }
  };
}
