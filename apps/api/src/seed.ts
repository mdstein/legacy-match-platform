import type { PlayerView } from "@aftertick/contracts";
import { getRank } from "@aftertick/rating";

const rating = 1937;
const rank = getRank(rating);

export const demoPlayer: PlayerView = {
  id: "demo-player",
  displayName: "Northstar",
  initials: "NS",
  region: "NA Central",
  rank: {
    name: rank.name,
    shortName: rank.shortName,
    rating,
    nextRank: rank.nextRank,
    nextRankFloor: rank.ceiling === null ? null : rank.ceiling + 1,
    progress: rank.progress
  },
  matchesPlayed: 143,
  winRate: 54.6,
  recentMatches: [
    {
      id: "m-8421",
      map: "Inferno",
      score: "16–11",
      outcome: "W",
      ratingDelta: 28,
      adr: 94,
      kills: 24,
      deaths: 17,
      playedAt: "2026-08-28T17:42:00.000Z"
    },
    {
      id: "m-8402",
      map: "Nuke",
      score: "13–16",
      outcome: "L",
      ratingDelta: -21,
      adr: 88,
      kills: 22,
      deaths: 20,
      playedAt: "2026-08-27T22:18:00.000Z"
    },
    {
      id: "m-8387",
      map: "Mirage",
      score: "16–6",
      outcome: "W",
      ratingDelta: 31,
      adr: 106,
      kills: 27,
      deaths: 12,
      playedAt: "2026-08-27T19:06:00.000Z"
    },
    {
      id: "m-8334",
      map: "Overpass",
      score: "14–16",
      outcome: "L",
      ratingDelta: -18,
      adr: 91,
      kills: 23,
      deaths: 19,
      playedAt: "2026-08-25T23:31:00.000Z"
    }
  ]
};

