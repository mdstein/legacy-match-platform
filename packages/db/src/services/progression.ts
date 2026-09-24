export const PROFILE_XP_PER_LEVEL = 1_000;
export const MAX_PROFILE_LEVEL = 40;

export interface ProfileProgress {
  level: number;
  xp: number;
}

export interface ProfileProgressionChange extends ProfileProgress {
  earnedXp: number;
}

export function competitiveMatchXp(teamRoundsWon: number): number {
  if (!Number.isInteger(teamRoundsWon) || teamRoundsWon < 0) {
    throw new Error("Competitive rounds won must be a non-negative integer.");
  }
  return Math.min(teamRoundsWon * 30, 1_000);
}

export function deathmatchMatchXp(kills: number): number {
  if (!Number.isInteger(kills) || kills < 0) {
    throw new Error("Deathmatch kills must be a non-negative integer.");
  }
  // B2G's first progression policy gives four XP per authenticated human kill.
  // The per-match ceiling limits the effect of corrupt or farmed server stats.
  return Math.min(kills * 4, 1_000);
}

export function advanceProfile(
  current: ProfileProgress,
  earnedXp: number
): ProfileProgressionChange {
  if (
    !Number.isInteger(current.level)
    || current.level < 1
    || current.level > MAX_PROFILE_LEVEL
    || !Number.isInteger(current.xp)
    || current.xp < 0
    || current.xp >= PROFILE_XP_PER_LEVEL
    || !Number.isInteger(earnedXp)
    || earnedXp < 0
  ) {
    throw new Error("Invalid profile progression state.");
  }

  let level = current.level;
  let xp = current.xp + earnedXp;
  while (level < MAX_PROFILE_LEVEL && xp >= PROFILE_XP_PER_LEVEL) {
    xp -= PROFILE_XP_PER_LEVEL;
    level += 1;
  }
  if (level === MAX_PROFILE_LEVEL) xp = Math.min(xp, PROFILE_XP_PER_LEVEL - 1);
  return { level, xp, earnedXp };
}
