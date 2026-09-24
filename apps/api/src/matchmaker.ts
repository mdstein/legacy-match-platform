import { randomInt, randomUUID } from "node:crypto";
import type { GameMode, MatchAssignment, ReadyCheck } from "@aftertick/contracts";
import { DEATHMATCH_MAP, MAP_POOL } from "./catalog.js";
import type { ReadyCheckPlan, RedisQueueService, RedisQueueTicket } from "./redis-queue-service.js";

export type ModerationBand = "normal" | "restricted";

export interface MatchmakingPlayer {
  playerId: string;
  steamId: string;
  rating: number;
  uncertainty: number;
  moderationBand: ModerationBand;
  regionPings: Record<string, number>;
}

export interface MatchmakingTicket {
  id: string;
  fencingToken: number;
  joinedAt: string;
  mode: GameMode;
  regions: string[];
  maps: string[];
  players: MatchmakingPlayer[];
  source: RedisQueueTicket;
}

export interface MatchQuality {
  score: number;
  predictedAlphaWin: number;
  ratingDifference: number;
  pingSpread: number;
  maxPing: number;
  stackImbalance: number;
  oldestWaitSeconds: number;
  ratingWindow: number;
  pingLimit: number;
}

export interface MatchPlan {
  mode: GameMode;
  tickets: MatchmakingTicket[];
  alphaPlayerIds: string[];
  bravoPlayerIds: string[];
  map: string;
  mapPool: string[];
  region: string;
  quality: MatchQuality;
}

export type MatchmakingProfileResolver = (
  playerIds: string[]
) => Promise<Map<string, MatchmakingPlayer>>;

export interface RedisMatchmakerOptions {
  readyCheckSeconds?: number | undefined;
  /**
   * `client-selection` preserves the maps selected in Panorama, chooses one
   * before ready check, and moves straight to allocation after all ten accept.
   * The legacy captain-veto path remains available for rollback and tests.
   */
  competitiveMapSelection?: "captain-veto" | "client-selection" | undefined;
  assignment?: Omit<MatchAssignment, "matchId" | "map" | "region"> | undefined;
  prepareMatch?: ((plan: MatchPlan, matchId: string) => Promise<{
    assignment: Omit<MatchAssignment, "matchId" | "map" | "region">;
    abort?: (() => Promise<void>) | undefined;
  }>) | undefined;
  reserveMatch?: ((plan: MatchPlan, matchId: string) => Promise<{
    abort: () => Promise<void>;
  }>) | undefined;
  randomIndex?: ((upperBound: number) => number) | undefined;
}

export const MATCH_SIZE: Record<GameMode, number> = {
  competitive: 10,
  deathmatch: 14
};

function captainFor(players: MatchmakingPlayer[]): string {
  const captain = [...players].sort(
    (left, right) => right.rating - left.rating || left.playerId.localeCompare(right.playerId)
  )[0];
  if (!captain) throw new Error("A map-veto team has no captain.");
  return captain.playerId;
}

function chooseClientSelectedMap(
  plan: MatchPlan,
  randomIndex: (upperBound: number) => number
): MatchPlan {
  const index = randomIndex(plan.mapPool.length);
  if (!Number.isInteger(index) || index < 0 || index >= plan.mapPool.length) {
    throw new Error("The Competitive map selector returned an invalid index.");
  }
  const map = plan.mapPool[index]!;
  return { ...plan, map, mapPool: [map] };
}

function intersection(values: string[][]): string[] {
  if (values.length === 0) return [];
  const rest = values.slice(1).map((items) => new Set(items));
  return values[0]!.filter((value) => rest.every((set) => set.has(value)));
}

function waitSeconds(ticket: MatchmakingTicket, now: number): number {
  return Math.max(0, Math.floor((now - new Date(ticket.joinedAt).getTime()) / 1000));
}

function stackImbalance(alpha: MatchmakingTicket[], bravo: MatchmakingTicket[]): number {
  const left = alpha.map((ticket) => ticket.players.length).sort((a, b) => b - a);
  const right = bravo.map((ticket) => ticket.players.length).sort((a, b) => b - a);
  const width = Math.max(left.length, right.length);
  let difference = 0;
  for (let index = 0; index < width; index += 1) {
    difference += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return difference;
}

function chooseTeams(tickets: MatchmakingTicket[]): {
  alpha: MatchmakingTicket[];
  bravo: MatchmakingTicket[];
  ratingDifference: number;
  predictedAlphaWin: number;
  stackImbalance: number;
} | null {
  let best: ReturnType<typeof chooseTeams> = null;
  const alpha: MatchmakingTicket[] = [];
  const bravo: MatchmakingTicket[] = [];

  function visit(index: number, alphaSize: number, bravoSize: number): void {
    if (alphaSize > 5 || bravoSize > 5) return;
    if (index === tickets.length) {
      if (alphaSize !== 5 || bravoSize !== 5) return;
      const alphaPlayers = alpha.flatMap((ticket) => ticket.players);
      const bravoPlayers = bravo.flatMap((ticket) => ticket.players);
      const alphaRating = alphaPlayers.reduce((sum, player) => sum + player.rating, 0) / 5;
      const bravoRating = bravoPlayers.reduce((sum, player) => sum + player.rating, 0) / 5;
      const ratingDifference = Math.abs(alphaRating - bravoRating);
      const predictedAlphaWin = 1 / (1 + 10 ** ((bravoRating - alphaRating) / 400));
      const stacks = stackImbalance(alpha, bravo);
      const candidate = {
        alpha: [...alpha],
        bravo: [...bravo],
        ratingDifference,
        predictedAlphaWin,
        stackImbalance: stacks
      };
      const candidateScore = ratingDifference + stacks * 35;
      const bestScore = best ? best.ratingDifference + best.stackImbalance * 35 : Infinity;
      if (
        candidateScore < bestScore
        || (
          candidateScore === bestScore
          && candidate.alpha.map((ticket) => ticket.id).join(":")
            < (best?.alpha.map((ticket) => ticket.id).join(":") ?? "")
        )
      ) {
        best = candidate;
      }
      return;
    }

    const ticket = tickets[index]!;
    alpha.push(ticket);
    visit(index + 1, alphaSize + ticket.players.length, bravoSize);
    alpha.pop();
    bravo.push(ticket);
    visit(index + 1, alphaSize, bravoSize + ticket.players.length);
    bravo.pop();
  }

  visit(0, 0, 0);
  return best;
}

function evaluateCompetitive(tickets: MatchmakingTicket[], now: number): MatchPlan | null {
  if (tickets.some((ticket) => ticket.mode !== "competitive")) return null;
  const players = tickets.flatMap((ticket) => ticket.players);
  if (players.length !== 10 || new Set(players.map((player) => player.playerId)).size !== 10) {
    return null;
  }

  const commonMaps = intersection(tickets.map((ticket) => ticket.maps));
  const maps = MAP_POOL.filter((map) => commonMaps.includes(map));
  const regions = intersection(tickets.map((ticket) => ticket.regions));
  if (maps.length === 0 || regions.length === 0) return null;

  const oldestWaitSeconds = Math.max(...tickets.map((ticket) => waitSeconds(ticket, now)));
  const ratingWindow = Math.min(400, 100 + Math.floor(oldestWaitSeconds / 60) * 50);
  const pingLimit = Math.min(110, 70 + Math.floor(oldestWaitSeconds / 60) * 5);
  const ratings = players.map((player) => player.rating);
  if (Math.max(...ratings) - Math.min(...ratings) > ratingWindow) return null;

  const fiveStacks = tickets.filter((ticket) => ticket.players.length === 5).length;
  if (fiveStacks === 1 && oldestWaitSeconds < 180) return null;

  const moderationBands = new Set(players.map((player) => player.moderationBand));
  if (moderationBands.size > 1 && oldestWaitSeconds < 300) return null;

  const regionOptions = regions
    .map((region) => {
      const pings = players.map((player) => player.regionPings[region] ?? Infinity);
      return {
        region,
        pings,
        maxPing: Math.max(...pings),
        averagePing: pings.reduce((sum, ping) => sum + ping, 0) / pings.length
      };
    })
    .filter((option) => Number.isFinite(option.maxPing) && option.maxPing <= pingLimit)
    .sort((a, b) => a.maxPing - b.maxPing || a.averagePing - b.averagePing || a.region.localeCompare(b.region));
  const region = regionOptions[0];
  if (!region) return null;

  const teams = chooseTeams(tickets);
  if (!teams) return null;
  const pingSpread = region.maxPing - Math.min(...region.pings);
  const uncertainty = players.reduce((sum, player) => sum + player.uncertainty, 0) / 10;
  const score =
    Math.abs(teams.predictedAlphaWin - 0.5) * 1000
    + pingSpread * 2
    + teams.stackImbalance * 35
    + uncertainty * 0.02;

  return {
    mode: "competitive",
    tickets: [...tickets],
    alphaPlayerIds: teams.alpha.flatMap((ticket) => ticket.players.map((player) => player.playerId)),
    bravoPlayerIds: teams.bravo.flatMap((ticket) => ticket.players.map((player) => player.playerId)),
    map: maps[0]!,
    mapPool: [...maps],
    region: region.region,
    quality: {
      score,
      predictedAlphaWin: teams.predictedAlphaWin,
      ratingDifference: teams.ratingDifference,
      pingSpread,
      maxPing: region.maxPing,
      stackImbalance: teams.stackImbalance,
      oldestWaitSeconds,
      ratingWindow,
      pingLimit
    }
  };
}

function evaluateDeathmatch(tickets: MatchmakingTicket[], now: number): MatchPlan | null {
  if (tickets.some((ticket) => ticket.mode !== "deathmatch")) return null;
  const players = tickets.flatMap((ticket) => ticket.players);
  if (
    players.length !== MATCH_SIZE.deathmatch
    || new Set(players.map((player) => player.playerId)).size !== MATCH_SIZE.deathmatch
  ) {
    return null;
  }

  const regions = intersection(tickets.map((ticket) => ticket.regions));
  if (regions.length === 0) return null;
  const oldestWaitSeconds = Math.max(...tickets.map((ticket) => waitSeconds(ticket, now)));
  const pingLimit = Math.min(110, 70 + Math.floor(oldestWaitSeconds / 60) * 5);
  const moderationBands = new Set(players.map((player) => player.moderationBand));
  if (moderationBands.size > 1 && oldestWaitSeconds < 300) return null;

  const regionOptions = regions
    .map((region) => {
      const pings = players.map((player) => player.regionPings[region] ?? Infinity);
      return {
        region,
        pings,
        maxPing: Math.max(...pings),
        averagePing: pings.reduce((sum, ping) => sum + ping, 0) / pings.length
      };
    })
    .filter((option) => Number.isFinite(option.maxPing) && option.maxPing <= pingLimit)
    .sort((a, b) => a.maxPing - b.maxPing || a.averagePing - b.averagePing || a.region.localeCompare(b.region));
  const region = regionOptions[0];
  if (!region) return null;

  const pingSpread = region.maxPing - Math.min(...region.pings);
  const uncertainty = players.reduce((sum, player) => sum + player.uncertainty, 0) / players.length;
  return {
    mode: "deathmatch",
    tickets: [...tickets],
    alphaPlayerIds: [],
    bravoPlayerIds: [],
    map: DEATHMATCH_MAP,
    mapPool: [DEATHMATCH_MAP],
    region: region.region,
    quality: {
      score: pingSpread * 2 + uncertainty * 0.02,
      predictedAlphaWin: 0.5,
      ratingDifference: 0,
      pingSpread,
      maxPing: region.maxPing,
      stackImbalance: 0,
      oldestWaitSeconds,
      ratingWindow: 0,
      pingLimit
    }
  };
}

function evaluate(tickets: MatchmakingTicket[], now: number, mode: GameMode): MatchPlan | null {
  return mode === "deathmatch"
    ? evaluateDeathmatch(tickets, now)
    : evaluateCompetitive(tickets, now);
}

export function findMatch(
  tickets: MatchmakingTicket[],
  now = Date.now(),
  combinationLimit = 5_000,
  randomIndex: (upperBound: number) => number = (upperBound) => randomInt(upperBound)
): MatchPlan | null {
  const plans: MatchPlan[] = [];
  for (const mode of ["competitive", "deathmatch"] as const) {
    const sorted = tickets.filter((ticket) => ticket.mode === mode).sort(
      (a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime() || a.id.localeCompare(b.id)
    );
    const anchor = sorted[0];
    if (!anchor) continue;
    const targetSize = MATCH_SIZE[mode];
    const candidates = sorted.slice(0, mode === "deathmatch" ? 30 : 25);
    const selected: MatchmakingTicket[] = [anchor];
    let visited = 0;
    let best: MatchPlan | null = null;

    function visit(index: number, size: number): void {
      if (visited >= combinationLimit || size > targetSize) return;
      if (size === targetSize) {
        visited += 1;
        const plan = evaluate(selected, now, mode);
        if (
          plan
          && (
            !best
            || plan.quality.score < best.quality.score
            || (
              plan.quality.score === best.quality.score
              && plan.tickets.map((ticket) => ticket.id).join(":")
                < best.tickets.map((ticket) => ticket.id).join(":")
            )
          )
        ) {
          best = plan;
        }
        return;
      }
      for (let candidateIndex = index; candidateIndex < candidates.length; candidateIndex += 1) {
        const ticket = candidates[candidateIndex]!;
        if (ticket === anchor) continue;
        selected.push(ticket);
        visit(candidateIndex + 1, size + ticket.players.length);
        selected.pop();
      }
    }

    visit(1, anchor.players.length);
    if (best) plans.push(best);
  }

  const selectedPlan = plans.sort((left, right) => {
    const leftJoined = Math.min(...left.tickets.map((ticket) => new Date(ticket.joinedAt).getTime()));
    const rightJoined = Math.min(...right.tickets.map((ticket) => new Date(ticket.joinedAt).getTime()));
    return leftJoined - rightJoined || left.quality.score - right.quality.score;
  })[0];
  if (!selectedPlan) return null;
  if (selectedPlan.mode === "deathmatch") {
    return selectedPlan;
  }
  return selectedPlan;
}

export class RedisMatchmaker {
  constructor(
    private readonly queue: RedisQueueService,
    private readonly resolveProfiles: MatchmakingProfileResolver,
    private readonly options: RedisMatchmakerOptions
  ) {}

  async runOnce(now = Date.now()): Promise<ReadyCheck | null> {
    return this.queue.runMatchmakerExclusive(() => this.runOnceUnlocked(now));
  }

  private async runOnceUnlocked(now: number): Promise<ReadyCheck | null> {
    // Drop-in Deathmatch tickets are claimed synchronously by the session
    // allocator. The batch matchmaker remains strictly Competitive-only.
    const tickets = (await this.queue.listSearchingTickets()).filter(
      (ticket) => (ticket.queue.mode ?? "competitive") === "competitive"
    );
    if (tickets.reduce((sum, ticket) => sum + ticket.memberPlayerIds.length, 0) < MATCH_SIZE.competitive) {
      return null;
    }
    const playerIds = [...new Set(tickets.flatMap((ticket) => ticket.memberPlayerIds))];
    const profiles = await this.resolveProfiles(playerIds);
    const candidates = tickets.flatMap((ticket): MatchmakingTicket[] => {
      const joinedAt = ticket.queue.joinedAt;
      const players = ticket.memberPlayerIds.map((playerId) => profiles.get(playerId));
      if (!joinedAt || players.some((player) => !player)) return [];
      return [{
        id: ticket.id,
        fencingToken: ticket.fencingToken,
        joinedAt,
        mode: ticket.queue.mode ?? "competitive",
        regions: ticket.queue.regions,
        maps: ticket.queue.maps,
        players: players as MatchmakingPlayer[],
        source: ticket
      }];
    });
    const matchedPlan = findMatch(candidates, now, 5_000, this.options.randomIndex);
    if (!matchedPlan) return null;
    const plan = matchedPlan.mode === "competitive"
      && this.options.competitiveMapSelection === "client-selection"
      ? chooseClientSelectedMap(
          matchedPlan,
          this.options.randomIndex ?? ((upperBound) => randomInt(upperBound))
        )
      : matchedPlan;
    const matchId = randomUUID();
    const reserved = plan.mode === "competitive" && this.options.reserveMatch
      ? await this.options.reserveMatch(plan, matchId)
      : null;
    const prepared = reserved
      ? null
      : this.options.prepareMatch
        ? await this.options.prepareMatch(plan, matchId)
        : this.options.assignment
          ? { assignment: this.options.assignment }
          : null;
    if (!reserved && !prepared) throw new Error("The matchmaker has no match reservation or server assignment provider.");
    try {
      return await this.queue.createReadyCheck({
        matchId,
        mode: plan.mode,
        tickets: plan.tickets.map((ticket) => ticket.source),
        map: plan.map,
        mapPool: plan.mapPool,
        region: plan.region,
        durationSeconds: this.options.readyCheckSeconds ?? 20,
        ...(reserved ? {
          veto: {
            captains: {
              alpha: captainFor(plan.tickets
                .flatMap((ticket) => ticket.players)
                .filter((player) => plan.alphaPlayerIds.includes(player.playerId))),
              bravo: captainFor(plan.tickets
                .flatMap((ticket) => ticket.players)
                .filter((player) => plan.bravoPlayerIds.includes(player.playerId)))
            },
            mapPool: plan.mapPool,
            turnSeconds: 30
          }
        } : {
          assignment: {
            ...prepared!.assignment,
            mode: plan.mode,
            map: plan.map,
            region: plan.region
          }
        })
      });
    } catch (error) {
      await reserved?.abort();
      await prepared?.abort?.();
      throw error;
    }
  }
}
