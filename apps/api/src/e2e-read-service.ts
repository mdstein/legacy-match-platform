import type {
  LeaderboardEntry,
  MatchDetails,
  MatchPlayerDetails,
  PlayerProfile,
  PlayerView,
  RatingHistoryPoint,
  RecentMatch
} from "@aftertick/contracts";
import { getRank } from "@aftertick/rating";
import type { PlayerReadService } from "./player-service.js";

const MATCH_ID = "20000000-0000-4000-8000-000000000001";

function rankView(rating: number) {
  const rank = getRank(rating);
  return {
    name: rank.name,
    shortName: rank.shortName,
    rating,
    nextRank: rank.nextRank,
    nextRankFloor: rank.ceiling === null ? null : rank.ceiling + 1,
    progress: rank.progress
  };
}

function playerId(slot: number): string {
  return `10000000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
}

function displayName(slot: number): string {
  return slot === 1 ? "E2E Player" : `Test Player ${String(slot).padStart(2, "0")}`;
}

function recentMatch(): RecentMatch {
  return {
    id: MATCH_ID,
    map: "Inferno",
    score: "16–11",
    outcome: "W",
    ratingDelta: 27,
    adr: 94,
    kills: 24,
    deaths: 17,
    playedAt: "2026-08-28T22:42:00.000Z",
    hasDemo: true,
    analysisStatus: "analyzed"
  };
}

function view(id: string, name: string, rating: number, includeMatch = false): PlayerView {
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("");
  return {
    id,
    displayName: name,
    initials,
    region: "NA Central",
    rank: rankView(rating),
    matchesPlayed: includeMatch ? 143 : 80 + Math.abs(rating % 37),
    winRate: includeMatch ? 54.6 : 48 + Math.abs(rating % 12),
    recentMatches: includeMatch ? [recentMatch()] : []
  };
}

function history(): RatingHistoryPoint[] {
  return [
    { matchId: MATCH_ID, previousRating: 1910, rating: 1937, delta: 27, outcome: "win", settledAt: "2026-08-28T22:45:00.000Z" },
    { matchId: "20000000-0000-4000-8000-000000000002", previousRating: 1931, rating: 1910, delta: -21, outcome: "loss", settledAt: "2026-08-27T23:00:00.000Z" },
    { matchId: "20000000-0000-4000-8000-000000000003", previousRating: 1900, rating: 1931, delta: 31, outcome: "win", settledAt: "2026-08-26T23:00:00.000Z" }
  ];
}

function detailsPlayer(slot: number): MatchPlayerDetails {
  const team = slot <= 5 ? "alpha" : "bravo";
  const kills = team === "alpha" ? 25 - slot : 23 - (slot - 6);
  return {
    playerId: playerId(slot),
    displayName: displayName(slot),
    team,
    slot: (slot - 1) % 5,
    ratingAtMatch: 1850 + slot * 13,
    ratingDelta: team === "alpha" ? 27 : -24,
    kills,
    deaths: team === "alpha" ? 17 : 20,
    assists: 4 + (slot % 5),
    adr: 78 + slot * 2,
    kast: 69 + slot,
    openingKills: slot % 4,
    openingDeaths: slot % 3,
    trades: slot % 5,
    clutches: slot % 2,
    flashAssists: slot % 3,
    utilityDamage: 120 + slot * 17
  };
}

export function createE2EReadService(primaryPlayerId: string): PlayerReadService {
  const rows = Array.from({ length: 10 }, (_, index) => {
    const slot = index + 1;
    const id = slot === 1 ? primaryPlayerId : playerId(slot);
    return view(id, displayName(slot), 1937 - index * 29, slot === 1);
  });

  return {
    async getPlayerView(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async getProfile(id): Promise<PlayerProfile | null> {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      return {
        ...row,
        totals: {
          wins: 78,
          losses: 62,
          draws: 3,
          kills: 2518,
          deaths: 2181,
          assists: 647,
          averageAdr: 86.7,
          averageKast: 72.4
        },
        ratingHistory: id === primaryPlayerId ? history() : []
      };
    },
    async matchHistory(id, limit, offset) {
      const row = rows.find((candidate) => candidate.id === id);
      const all = row?.recentMatches ?? [];
      return { entries: all.slice(offset, offset + limit), total: row?.matchesPlayed ?? 0 };
    },
    async leaderboard(region, limit, offset): Promise<LeaderboardEntry[]> {
      const filtered = rows.filter((row) => !region || row.region === region);
      return filtered.slice(offset, offset + limit).map((row, index) => ({
        position: offset + index + 1,
        playerId: row.id,
        displayName: row.displayName,
        region: row.region,
        rating: row.rank.rating,
        rank: row.rank.shortName,
        matchesPlayed: row.matchesPlayed,
        winRate: row.winRate
      }));
    },
    async getMatchDetails(id): Promise<MatchDetails | null> {
      if (id !== MATCH_ID) return null;
      const roster = Array.from({ length: 10 }, (_, index) => detailsPlayer(index + 1));
      roster[0] = { ...roster[0]!, playerId: primaryPlayerId };
      return {
        id: MATCH_ID,
        map: "Inferno",
        region: "NA Central",
        status: "completed",
        score: { alpha: 16, bravo: 11 },
        startedAt: "2026-08-28T21:58:00.000Z",
        endedAt: "2026-08-28T22:42:00.000Z",
        rulesetVersion: "legacy-csgo-v1",
        teams: {
          alpha: roster.filter((player) => player.team === "alpha"),
          bravo: roster.filter((player) => player.team === "bravo")
        },
        demo: {
          available: false,
          checksum: "a84cde9159e1750751905200a557983265081202310365362796a09b93127fea",
          sizeBytes: 466_591,
          analysisStatus: "analyzed",
          analyzerVersion: "0.1.0-demoinfocs-v3.3.0",
          warnings: [],
          downloadUrl: `/api/matches/${MATCH_ID}/demo`
        }
      };
    }
  };
}
