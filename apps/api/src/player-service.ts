import type {
  AccountSettings,
  LeaderboardEntry,
  MatchDetails,
  MatchPlayerDetails,
  PlayerProfile,
  PlayerView,
  RecentMatch
} from "@aftertick/contracts";
import type { PlayerRow, Sql } from "@aftertick/db";
import { playerRepository, matchRepository, ratingLedgerRepository } from "@aftertick/db";
import { getRank } from "@aftertick/rating";
import type { SteamProfile } from "./auth/steam.js";

export interface PlayerReadService {
  getPlayerView(playerId: string): Promise<PlayerView | null>;
  getProfile(playerId: string): Promise<PlayerProfile | null>;
  matchHistory(playerId: string, limit: number, offset: number): Promise<{ entries: RecentMatch[]; total: number }>;
  leaderboard(region: string | null, limit: number, offset: number): Promise<LeaderboardEntry[]>;
  getMatchDetails(matchId: string): Promise<MatchDetails | null>;
  completeOnboarding?(playerId: string, displayName: string, region: string): Promise<PlayerView>;
  updateSettings?(playerId: string, settings: AccountSettings & { region: string }): Promise<PlayerView>;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function outcomeLabel(
  team: string,
  alphaRounds: number | null,
  bravoRounds: number | null,
  mode: "competitive" | "deathmatch" = "competitive",
  kills = 0
): "W" | "L" | "D" {
  const a = alphaRounds ?? 0;
  const b = bravoRounds ?? 0;
  if (mode === "deathmatch") {
    if (kills !== a) return "L";
    return a === b ? "D" : "W";
  }
  if (a === b) return "D";
  const teamWon = (team === "alpha" && a > b) || (team === "bravo" && b > a);
  return teamWon ? "W" : "L";
}

export function playerService(sql: Sql) {
  const players = playerRepository(sql);
  const matches = matchRepository(sql);
  const ledger = ratingLedgerRepository(sql);

  const readMatches = async (playerId: string, limit: number, offset: number): Promise<RecentMatch[]> => {
    const rows = await matches.recentForPlayer(playerId, limit, offset);
    return rows.map((match) => ({
      id: match.id,
      map: match.map,
      score: match.mode === "deathmatch"
        ? `${match.alpha_rounds ?? 0} top frags`
        : `${match.alpha_rounds ?? 0}–${match.bravo_rounds ?? 0}`,
      outcome: outcomeLabel(match.team, match.alpha_rounds, match.bravo_rounds, match.mode, match.kills),
      ratingDelta: match.rating_delta,
      adr: Math.round(match.adr),
      kills: match.kills,
      deaths: match.deaths,
      playedAt: (match.ended_at ?? match.created_at).toISOString(),
      hasDemo: match.demo_status === "uploaded" || match.demo_status === "analyzed",
      analysisStatus: match.demo_status,
      mode: match.mode
    }));
  };

  return {
    async findBySteamId(steamId: string): Promise<{ id: string; displayName: string } | null> {
      const existing = await players.findBySteamId(steamId);
      return existing ? { id: existing.id, displayName: existing.display_name } : null;
    },

    async setRoleBySteamId(steamId: string, role: "player" | "moderator" | "admin"): Promise<void> {
      await sql`update players set platform_role = ${role}, updated_at = now() where steam_id = ${steamId}`;
    },

    async findOrCreateBySteam(
      steamId: string,
      profile: SteamProfile
    ): Promise<{ id: string; displayName: string }> {
      const existing = await players.findBySteamId(steamId);
      if (existing) {
        return { id: existing.id, displayName: existing.display_name };
      }

      const created = await players.create({
        displayName: profile.displayName,
        region: "NA Central",
        steamId
      });
      return { id: created.id, displayName: created.display_name };
    },

    async getPlayerView(playerId: string): Promise<PlayerView | null> {
      const row = await players.findById(playerId);
      if (!row) return null;

      const rank = getRank(row.rating);
      const recentMatches = await readMatches(playerId, 10, 0);
      const totalPlayed = row.wins + row.losses + row.draws;

      return {
        id: row.id,
        displayName: row.display_name,
        initials: initials(row.display_name),
        region: row.region,
        rank: {
          name: rank.name,
          shortName: rank.shortName,
          rating: row.rating,
          nextRank: rank.nextRank,
          nextRankFloor: rank.ceiling === null ? null : rank.ceiling + 1,
          progress: rank.progress
        },
        matchesPlayed: row.matches_played,
        winRate: totalPlayed > 0
          ? Math.round((row.wins / totalPlayed) * 1000) / 10
          : 0,
        recentMatches,
        platformRole: row.platform_role,
        onboardingRequired: row.ingame_name_set_at === null,
        settings: {
          preferredMode: row.preferred_mode,
          profileVisibility: row.profile_visibility,
          allowPartyInvites: row.allow_party_invites,
          matchNotifications: row.match_notifications,
          productUpdates: row.product_updates,
          reducedMotion: row.reduced_motion
        }
      };
    },

    async matchHistory(playerId: string, limit: number, offset: number): Promise<{ entries: RecentMatch[]; total: number }> {
      const player = await players.findById(playerId);
      if (!player) return { entries: [], total: 0 };
      const [history] = await sql<{ total:number }[]>`
        select count(*)::int as total from rosters roster
        join matches match on match.id=roster.match_id
        where roster.player_id=${playerId} and match.status='completed'
      `;
      return {
        entries: await readMatches(playerId, limit, offset),
        total: history?.total ?? 0
      };
    },

    async completeOnboarding(playerId: string, displayName: string, region: string): Promise<PlayerView> {
      await players.completeOnboarding(playerId, displayName, region);
      const view = await this.getPlayerView(playerId);
      if (!view) throw new Error("Player not found.");
      return view;
    },

    async updateSettings(playerId: string, settings: AccountSettings & { region: string }): Promise<PlayerView> {
      await players.updateSettings(playerId, settings);
      const view = await this.getPlayerView(playerId);
      if (!view) throw new Error("Player not found.");
      return view;
    },

    async getProfile(playerId: string): Promise<PlayerProfile | null> {
      const view = await this.getPlayerView(playerId);
      if (!view) return null;
      const [row] = await sql<{
        wins: number;
        losses: number;
        draws: number;
        kills: number;
        deaths: number;
        assists: number;
        average_adr: number;
        average_kast: number;
      }[]>`
        select player.wins, player.losses, player.draws,
               coalesce(sum(stats.kills), 0)::int as kills,
               coalesce(sum(stats.deaths), 0)::int as deaths,
               coalesce(sum(stats.assists), 0)::int as assists,
               coalesce(avg(stats.adr), 0)::real as average_adr,
               coalesce(avg(stats.kast), 0)::real as average_kast
        from players player
        left join match_stats stats on stats.player_id = player.id
        where player.id = ${playerId}
        group by player.id
      `;
      const history = await ledger.historyForPlayer(playerId, 50, 0);
      return {
        ...view,
        totals: {
          wins: row?.wins ?? 0,
          losses: row?.losses ?? 0,
          draws: row?.draws ?? 0,
          kills: row?.kills ?? 0,
          deaths: row?.deaths ?? 0,
          assists: row?.assists ?? 0,
          averageAdr: Math.round((row?.average_adr ?? 0) * 10) / 10,
          averageKast: Math.round((row?.average_kast ?? 0) * 10) / 10
        },
        ratingHistory: history.reverse().map((entry) => ({
          matchId: entry.match_id,
          previousRating: entry.previous_rating,
          rating: entry.next_rating,
          delta: entry.delta,
          outcome: entry.outcome,
          settledAt: entry.settled_at.toISOString()
        }))
      };
    },

    async leaderboard(region: string | null, limit: number, offset: number): Promise<LeaderboardEntry[]> {
      const rows = await players.leaderboard(region, limit, offset);
      return rows.map((row, index) => ({
        position: offset + index + 1,
        playerId: row.id,
        displayName: row.display_name,
        region: row.region,
        rating: row.rating,
        rank: getRank(row.rating).shortName,
        matchesPlayed: row.matches_played,
        winRate: row.matches_played > 0 ? Math.round((row.wins / row.matches_played) * 1_000) / 10 : 0
      }));
    },

    async getMatchDetails(matchId: string): Promise<MatchDetails | null> {
      const [match] = await sql<{
        id: string;
        map: string;
        region: string;
        status: MatchDetails["status"];
        alpha_rounds: number | null;
        bravo_rounds: number | null;
        started_at: Date | null;
        ended_at: Date | null;
        ruleset_version: string;
        mode: "competitive" | "deathmatch";
        demo_checksum: string | null;
        demo_status: "uploaded" | "analyzed" | "invalid" | "deleted" | null;
        size_bytes: number | null;
        analyzer_version: string | null;
        warnings: unknown;
      }[]>`
        select match.id, match.map, match.region, match.status::text, match.mode,
               match.alpha_rounds, match.bravo_rounds, match.started_at,
               match.ended_at, match.ruleset_version, match.demo_checksum,
               artifact.status as demo_status, artifact.size_bytes::int,
               artifact.analyzer_version,
               artifact.analysis->'quality'->'warnings' as warnings
        from matches match
        left join match_demo_artifacts artifact on artifact.match_id = match.id
        where match.id = ${matchId}
      `;
      if (!match) return null;
      const roster = await sql<Array<MatchPlayerDetails>>`
        select roster.player_id as "playerId", player.display_name as "displayName",
               roster.team, roster.slot, roster.rating_at_match as "ratingAtMatch",
               coalesce(change.delta, 0) as "ratingDelta",
               coalesce(stats.kills, 0) as kills, coalesce(stats.deaths, 0) as deaths,
               coalesce(stats.assists, 0) as assists, coalesce(stats.adr, 0) as adr,
               coalesce(stats.kast, 0) as kast,
               coalesce(stats.opening_kills, 0) as "openingKills",
               coalesce(stats.opening_deaths, 0) as "openingDeaths",
               coalesce(stats.trades, 0) as trades, coalesce(stats.clutches, 0) as clutches,
               coalesce(stats.flash_assists, 0) as "flashAssists",
               coalesce(stats.utility_damage, 0) as "utilityDamage"
        from rosters roster
        join players player on player.id = roster.player_id
        left join match_stats stats
          on stats.match_id = roster.match_id and stats.player_id = roster.player_id
        left join rating_changes change
          on change.match_id = roster.match_id and change.player_id = roster.player_id
        where roster.match_id = ${matchId}
        order by roster.team, roster.slot
      `;
      const warnings = Array.isArray(match.warnings)
        ? match.warnings.filter((warning): warning is string => typeof warning === "string")
        : [];
      return {
        id: match.id,
        map: match.map,
        region: match.region,
        status: match.status,
        score: { alpha: match.alpha_rounds, bravo: match.bravo_rounds },
        startedAt: match.started_at?.toISOString() ?? null,
        endedAt: match.ended_at?.toISOString() ?? null,
        rulesetVersion: match.ruleset_version,
        mode: match.mode,
        teams: {
          alpha: roster.filter((player) => player.team === "alpha"),
          bravo: roster.filter((player) => player.team === "bravo"),
          ffa: roster
            .filter((player) => player.team === "ffa")
            .sort((left, right) => right.kills - left.kills || left.deaths - right.deaths)
        },
        demo: match.demo_checksum && match.demo_status && match.size_bytes
          ? {
              available: match.demo_status === "uploaded" || match.demo_status === "analyzed",
              checksum: match.demo_checksum,
              sizeBytes: match.size_bytes,
              analysisStatus: match.demo_status,
              analyzerVersion: match.analyzer_version,
              warnings,
              downloadUrl: match.demo_status === "uploaded" || match.demo_status === "analyzed"
                ? `/api/matches/${match.id}/demo`
                : null
            }
          : null
      };
    },

    async ensureDevPlayer(): Promise<PlayerRow> {
      const devSteamId = "dev-steam-id";
      const existing = await players.findBySteamId(devSteamId);
      if (existing) return existing;

      return players.create({
        displayName: "Northstar",
        region: "NA Central",
        steamId: devSteamId
      });
    }
  };
}
