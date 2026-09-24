import type { GameMode, RankView, RecentMatch } from "./index.js";

export type FriendRelationship = "self" | "none" | "incoming" | "outgoing" | "friends";
export interface SocialPlayer {
  playerId: string;
  displayName: string;
  relationship: FriendRelationship;
  requestId: string | null;
  private: boolean;
  online: boolean | null;
}
export interface FriendsPage {
  entries: SocialPlayer[];
  total: number;
  offset: number;
  incomingCount: number;
  friendCount: number;
}
export interface LauncherSocialProfile {
  player: SocialPlayer;
  region: string | null;
  memberSince: string | null;
  steamProfileUrl: string | null;
  rank: RankView | null;
  rankId: number | null;
  level: number | null;
  mode: GameMode;
  stats: {
    gamesPlayed: number; wins: number; losses: number; draws: number;
    winRate: number; kills: number; deaths: number; assists: number;
    kdRatio: number; averageAdr: number;
  } | null;
  recentMatches: RecentMatch[];
  matchTotal: number;
  matchOffset: number;
}
