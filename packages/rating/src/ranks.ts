export const RANKS = [
  { name: "Silver I", shortName: "S1", floor: 0 },
  { name: "Silver II", shortName: "S2", floor: 375 },
  { name: "Silver III", shortName: "S3", floor: 500 },
  { name: "Silver IV", shortName: "S4", floor: 625 },
  { name: "Silver Elite", shortName: "SE", floor: 750 },
  { name: "Silver Elite Master", shortName: "SEM", floor: 875 },
  { name: "Gold Nova I", shortName: "GN1", floor: 1000 },
  { name: "Gold Nova II", shortName: "GN2", floor: 1125 },
  { name: "Gold Nova III", shortName: "GN3", floor: 1250 },
  { name: "Gold Nova Master", shortName: "GNM", floor: 1375 },
  { name: "Master Guardian I", shortName: "MG1", floor: 1500 },
  { name: "Master Guardian II", shortName: "MG2", floor: 1625 },
  { name: "Master Guardian Elite", shortName: "MGE", floor: 1750 },
  { name: "Distinguished Master Guardian", shortName: "DMG", floor: 1875 },
  { name: "Legendary Eagle", shortName: "LE", floor: 2000 },
  { name: "Legendary Eagle Master", shortName: "LEM", floor: 2150 },
  { name: "Supreme Master First Class", shortName: "SMFC", floor: 2300 },
  { name: "The Global Elite", shortName: "GE", floor: 2500 }
] as const;

export type RankName = (typeof RANKS)[number]["name"];

export interface RankSnapshot {
  name: RankName;
  shortName: (typeof RANKS)[number]["shortName"];
  floor: number;
  ceiling: number | null;
  nextRank: RankName | null;
  pointsIntoRank: number;
  pointsForPromotion: number | null;
  progress: number;
}

export function getRank(rating: number): RankSnapshot {
  const normalizedRating = Math.max(0, Math.floor(rating));
  let rankIndex = 0;

  for (let index = RANKS.length - 1; index >= 0; index -= 1) {
    const candidate = RANKS[index];
    if (candidate && normalizedRating >= candidate.floor) {
      rankIndex = index;
      break;
    }
  }

  const current = RANKS[rankIndex] ?? RANKS[0];
  const next = RANKS[rankIndex + 1] ?? null;
  const pointsIntoRank = normalizedRating - current.floor;
  const pointsForPromotion = next ? next.floor - current.floor : null;

  return {
    name: current.name,
    shortName: current.shortName,
    floor: current.floor,
    ceiling: next ? next.floor - 1 : null,
    nextRank: next?.name ?? null,
    pointsIntoRank,
    pointsForPromotion,
    progress: pointsForPromotion
      ? Math.min(1, Math.max(0, pointsIntoRank / pointsForPromotion))
      : 1
  };
}

