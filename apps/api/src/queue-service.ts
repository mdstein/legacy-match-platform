import { randomUUID } from "node:crypto";
import type {
  BootstrapResponse,
  JoinQueueRequest,
  MapVetoState,
  MatchAssignment,
  QueueState,
  ReadyCheck,
  ServerEvent
} from "@aftertick/contracts";
import { getRank } from "@aftertick/rating";
import { DEATHMATCH_MAP, MAP_POOL, REGIONS } from "./catalog.js";

interface PlayerRuntime {
  queue: QueueState;
  readyCheck: ReadyCheck | null;
  mapVeto: MapVetoState | null;
  assignment: MatchAssignment | null;
  matchTimer: NodeJS.Timeout | null;
  expiryTimer: NodeJS.Timeout | null;
}

export interface QueueServiceOptions {
  autoMatchDelayMs: number | null;
  readyCheckSeconds: number;
}

export type QueueSubscriber = (event: ServerEvent) => void;
export type QueueUnsubscribe = () => void | Promise<void>;
export type Awaitable<T> = T | Promise<T>;

export interface QueueRuntime {
  queue: QueueState;
  readyCheck: ReadyCheck | null;
  mapVeto: MapVetoState | null;
  assignment: MatchAssignment | null;
}

export interface PlatformPopulation {
  onlinePlayers: number;
  competitiveQueuePlayers: number;
  deathmatchQueuePlayers: number;
}

export interface VerifiedQueueParty {
  partyId: string;
  leaderPlayerId: string;
  memberPlayerIds: string[];
}

export interface QueueServiceLike {
  getQueueRuntime(playerId: string): Awaitable<QueueRuntime>;
  getBootstrapFallback(playerId: string): Awaitable<BootstrapResponse>;
  join(request: JoinQueueRequest): Awaitable<QueueState>;
  joinVerifiedParty?(
    request: JoinQueueRequest,
    party: VerifiedQueueParty
  ): Awaitable<QueueState>;
  leave(playerId: string): Awaitable<QueueState>;
  releaseSearch(playerId: string, ticketId: string): Awaitable<boolean>;
  accept(playerId: string, matchId: string): Awaitable<ReadyCheck | MapVetoState | MatchAssignment>;
  banMap(playerId: string, matchId: string, map: string): Awaitable<MapVetoState>;
  subscribe(playerId: string, subscriber: QueueSubscriber): Awaitable<QueueUnsubscribe>;
  reset(playerId: string): Awaitable<BootstrapResponse>;
  touchPresence?(playerId: string): Awaitable<void>;
  getPlatformPopulation?(): Awaitable<PlatformPopulation>;
  close?(): Awaitable<void>;
}

export const idleQueue = (): QueueState => ({
  mode: "competitive",
  phase: "idle",
  joinedAt: null,
  regions: ["NA Central"],
  maps: [...MAP_POOL],
  playersFound: 0,
  estimatedWaitSeconds: 0,
  ratingWindow: 50
});

export class QueueService implements QueueServiceLike {
  private readonly runtimes = new Map<string, PlayerRuntime>();
  private readonly subscribers = new Map<string, Set<QueueSubscriber>>();

  constructor(
    private readonly options: QueueServiceOptions = {
      autoMatchDelayMs: 2400,
      readyCheckSeconds: 20
    }
  ) {}

  getQueueRuntime(playerId: string): QueueRuntime {
    const runtime = this.runtimeFor(playerId);
    return {
      queue: { ...runtime.queue },
      readyCheck: runtime.readyCheck
        ? { ...runtime.readyCheck, acceptedPlayerIds: [...runtime.readyCheck.acceptedPlayerIds] }
        : null,
      mapVeto: runtime.mapVeto ? structuredClone(runtime.mapVeto) : null,
      assignment: runtime.assignment ? { ...runtime.assignment } : null
    };
  }

  getBootstrapFallback(playerId: string): BootstrapResponse {
    const runtime = this.runtimeFor(playerId);
    const rating = 1000;
    const rank = getRank(rating);

    return {
      player: {
        id: playerId,
        displayName: "New Player",
        initials: "NP",
        region: "NA Central",
        rank: {
          name: rank.name,
          shortName: rank.shortName,
          rating,
          nextRank: rank.nextRank,
          nextRankFloor: rank.ceiling === null ? null : rank.ceiling + 1,
          progress: rank.progress
        },
        matchesPlayed: 0,
        winRate: 0,
        recentMatches: []
      },
      queue: { ...runtime.queue },
      readyCheck: runtime.readyCheck
        ? { ...runtime.readyCheck, acceptedPlayerIds: [...runtime.readyCheck.acceptedPlayerIds] }
        : null,
      mapVeto: runtime.mapVeto ? structuredClone(runtime.mapVeto) : null,
      assignment: runtime.assignment ? { ...runtime.assignment } : null,
      platform: {
        onlinePlayers: 1,
        activeMatches: 0,
        competitiveQueuePlayers: this.searchingPlayers("competitive"),
        deathmatchQueuePlayers: this.searchingPlayers("deathmatch"),
        deathmatchHumans: 0,
        deathmatchBots: 0,
        deathmatchCapacity: 0,
        season: "Founders Season"
      }
    };
  }

  join(request: JoinQueueRequest): QueueState {
    this.validateSelections(request);
    const runtime = this.runtimeFor(request.playerId);
    this.clearTimers(runtime);

    runtime.readyCheck = null;
    runtime.mapVeto = null;
    runtime.assignment = null;
    const mode = request.mode ?? "competitive";
    runtime.queue = {
      ticketId: randomUUID(),
      mode,
      phase: "searching",
      joinedAt: new Date().toISOString(),
      regions: [...request.regions],
      maps: mode === "deathmatch" ? [DEATHMATCH_MAP] : [...request.maps],
      playersFound: this.searchingPlayers(mode) + 1,
      estimatedWaitSeconds: 0,
      ratingWindow: 50
    };

    this.publish(request.playerId, {
      type: "queue.updated",
      payload: { ...runtime.queue }
    });

    if (this.options.autoMatchDelayMs !== null) {
      runtime.matchTimer = setTimeout(() => {
        this.createReadyCheck(request.playerId);
      }, this.options.autoMatchDelayMs);
    }

    return { ...runtime.queue };
  }

  releaseSearch(playerId: string, ticketId: string): boolean {
    const runtime = this.runtimeFor(playerId);
    if (runtime.queue.phase !== "searching" || runtime.queue.ticketId !== ticketId) return false;
    this.leave(playerId);
    return true;
  }

  leave(playerId: string): QueueState {
    const runtime = this.runtimeFor(playerId);
    this.clearTimers(runtime);
    runtime.queue = idleQueue();
    runtime.readyCheck = null;
    runtime.mapVeto = null;
    runtime.assignment = null;

    this.publish(playerId, {
      type: "queue.cancelled",
      payload: { ...runtime.queue }
    });
    return { ...runtime.queue };
  }

  accept(playerId: string, matchId: string): ReadyCheck | MapVetoState | MatchAssignment {
    const runtime = this.runtimeFor(playerId);

    if (!runtime.readyCheck || runtime.readyCheck.matchId !== matchId) {
      throw new QueueError(404, "That ready check is no longer active.");
    }

    if (new Date(runtime.readyCheck.expiresAt).getTime() <= Date.now()) {
      this.expireReadyCheck(playerId);
      throw new QueueError(409, "The ready check expired.");
    }

    if (!runtime.readyCheck.acceptedPlayerIds.includes(playerId)) {
      runtime.readyCheck.acceptedPlayerIds.push(playerId);
    }

    const readyCheck = {
      ...runtime.readyCheck,
      acceptedPlayerIds: [...runtime.readyCheck.acceptedPlayerIds]
    };
    this.publish(playerId, { type: "match.accepted", payload: readyCheck });

    if (runtime.readyCheck.acceptedPlayerIds.length === runtime.readyCheck.totalPlayers) {
      if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
      runtime.expiryTimer = null;
      const mode = runtime.readyCheck.mode ?? "competitive";
      const totalPlayers = runtime.readyCheck.totalPlayers;
      runtime.assignment = {
        mode,
        matchId,
        map: runtime.readyCheck.map,
        region: runtime.readyCheck.region,
        serverLabel: "Prototype Server · Chicago 01",
        address: "127.0.0.1:27015",
        connectUrl: "steam://connect/127.0.0.1:27015/aftertickDemoPassword123",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27015&password=aftertickDemoPassword123"
      };
      runtime.readyCheck = null;
      runtime.queue = { ...runtime.queue, phase: "assigned", playersFound: totalPlayers };
      this.publish(playerId, {
        type: "queue.updated",
        payload: { ...runtime.queue }
      });
      this.publish(playerId, {
        type: "match.assigned",
        payload: { ...runtime.assignment }
      });
      return { ...runtime.assignment };
    }

    return readyCheck;
  }

  banMap(_playerId: string, _matchId: string, _map: string): MapVetoState {
    throw new QueueError(503, "Dynamic map veto requires the durable Redis matchmaking service.");
  }

  subscribe(playerId: string, subscriber: QueueSubscriber): QueueUnsubscribe {
    const current = this.subscribers.get(playerId) ?? new Set<QueueSubscriber>();
    current.add(subscriber);
    this.subscribers.set(playerId, current);

    return () => {
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(playerId);
    };
  }

  reset(playerId: string): BootstrapResponse {
    const runtime = this.runtimeFor(playerId);
    this.clearTimers(runtime);
    this.runtimes.delete(playerId);
    return this.getBootstrapFallback(playerId);
  }

  touchPresence(_playerId: string): void {}

  getPlatformPopulation(): PlatformPopulation {
    return {
      onlinePlayers: Math.max(1, this.subscribers.size),
      competitiveQueuePlayers: this.searchingPlayers("competitive"),
      deathmatchQueuePlayers: this.searchingPlayers("deathmatch")
    };
  }

  private searchingPlayers(mode: "competitive" | "deathmatch"): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.queue.phase === "searching" && (runtime.queue.mode ?? "competitive") === mode) {
        count += 1;
      }
    }
    return count;
  }

  private runtimeFor(playerId: string): PlayerRuntime {
    const existing = this.runtimes.get(playerId);
    if (existing) return existing;

    const runtime: PlayerRuntime = {
      queue: idleQueue(),
      readyCheck: null,
      mapVeto: null,
      assignment: null,
      matchTimer: null,
      expiryTimer: null
    };
    this.runtimes.set(playerId, runtime);
    return runtime;
  }

  private createReadyCheck(playerId: string): void {
    const runtime = this.runtimeFor(playerId);
    if (runtime.queue.phase !== "searching") return;

    const matchId = randomUUID();
    const mode = runtime.queue.mode ?? "competitive";
    const mapPool = mode === "deathmatch" ? [DEATHMATCH_MAP] : [...runtime.queue.maps];
    const map = mode === "deathmatch"
      ? DEATHMATCH_MAP
      : mapPool[0] ?? "Mirage";
    const region = runtime.queue.regions[0] ?? "NA Central";
    const totalPlayers = mode === "deathmatch" ? 14 : 10;
    const acceptedPlayerIds = Array.from({ length: totalPlayers - 1 }, (_, i) => `sim-${i + 1}`);

    runtime.queue = { ...runtime.queue, phase: "ready-check", playersFound: totalPlayers };
    runtime.readyCheck = {
      mode,
      matchId,
      expiresAt: new Date(Date.now() + this.options.readyCheckSeconds * 1000).toISOString(),
      acceptedPlayerIds,
      totalPlayers,
      map,
      mapPool,
      region
    };
    runtime.matchTimer = null;

    this.publish(playerId, { type: "queue.updated", payload: { ...runtime.queue } });
    this.publish(playerId, {
      type: "match.found",
      payload: { ...runtime.readyCheck, acceptedPlayerIds: [...acceptedPlayerIds] }
    });

    runtime.expiryTimer = setTimeout(() => {
      this.expireReadyCheck(playerId);
    }, this.options.readyCheckSeconds * 1000 + 50);
  }

  private expireReadyCheck(playerId: string): void {
    const runtime = this.runtimeFor(playerId);
    this.clearTimers(runtime);
    runtime.queue = idleQueue();
    runtime.readyCheck = null;
    runtime.mapVeto = null;
    runtime.assignment = null;
    this.publish(playerId, { type: "queue.cancelled", payload: { ...runtime.queue } });
  }

  private publish(playerId: string, event: ServerEvent): void {
    this.subscribers.get(playerId)?.forEach((sub) => sub(event));
  }

  private validateSelections(request: JoinQueueRequest): void {
    const mode = request.mode ?? "competitive";
    if (request.regions.length === 0 || (mode === "competitive" && request.maps.length === 0)) {
      throw new QueueError(
        400,
        mode === "competitive" ? "Choose at least one region and one map." : "Choose at least one region."
      );
    }
    if (request.regions.some((r) => !(REGIONS as readonly string[]).includes(r))) {
      throw new QueueError(400, "Unknown region.");
    }
    if (mode === "competitive" && request.maps.some((m) => !(MAP_POOL as readonly string[]).includes(m))) {
      throw new QueueError(400, "Unknown map.");
    }
  }

  private clearTimers(runtime: PlayerRuntime): void {
    if (runtime.matchTimer) clearTimeout(runtime.matchTimer);
    if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
    runtime.matchTimer = null;
    runtime.expiryTimer = null;
  }
}

export class QueueError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
