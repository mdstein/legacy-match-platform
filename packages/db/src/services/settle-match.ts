import type { RatingCalculationInput } from "@aftertick/rating";
import { calculateRatingChanges } from "@aftertick/rating";
import type { Sql } from "../connection.js";
import { grantServiceLevelRewards } from "./service-level-rewards.js";
export { chooseServiceRewardKind } from "./service-level-rewards.js";
import { advanceProfile, competitiveMatchXp, deathmatchMatchXp } from "./progression.js";

const ENGINE_VERSION = "1.0";

export interface SettleMatchInput {
  matchId: string;
  alphaRounds: number;
  bravoRounds: number;
}

export interface SettlementResult {
  matchId: string;
  progression: Array<{
    playerId: string;
    steamId: string;
    earnedXp: number;
    previousLevel: number;
    previousXp: number;
    nextLevel: number;
    nextXp: number;
    xpCategory: 1 | 2;
    serviceDrop: {
      id: string;
      serviceLevel: number;
      rewardType: "b2g_service_drop";
    } | null;
  }>;
  changes: Array<{
    playerId: string;
    previousRating: number;
    nextRating: number;
    delta: number;
    outcome: "win" | "loss" | "draw";
  }>;
}

export async function settleMatch(
  sql: Sql,
  input: SettleMatchInput
): Promise<SettlementResult> {
  return sql.begin(async (tx) => {
    const [match] = await tx<{
      id: string;
      mode: "competitive" | "deathmatch";
      status: string;
      alpha_rounds: number | null;
      bravo_rounds: number | null;
    }[]>`
      SELECT id, mode, status, alpha_rounds, bravo_rounds
      FROM matches
      WHERE id = ${input.matchId}
      FOR UPDATE
    `;
    if (!match) throw new Error(`Match ${input.matchId} not found.`);
    if (match.status === "completed") {
      if (
        match.alpha_rounds !== input.alphaRounds
        || match.bravo_rounds !== input.bravoRounds
      ) {
        throw new Error(`Match ${input.matchId} already settled with a conflicting score.`);
      }
      const persisted = await tx<{
        player_id: string;
        previous_rating: number;
        next_rating: number;
        delta: number;
        outcome: "win" | "loss" | "draw";
      }[]>`
        select change.player_id, change.previous_rating, change.next_rating,
               change.delta, change.outcome
        from rating_changes change
        join rosters roster
          on roster.match_id = change.match_id and roster.player_id = change.player_id
        where change.match_id = ${input.matchId}
        order by roster.team, roster.slot
      `;
      const persistedProgression = await tx<{
        player_id: string;
        steam_id: string;
        delta: number;
        previous_level: number;
        previous_xp: number;
        next_level: number;
        next_xp: number;
        service_drop_id: string | null;
        service_drop_level: number | null;
      }[]>`
        select ledger.player_id, player.steam_id, ledger.delta,
               ledger.previous_level, ledger.previous_xp,
               ledger.next_level, ledger.next_xp,
               reward.id as service_drop_id,
               reward.service_level as service_drop_level
        from player_xp_ledger ledger
        join players player on player.id = ledger.player_id
        join rosters roster
          on roster.match_id = ledger.match_id and roster.player_id = ledger.player_id
        left join player_service_drops reward
          on reward.match_id = ledger.match_id and reward.player_id = ledger.player_id
        where ledger.match_id = ${input.matchId}
        order by roster.team, roster.slot
      `;
      return {
        matchId: input.matchId,
        progression: persistedProgression.map((entry) => ({
          playerId: entry.player_id,
          steamId: entry.steam_id,
          earnedXp: entry.delta,
          previousLevel: entry.previous_level,
          previousXp: entry.previous_xp,
          nextLevel: entry.next_level,
          nextXp: entry.next_xp,
          xpCategory: match.mode === "deathmatch" ? 1 : 2,
          serviceDrop: entry.service_drop_id && entry.service_drop_level
            ? {
                id: entry.service_drop_id,
                serviceLevel: entry.service_drop_level,
                rewardType: "b2g_service_drop" as const
              }
            : null
        })),
        changes: persisted.map((change) => ({
          playerId: change.player_id,
          previousRating: change.previous_rating,
          nextRating: change.next_rating,
          delta: change.delta,
          outcome: change.outcome
        }))
      };
    }
    if (match.status !== "live") {
      throw new Error(`Match ${input.matchId} is not live (status: ${match.status}).`);
    }

    const roster = await tx<
      Array<{
        player_id: string;
        steam_id: string;
        team: "alpha" | "bravo" | "ffa";
        rating_at_match: number;
      }>
    >`
      SELECT r.player_id, player.steam_id, r.team, r.rating_at_match
      FROM rosters r
      JOIN players player ON player.id = r.player_id
      WHERE r.match_id = ${input.matchId}
      ORDER BY r.team, r.slot
    `;

    const stats = await tx<
      Array<{
        player_id: string;
        kills: number;
        deaths: number;
        assists: number;
        adr: number;
        kast: number;
        opening_kills: number;
        opening_deaths: number;
        trades: number;
        clutches: number;
        flash_assists: number;
        utility_damage: number;
        rounds_played: number;
      }>
    >`
      SELECT * FROM match_stats WHERE match_id = ${input.matchId}
    `;
    const statsMap = new Map(stats.map((stat) => [stat.player_id, stat]));

    const profiles = roster.length === 0 ? [] : await tx<Array<{
      id: string;
      profile_level: number;
      profile_xp: number;
      service_prestige: number;
    }>>`
      SELECT id, profile_level, profile_xp, service_prestige
      FROM players
      WHERE id = ANY(${roster.map((entry) => entry.player_id)})
      ORDER BY id
      FOR UPDATE
    `;
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    const progression: SettlementResult["progression"] = [];
    for (const entry of roster) {
      const profile = profilesById.get(entry.player_id);
      if (!profile) throw new Error(`Roster player ${entry.player_id} no longer exists.`);
      const earnedXp = match.mode === "deathmatch"
        ? deathmatchMatchXp(statsMap.get(entry.player_id)?.kills ?? 0)
        : competitiveMatchXp(entry.team === "alpha" ? input.alphaRounds : input.bravoRounds);
      if (earnedXp === 0) continue;
      const next = advanceProfile(
        { level: profile.profile_level, xp: profile.profile_xp },
        earnedXp
      );
      const inserted = await tx<{ inserted: number }[]>`
        INSERT INTO player_xp_ledger (
          player_id, match_id, delta, reason,
          previous_level, previous_xp, next_level, next_xp
        ) VALUES (
          ${entry.player_id}, ${input.matchId}, ${earnedXp},
          ${match.mode === "deathmatch" ? "deathmatch_match" : "competitive_match"},
          ${profile.profile_level}, ${profile.profile_xp}, ${next.level}, ${next.xp}
        )
        ON CONFLICT (player_id, match_id) WHERE match_id IS NOT NULL DO NOTHING
        RETURNING 1 AS inserted
      `;
      if (inserted.length === 0) continue;
      await tx`
        UPDATE players
        SET profile_level = ${next.level}, profile_xp = ${next.xp},
            lifetime_xp = lifetime_xp + ${earnedXp}, updated_at = NOW()
        WHERE id = ${entry.player_id}
      `;
      let serviceDrop: SettlementResult["progression"][number]["serviceDrop"] = null;
      if (next.level > profile.profile_level) {
        for (let level = profile.profile_level + 1; level <= next.level; level++) {
          serviceDrop = await grantServiceLevelRewards(tx, entry.player_id, level, profile.service_prestige, input.matchId);
        }
      }
      progression.push({
        playerId: entry.player_id,
        steamId: entry.steam_id,
        earnedXp,
        previousLevel: profile.profile_level,
        previousXp: profile.profile_xp,
        nextLevel: next.level,
        nextXp: next.xp,
        xpCategory: match.mode === "deathmatch" ? 1 : 2,
        serviceDrop
      });
    }

    if (match.mode === "deathmatch") {
      await tx`
        UPDATE matches
        SET status = 'completed', alpha_rounds = ${input.alphaRounds},
            bravo_rounds = ${input.bravoRounds}, ended_at = NOW()
        WHERE id = ${input.matchId}
      `;
      return { matchId: input.matchId, progression, changes: [] };
    }

    if (roster.length < 2) {
      throw new Error("Not enough players on the roster to settle.");
    }

    const [currentRatings] = [
      await tx<Array<{ id: string; rating: number; matches_played: number }>>`
        SELECT id, rating, matches_played FROM players
        WHERE id = ANY(${roster.map((r) => r.player_id)})
        FOR UPDATE
      `
    ];

    const ratingsMap = new Map(currentRatings.map((p) => [p.id, p]));

    const calcInput: RatingCalculationInput = {
      participants: roster.map((r) => {
        if (r.team === "ffa") throw new Error("Competitive rosters cannot contain FFA players.");
        const current = ratingsMap.get(r.player_id);
        const st = statsMap.get(r.player_id);
        return {
          playerId: r.player_id,
          team: r.team,
          rating: current?.rating ?? r.rating_at_match,
          matchesPlayed: current?.matches_played ?? 0,
          performance: {
            kills: st?.kills ?? 0,
            deaths: st?.deaths ?? 0,
            assists: st?.assists ?? 0,
            adr: st?.adr ?? 0,
            kast: st?.kast ?? 0,
            openingKills: st?.opening_kills ?? 0,
            openingDeaths: st?.opening_deaths ?? 0,
            trades: st?.trades ?? 0,
            clutches: st?.clutches ?? 0,
            flashAssists: st?.flash_assists ?? 0,
            utilityDamage: st?.utility_damage ?? 0,
            roundsPlayed: st?.rounds_played ?? Math.max(1, input.alphaRounds + input.bravoRounds)
          }
        };
      }),
      alphaRounds: input.alphaRounds,
      bravoRounds: input.bravoRounds
    };

    const ratingChanges = calculateRatingChanges(calcInput);

    const ledgerValues = ratingChanges.map((rc) => ({
      player_id: rc.playerId,
      match_id: input.matchId,
      idempotency_key: `${input.matchId}:${rc.playerId}`,
      previous_rating: rc.previousRating,
      next_rating: rc.nextRating,
      delta: rc.delta,
      outcome: rc.outcome,
      expected_win_prob: rc.expectedWinProbability,
      component_result: rc.components.result,
      component_round_margin: rc.components.roundMargin,
      component_performance: rc.components.performance,
      component_placement: rc.components.placementMultiplier,
      engine_version: ENGINE_VERSION
    }));

    await tx`
      INSERT INTO rating_changes ${tx(ledgerValues)}
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    for (const rc of ratingChanges) {
      const winInc = rc.outcome === "win" ? 1 : 0;
      const lossInc = rc.outcome === "loss" ? 1 : 0;
      const drawInc = rc.outcome === "draw" ? 1 : 0;

      await tx`
        UPDATE players
        SET
          rating = ${rc.nextRating},
          matches_played = matches_played + 1,
          wins = wins + ${winInc},
          losses = losses + ${lossInc},
          draws = draws + ${drawInc},
          is_placement = (matches_played + 1) < 10,
          updated_at = NOW()
        WHERE id = ${rc.playerId}
      `;
    }

    await tx`
      UPDATE matches
      SET
        status = 'completed',
        alpha_rounds = ${input.alphaRounds},
        bravo_rounds = ${input.bravoRounds},
        ended_at = NOW()
      WHERE id = ${input.matchId}
    `;

    return {
      matchId: input.matchId,
      progression,
      changes: ratingChanges.map((rc) => ({
        playerId: rc.playerId,
        previousRating: rc.previousRating,
        nextRating: rc.nextRating,
        delta: rc.delta,
        outcome: rc.outcome
      }))
    };
  });
}
