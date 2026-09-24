export type MatchOutcome = "win" | "loss" | "draw";

export interface PerformanceLine {
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  kast: number;
  openingKills: number;
  openingDeaths: number;
  trades: number;
  clutches: number;
  flashAssists: number;
  utilityDamage: number;
  roundsPlayed: number;
}

export interface RatingParticipant {
  playerId: string;
  team: "alpha" | "bravo";
  rating: number;
  matchesPlayed: number;
  performance: PerformanceLine;
}

export interface RatingCalculationInput {
  participants: RatingParticipant[];
  alphaRounds: number;
  bravoRounds: number;
}

export interface RatingChange {
  playerId: string;
  previousRating: number;
  nextRating: number;
  delta: number;
  outcome: MatchOutcome;
  expectedWinProbability: number;
  components: {
    result: number;
    roundMargin: number;
    performance: number;
    placementMultiplier: number;
  };
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

function centerWithinBounds(
  values: number[],
  minimum: number,
  maximum: number
): number[] {
  const centered = values.map((value) => clamp(value, minimum, maximum));

  // Project onto a zero-sum interval. When a value reaches a cap, the
  // remaining residual is shared only by values that still have room.
  for (let pass = 0; pass < values.length + 2; pass += 1) {
    const residual = centered.reduce((total, value) => total + value, 0);
    if (Math.abs(residual) < 1e-10) break;
    const adjustable = centered
      .map((value, index) => ({ value, index }))
      .filter(({ value }) =>
        residual > 0 ? value > minimum + 1e-10 : value < maximum - 1e-10
      );
    if (adjustable.length === 0) break;
    const correction = residual / adjustable.length;
    adjustable.forEach(({ index }) => {
      centered[index] = clamp(
        (centered[index] ?? 0) - correction,
        minimum,
        maximum
      );
    });
  }

  return centered;
}

function expectedScore(teamRating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - teamRating) / 400));
}

function rawImpact(line: PerformanceLine): number {
  const rounds = Math.max(1, line.roundsPlayed);
  const killsPerRound = line.kills / rounds;
  const deathsPerRound = line.deaths / rounds;
  const assistsPerRound = line.assists / rounds;
  const openingNetPerRound = (line.openingKills - line.openingDeaths) / rounds;
  const tradesPerRound = line.trades / rounds;
  const clutchRate = line.clutches / rounds;
  const flashAssistRate = line.flashAssists / rounds;
  const utilityPerRound = line.utilityDamage / rounds;

  return (
    killsPerRound * 0.34 -
    deathsPerRound * 0.16 +
    assistsPerRound * 0.08 +
    (line.adr / 100) * 0.2 +
    (line.kast / 100) * 0.12 +
    openingNetPerRound * 0.13 +
    tradesPerRound * 0.08 +
    clutchRate * 0.55 +
    flashAssistRate * 0.08 +
    (utilityPerRound / 30) * 0.05
  );
}

function outcomeForTeam(
  team: RatingParticipant["team"],
  alphaRounds: number,
  bravoRounds: number
): MatchOutcome {
  if (alphaRounds === bravoRounds) return "draw";
  const alphaWon = alphaRounds > bravoRounds;
  return (team === "alpha") === alphaWon ? "win" : "loss";
}

function resultComponent(outcome: MatchOutcome, expected: number): number {
  const actual = outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5;
  const raw = 50 * (actual - expected);

  if (outcome === "draw") return clamp(raw, -8, 8);
  const sign = outcome === "win" ? 1 : -1;
  return sign * clamp(Math.abs(raw), 15, 40);
}

function roundMarginComponent(
  outcome: MatchOutcome,
  alphaRounds: number,
  bravoRounds: number
): number {
  if (outcome === "draw") return 0;
  const totalRounds = Math.max(1, alphaRounds + bravoRounds);
  const margin = Math.abs(alphaRounds - bravoRounds);
  const magnitude = clamp((margin / totalRounds) * 5, 0, 3);
  return outcome === "win" ? magnitude : -magnitude;
}

function placementMultiplier(matchesPlayed: number): number {
  if (matchesPlayed >= 10) return 1;
  return 1 + ((10 - Math.max(0, matchesPlayed)) / 10) * 0.25;
}

/**
 * Calculate visible, zero-sum performance-aware rating changes.
 *
 * The result and opponent strength remain dominant. Performance is centered on
 * the ten-player lobby, then capped, so it can distinguish impact without
 * rewarding stat farming or creating rating out of thin air.
 */
export function calculateRatingChanges(
  input: RatingCalculationInput
): RatingChange[] {
  if (input.participants.length < 2) {
    throw new Error("A rated match needs at least two participants.");
  }

  const alpha = input.participants.filter((player) => player.team === "alpha");
  const bravo = input.participants.filter((player) => player.team === "bravo");

  if (alpha.length === 0 || bravo.length === 0) {
    throw new Error("A rated match needs players on both teams.");
  }

  const alphaAverage = mean(alpha.map((player) => player.rating));
  const bravoAverage = mean(bravo.map((player) => player.rating));
  const alphaExpected = expectedScore(alphaAverage, bravoAverage);
  const impacts = input.participants.map((player) => rawImpact(player.performance));
  const impactMean = mean(impacts);
  const variance = mean(impacts.map((impact) => (impact - impactMean) ** 2));
  const standardDeviation = Math.sqrt(variance);

  const centeredPerformance = impacts.map((impact) => {
    if (standardDeviation < 0.0001) return 0;
    const zScore = (impact - impactMean) / standardDeviation;
    return clamp(zScore * 3.5, -7, 7);
  });

  // Capping can disturb the mean very slightly. Re-center after the cap so the
  // performance layer remains zero-sum across the lobby.
  const performanceModifiers = centerWithinBounds(centeredPerformance, -7, 7);

  return input.participants.map((player, index) => {
    const outcome = outcomeForTeam(
      player.team,
      input.alphaRounds,
      input.bravoRounds
    );
    const expected = player.team === "alpha" ? alphaExpected : 1 - alphaExpected;
    const result = resultComponent(outcome, expected);
    const roundMargin = roundMarginComponent(
      outcome,
      input.alphaRounds,
      input.bravoRounds
    );
    const performance = performanceModifiers[index] ?? 0;
    const convergence = placementMultiplier(player.matchesPlayed);
    const unrounded = (result + roundMargin + performance) * convergence;
    let delta = Math.round(unrounded);

    // Performance may soften or strengthen a result; it may never invert it.
    if (outcome === "win") delta = Math.max(1, delta);
    if (outcome === "loss") delta = Math.min(-1, delta);
    if (outcome === "draw") delta = clamp(delta, -10, 10);

    const nextRating = Math.max(0, player.rating + delta);

    return {
      playerId: player.playerId,
      previousRating: player.rating,
      nextRating,
      delta: nextRating - player.rating,
      outcome,
      expectedWinProbability: expected,
      components: {
        result,
        roundMargin,
        performance,
        placementMultiplier: convergence
      }
    };
  });
}
