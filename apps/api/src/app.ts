import type { Server } from "node:http";
import { LAUNCHER_CONTENT } from "@aftertick/contracts";
import type {
  BootstrapResponse,
  LauncherBootstrapResponse,
  LauncherClientContent,
  LauncherPlayerProfilesResponse,
  PartyState
} from "@aftertick/contracts";
import type { Sql } from "@aftertick/db";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Store as RateLimitStore } from "express-rate-limit";
import type { Store as SessionStore } from "express-session";
import { z } from "zod";
import { RANKS } from "@aftertick/rating";
import { requireAuth } from "./auth/middleware.js";
import { createSessionMiddleware } from "./auth/session.js";
import { buildAuthRoutes, type AuthRouteDeps } from "./auth/steam.js";
import type { DemoIngestionService } from "./demo-ingestion-service.js";
import type { DeathmatchDropInService } from "./deathmatch-drop-in-service.js";
import { PartyError, PartyService, type PartyServiceLike } from "./party-service.js";
import {
  MatchIngestionError,
  type MatchIngestionService
} from "./match-ingestion-service.js";
import {
  NodeAuthenticationError,
  type NodeControlService
} from "./node-control-service.js";
import {
  LatencyProbeError,
  type LatencyProbeService
} from "./latency-probe-service.js";
import { MatchRecoveryService } from "./match-recovery-service.js";
import { playerService, type PlayerReadService } from "./player-service.js";
import { OperationsService, PlatformAccessError } from "./operations-service.js";
import { createObservability, type Observability } from "./observability.js";
import {
  QueueError,
  QueueService,
  type QueueServiceLike,
  type VerifiedQueueParty
} from "./queue-service.js";
import { createRateLimiter, csrfToken, requireCsrf } from "./security.js";
import { InventoryError, type InventoryService } from "./inventory-service.js";
import { ServiceMedalError, type ServiceMedalService } from "./service-medal-service.js";
import { TradingError } from "./trading-service.js";
import { registerTradingRoutes, type TradingServiceLike } from "./trading-routes.js";
import { registerFriendsRoutes, type FriendsServiceLike } from "./friends-routes.js";
import { FriendsService } from "./friends-service.js";
import {
  LauncherDeviceError,
  type LauncherDeviceServiceLike
} from "./launcher-device-service.js";

const joinSchema = z.object({
  regions: z.array(z.string()).min(1),
  maps: z.array(z.string()),
  mode: z.enum(["competitive", "deathmatch"]).default("competitive")
});
const launcherJoinSchema = joinSchema.extend({
  nativeParty: z.object({
    steamLobbyId: z.string().regex(/^\d{17,20}$/),
    memberSteamIds: z.array(z.string().regex(/^\d{17}$/)).min(2).max(5)
      .refine((ids) => new Set(ids).size === ids.length, "Steam party members must be unique.")
  }).strict().optional()
}).strict();
const launcherPlayerProfilesSchema = z.object({
  accountIds: z.array(z.number().int().min(1).max(4_294_967_295)).min(1).max(16)
    .refine((ids) => new Set(ids).size === ids.length, "Player profile accounts must be unique.")
}).strict();
const launcherCaseOpenSchema = z.object({
  caseAssetId: z.string().regex(/^\d{1,20}$/),
  keyAssetId: z.string().regex(/^\d{1,20}$/).optional()
}).strict();
const launcherTradeUpSchema = z.object({
  inputAssetIds: z.array(z.string().regex(/^\d{1,20}$/)).length(10)
    .refine((ids) => new Set(ids).size === ids.length, "Trade Up inputs must be unique.")
}).strict();
const ownershipGenerationSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/)
  .refine(value => value.length<19 || value<="9223372036854775807", "Invalid ownership generation.");
const launcherLoadoutSyncSchema = z.object({
  assetIds: z.array(z.string().regex(/^\d{1,20}$/)).max(64)
    .refine((ids) => new Set(ids).size === ids.length, "Loadout items must be unique."),
  ownershipGenerations: z.record(z.string().regex(/^\d{1,20}$/),ownershipGenerationSchema).optional()
}).strict();
const launcherAcknowledgementSchema = z.object({
  positions: z.array(z.object({
    assetId: z.string().regex(/^\d{1,20}$/),
    position: z.number().int().min(0).max(1_073_741_823),
    ownershipGeneration: ownershipGenerationSchema.optional()
  }).strict()).max(512)
}).strict();
const launcherItemRenameSchema = z.object({
  assetId: z.string().regex(/^\d{1,20}$/),
  customName: z.string().max(100).refine(
    (name) => ![...name].some((character) => character < " " || character === "\u007f"),
    "Item names cannot contain control characters."
  )
}).strict();
const launcherSpraySchema = z.object({
  assetId: z.string().regex(/^\d{1,20}$/)
}).strict();
const ingameNameSchema = z.string().trim().min(3).max(20).regex(
  /^[A-Za-z0-9_-]+$/,
  "In-game names may use letters, numbers, underscores, and hyphens."
);
const regionSchema = z.enum(["NA Central", "NA East", "NA West", "EU Central"]);
const onboardingSchema = z.object({ displayName: ingameNameSchema, region: regionSchema }).strict();
const accountSettingsSchema = z.object({
  region: regionSchema,
  preferredMode: z.enum(["competitive", "deathmatch"]),
  profileVisibility: z.enum(["public", "players", "private"]),
  allowPartyInvites: z.boolean(),
  matchNotifications: z.boolean(),
  productUpdates: z.boolean(),
  reducedMotion: z.boolean()
}).strict();
const cosmeticLoadoutSchema = z.object({
  selections: z.array(z.object({
    weaponKey: z.string().regex(/^[a-z0-9_]{2,32}$/),
    assetId: z.string().regex(/^\d{1,20}$/)
  }).strict()).max(64)
}).strict();
const mapVetoSchema = z.object({ map: z.string().trim().min(1).max(64) });
const partyPlayerSchema = z.object({ playerId: z.string().trim().min(1).max(128) });
const partyReadySchema = z.object({ ready: z.boolean() });
const reportCategorySchema = z.enum(["cheating", "griefing", "toxicity", "smurfing", "platform_abuse"]);
const reportStatusSchema = z.enum(["pending", "under_review", "resolved", "dismissed"]);
const sanctionTypeSchema = z.enum(["cooldown", "warning", "temp_ban", "perm_ban"]);
const appealStatusSchema = z.enum(["pending", "upheld", "reduced", "overturned"]);
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0)
});
const createReportSchema = z.object({
  reportedId: z.string().uuid(),
  matchId: z.string().uuid(),
  category: reportCategorySchema,
  description: z.string().trim().min(1).max(2_000).nullable().default(null)
});
const reviewReportSchema = z.object({
  status: z.enum(["under_review", "resolved", "dismissed"]),
  resolution: z.string().trim().min(1).max(2_000).nullable().default(null)
});
const createSanctionSchema = z.object({
  playerId: z.string().uuid(),
  sanctionType: sanctionTypeSchema,
  reason: z.string().trim().min(3).max(2_000),
  durationMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
  reportId: z.string().uuid().nullable().default(null),
  matchId: z.string().uuid().nullable().default(null)
});
const createAppealSchema = z.object({ statement: z.string().trim().min(10).max(4_000) });
const resolveAppealSchema = z.object({
  status: z.enum(["upheld", "reduced", "overturned"]),
  resolution: z.string().trim().min(3).max(2_000),
  newDurationMinutes: z.number().int().min(1).max(525_600).nullable().default(null)
});
const controlsSchema = z.object({
  version: z.number().int().positive(),
  registrationEnabled: z.boolean(),
  queueEnabled: z.boolean(),
  serverAllocationEnabled: z.boolean(),
  userMessage: z.string().trim().min(1).max(500).nullable()
});
const roleSchema = z.object({ role: z.enum(["player", "moderator", "admin"]) });
const recoveryStatusSchema = z.enum(["open", "resolving", "resolved"]);
const resolveRecoverySchema = z.object({
  action: z.enum(["remake", "void"]),
  note: z.string().trim().min(3).max(2_000)
});
const nodeHeartbeatSchema = z.object({
  agentVersion: z.string().trim().min(1).max(128),
  capacityTotal: z.number().int().min(0).max(256),
  deferTerminalDrain: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
  instances: z.array(z.object({
    instanceKey: z.string().trim().min(1).max(128),
    state: z.enum(["starting", "ready", "draining", "offline"]),
    address: z.string().trim().min(1).max(256),
    gamePort: z.number().int().min(1).max(65_535),
    gotvPort: z.number().int().min(1).max(65_535).optional(),
    processId: z.number().int().positive().optional(),
    serverBuildId: z.string().trim().max(128).optional(),
    pluginVersion: z.string().trim().max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })).max(256)
});
const nodeAckSchema = z.object({
  claimToken: z.string().uuid(),
  succeeded: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional()
});
const matchEventBatchSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.string().regex(/^\d+$/),
  events: z.array(z.object({
    eventId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    occurredAt: z.string().datetime(),
    type: z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    round: z.number().int().min(0).max(100).optional(),
    tick: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    payload: z.record(z.string(), z.unknown())
  })).min(1).max(100)
});
const nonnegativeStat = z.number().min(0).max(100_000);
const matchResultSchema = z.object({
  resultVersion: z.literal(1),
  resultId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  leaseId: z.string().uuid(),
  fencingToken: z.string().regex(/^\d+$/),
  alphaRounds: z.number().int().min(0).max(60),
  bravoRounds: z.number().int().min(0).max(60),
  reason: z.enum(["completed", "surrender", "forfeit"]),
  completedAt: z.string().datetime(),
  stats: z.array(z.object({
    steamId: z.string().regex(/^\d{17}$/),
    kills: nonnegativeStat.int(),
    deaths: nonnegativeStat.int(),
    assists: nonnegativeStat.int(),
    adr: nonnegativeStat,
    kast: z.number().min(0).max(100),
    openingKills: nonnegativeStat.int(),
    openingDeaths: nonnegativeStat.int(),
    trades: nonnegativeStat.int(),
    clutches: nonnegativeStat.int(),
    flashAssists: nonnegativeStat.int(),
    utilityDamage: nonnegativeStat.int(),
    roundsPlayed: z.number().int().min(1).max(120)
  })).min(1).max(14)
});
const demoUploadSchema = z.object({
  demoVersion: z.literal(1),
  leaseId: z.string().uuid(),
  fencingToken: z.string().regex(/^\d+$/),
  objectKey: z.string().regex(/^matches\/[a-f0-9-]{36}\/gotv\.dem$/i),
  sizeBytes: z.number().int().positive().max(2_147_483_648),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
const latencyProbeChallengeSchema = z.object({
  regions: z.array(z.string()).min(1).max(8)
});
const latencyProbeSubmissionSchema = z.object({
  version: z.literal(1),
  challengeId: z.string().uuid(),
  measurements: z.array(z.object({
    region: z.string().trim().min(1).max(64),
    server: z.string().trim().min(3).max(256),
    requestedSamples: z.number().int().min(1).max(10),
    successfulSamples: z.number().int().min(0).max(10),
    medianMs: z.number().min(0).max(5_000).nullable(),
    p95Ms: z.number().min(0).max(5_000).nullable(),
    packetLossPercent: z.number().min(0).max(100)
  })).min(1).max(8)
}).strict();
const launcherAuthorizationSchema = z.object({
  deviceCode: z.string().regex(/^[a-f0-9]{64}$/i),
  deviceName: z.string().trim().min(1).max(80).optional()
}).strict();
const launcherApprovalSchema = z.object({
  userCode: z.string().trim().regex(/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i)
}).strict();

const defaultLauncherContent: LauncherClientContent = LAUNCHER_CONTENT;

function bearerToken(req: Request): string {
  const authorization = req.get("Authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match?.[1]) throw new NodeAuthenticationError("Missing node credentials.");
  return match[1];
}

function latencyProbeToken(req: Request): string {
  const authorization = req.get("Authorization");
  const match = authorization?.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!match?.[1]) throw new LatencyProbeError(401, "Invalid latency challenge.");
  return match[1].toLowerCase();
}

function launcherInventoryToken(req: Request): string {
  const authorization = req.get("Authorization");
  const match = authorization?.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!match?.[1]) throw new InventoryError(401, "Invalid launcher inventory grant.");
  return match[1].toLowerCase();
}

function launcherAccessToken(req: Request): string {
  const authorization = req.get("Authorization");
  const match = authorization?.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!match?.[1]) throw new LauncherDeviceError(401, "Invalid launcher credentials.");
  return match[1].toLowerCase();
}

function operationsService(deps: AppDeps): OperationsService {
  if (!deps.operations) throw new PlatformAccessError(503, "Platform operations are unavailable.");
  return deps.operations;
}

function recoveryService(deps: AppDeps): MatchRecoveryService {
  if (!deps.matchRecovery) throw new PlatformAccessError(503, "Match recovery is unavailable.");
  return deps.matchRecovery;
}

function withSessionIdentity(
  bootstrap: BootstrapResponse,
  displayName: string | undefined
): BootstrapResponse {
  if (!displayName) return bootstrap;

  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "ST";

  return {
    ...bootstrap,
    player: {
      ...bootstrap.player,
      displayName,
      initials
    }
  };
}

export interface AppDeps {
  sql?: Sql | undefined;
  playerReads?: PlayerReadService | undefined;
  operations?: OperationsService | undefined;
  matchRecovery?: MatchRecoveryService | undefined;
  bootstrapAdminSteamId?: string | undefined;
  observability?: Observability | undefined;
  metricsToken?: string | undefined;
  metricsSnapshot?: (() => Promise<Record<string, number>>) | undefined;
  queueService?: QueueServiceLike | undefined;
  deathmatchDropIn?: DeathmatchDropInService | undefined;
  partyService?: PartyServiceLike | undefined;
  nodeControl?: NodeControlService | undefined;
  matchIngestion?: MatchIngestionService | undefined;
  demoIngestion?: DemoIngestionService | undefined;
  latencyProbes?: Pick<
    LatencyProbeService,
    "issue" | "submit" | "status" | "assertFresh" | "regions"
  > | undefined;
  inventory?: Pick<InventoryService, "view" | "refresh" | "saveLoadout">
    & Partial<Pick<
      InventoryService,
      "launcherBundle" | "launcherAccountBundle" | "openB2GCase" | "tradeUpB2G"
        | "syncLauncherLoadout" | "acknowledgeB2GItems" | "renameB2GItem"
        | "unsealB2GGraffiti" | "consumeB2GGraffiti"
    >> | undefined;
  launcherDevices?: LauncherDeviceServiceLike | undefined;
  serviceMedals?: Pick<ServiceMedalService, "preview" | "redeem"> | undefined;
  trading?: TradingServiceLike | undefined;
  friends?: FriendsServiceLike | undefined;
  launcherContent?: LauncherClientContent | undefined;
  auth?: Pick<AuthRouteDeps, "verifyLogin" | "loadProfile"> | undefined;
  devIdentity?: {
    playerId: string;
    steamId: string;
    displayName: string;
  } | undefined;
  testIdentity?: {
    secret: string;
    resolve(playerId: string): Promise<{
      steamId: string;
      displayName: string;
    } | null>;
  } | undefined;
  session?: {
    store?: SessionStore | undefined;
    secret?: string | undefined;
    secureCookies?: boolean | undefined;
  } | undefined;
  allowedOrigins?: string[] | undefined;
  rateLimits?: {
    windowMs: number;
    apiLimit: number;
    authLimit: number;
    apiStore?: RateLimitStore | undefined;
    authStore?: RateLimitStore | undefined;
    nodeStore?: RateLimitStore | undefined;
    nodeLimit?: number | undefined;
  } | undefined;
  readiness?: (() => Promise<{
    ready: boolean;
    checks: Record<string, { status: "ok" | "disabled" | "error"; latencyMs?: number }>;
  }>) | undefined;
}

async function platformSnapshot(
  deps: AppDeps,
  service: QueueServiceLike,
  playerId: string
): Promise<BootstrapResponse["platform"]> {
  await service.touchPresence?.(playerId);
  const population = await service.getPlatformPopulation?.() ?? {
    onlinePlayers: 1,
    competitiveQueuePlayers: 0,
    deathmatchQueuePlayers: 0
  };
  let activeMatches = 0;
  let deathmatchHumans = 0;
  let deathmatchBots = 0;
  let deathmatchCapacity = 0;
  let season = "Founders Season";
  if (deps.sql) {
    const [stats] = await deps.sql<{
      active_matches: number;
      deathmatch_humans: number;
      deathmatch_sessions: number;
      ready_instances: number;
      season_name: string | null;
    }[]>`
      with active_deathmatches as (
        select match.id
        from matches match
        join server_leases lease on lease.match_id = match.id
        where match.mode = 'deathmatch'
          and match.status in ('pending', 'live')
          and lease.status = 'active'
          and lease.expires_at > now()
      )
      select
        (select count(*)::int from matches match
          where match.status = 'live'
            or (
              match.status = 'pending'
              and exists (
                select 1 from server_leases lease
                where lease.match_id = match.id and lease.status = 'active'
                  and lease.expires_at > now()
              )
            )) as active_matches,
        (select count(*)::int from match_player_presence presence
          where presence.match_id in (select id from active_deathmatches)
            and presence.connected = true) as deathmatch_humans,
        (select count(*)::int from active_deathmatches) as deathmatch_sessions,
        (select count(*)::int from server_instances instance
          join game_nodes node on node.id = instance.node_id
          where instance.state = 'ready' and node.status = 'active'
            and instance.last_heartbeat_at > now() - interval '15 seconds'
            and node.last_heartbeat_at > now() - interval '15 seconds') as ready_instances,
        (select name from seasons where is_active = true order by starts_at desc limit 1) as season_name
    `;
    if (stats) {
      activeMatches = stats.active_matches;
      deathmatchHumans = stats.deathmatch_humans;
      deathmatchBots = Math.max(0, stats.deathmatch_sessions * 14 - deathmatchHumans);
      deathmatchCapacity = (stats.deathmatch_sessions + stats.ready_instances) * 14;
      season = stats.season_name ?? season;
    }
  }
  const controls = deps.operations ? await deps.operations.getControls() : undefined;
  return {
    onlinePlayers: population.onlinePlayers,
    activeMatches,
    competitiveQueuePlayers: population.competitiveQueuePlayers,
    deathmatchQueuePlayers: population.deathmatchQueuePlayers,
    deathmatchHumans,
    deathmatchBots,
    deathmatchCapacity,
    season,
    ...(controls ? { controls } : {})
  };
}

export function createApp(deps: AppDeps = {}): express.Express {
  const app = express();
  const service: QueueServiceLike = deps.queueService ?? new QueueService();
  const parties = deps.partyService ?? new PartyService();
  const observability = deps.observability ?? createObservability(
    process.env["NODE_ENV"] === "test" ? () => undefined : console.log
  );

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(observability.middleware);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || deps.allowedOrigins === undefined) {
        callback(null, true);
        return;
      }
      try {
        callback(null, deps.allowedOrigins.includes(new URL(origin).origin));
      } catch {
        callback(null, false);
      }
    },
    credentials: true
  }));
  app.use(express.json({ limit: "32kb" }));
  app.use(createSessionMiddleware(deps.session));

  app.get("/metrics", async (req, res, next) => {
    try {
      if (deps.metricsToken && req.get("Authorization") !== `Bearer ${deps.metricsToken}`) {
        res.status(401).type("text/plain").send("Unauthorized\n");
        return;
      }
      if (deps.metricsSnapshot) {
        const snapshot = await deps.metricsSnapshot();
        for (const [name, value] of Object.entries(snapshot)) {
          observability.metrics.setGauge(`aftertick_${name}`, {}, value);
        }
      }
      res.status(200).type("text/plain; version=0.0.4").send(observability.metrics.render());
    } catch (error) {
      next(error);
    }
  });

  const rateLimits = deps.rateLimits ?? {
    windowMs: 60_000,
    apiLimit: 240,
    authLimit: 30
  };
  const browserApiLimiter = createRateLimiter({
    windowMs: rateLimits.windowMs,
    limit: rateLimits.apiLimit,
    store: rateLimits.apiStore,
    identifier: "aftertick-api"
  });
  // Machine ingestion can emit ten bounded batches/second. Its budget must not
  // consume the browser API bucket or throttle heartbeats after combat bursts.
  // Node routes retain their bearer/HMAC checks and a separate bounded limiter.
  const nodeApiLimiter = createRateLimiter({
    windowMs: rateLimits.windowMs,
    limit: rateLimits.nodeLimit ?? Math.ceil(rateLimits.windowMs / 1_000 * 20),
    store: rateLimits.nodeStore,
    identifier: "aftertick-node"
  });
  app.use("/api", (req, res, next) => {
    const limiter = req.path.startsWith("/node/v1/") ? nodeApiLimiter : browserApiLimiter;
    return limiter(req, res, next);
  });

  if (deps.devIdentity) {
    app.use((req, _res, next) => {
      req.session.playerId ??= deps.devIdentity!.playerId;
      req.session.steamId ??= deps.devIdentity!.steamId;
      req.session.displayName ??= deps.devIdentity!.displayName;
      next();
    });
  }
  if (deps.testIdentity) {
    app.use(async (req, _res, next) => {
      try {
        const secret = req.get("X-Aftertick-Test-Secret");
        const playerId = req.get("X-Aftertick-Test-Player-Id");
        if (secret !== deps.testIdentity!.secret || !playerId) {
          next();
          return;
        }
        const identity = await deps.testIdentity!.resolve(playerId);
        if (identity) {
          req.session.playerId = playerId;
          req.session.steamId = identity.steamId;
          req.session.displayName = identity.displayName;
        }
        next();
      } catch (error) {
        next(error);
      }
    });
  }

  // ── Health ──
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "aftertick-api" });
  });

  app.get("/ready", async (_req, res, next) => {
    try {
      const result = deps.readiness
        ? await deps.readiness()
        : { ready: true, checks: { runtime: { status: "ok" as const } } };
      res.status(result.ready ? 200 : 503).json({
        status: result.ready ? "ready" : "not-ready",
        ready: result.ready,
        service: "aftertick-api",
        checks: result.checks
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Auth routes ──
  const databasePlayers = deps.sql ? playerService(deps.sql) : null;
  const ps = deps.playerReads ?? databasePlayers;
  const partyView = async (party: PartyState | null): Promise<PartyState | null> => {
    if (!party || !ps) return party;
    return {
      ...party,
      members: await Promise.all(party.members.map(async (member) => {
        const player = await ps.getPlayerView(member.playerId);
        return player ? {
          ...member,
          displayName: player.displayName,
          initials: player.initials,
          rank: player.rank
        } : member;
      }))
    };
  };
  const bootstrapForPlayer = async (
    playerId: string,
    displayName?: string
  ): Promise<BootstrapResponse> => {
    const player = ps ? await ps.getPlayerView(playerId) : null;
    const platform = await platformSnapshot(deps, service, playerId);
    if (!player) {
      return {
        ...withSessionIdentity(await service.getBootstrapFallback(playerId), displayName),
        platform
      };
    }
    const runtime = await service.getQueueRuntime(playerId);
    return {
      player,
      queue: runtime.queue,
      readyCheck: runtime.readyCheck,
      mapVeto: runtime.mapVeto,
      assignment: runtime.assignment,
      platform
    };
  };
  const joinQueueForPlayer = async (
    playerId: string,
    input: z.infer<typeof joinSchema>,
    verifiedParty?: VerifiedQueueParty
  ) => {
    const player = ps ? await ps.getPlayerView(playerId) : null;
    if (player?.onboardingRequired) {
      throw new QueueError(409, "Choose your B2G in-game name before entering matchmaking.");
    }
    const memberIds = verifiedParty?.memberPlayerIds ?? [playerId];
    await Promise.all(memberIds.map((memberId) => deps.operations?.assertCanQueue(memberId)));
    if (deps.latencyProbes) {
      const webParty = verifiedParty ? null : await parties.getForPlayer(playerId);
      const latencyMemberIds = verifiedParty?.memberPlayerIds
        ?? webParty?.members.map((member) => member.playerId)
        ?? [playerId];
      await deps.latencyProbes.assertFresh(latencyMemberIds, input.regions);
    }
    if (input.mode === "deathmatch" && deps.deathmatchDropIn) {
      await deps.operations?.assertAllocationEnabled();
      return deps.deathmatchDropIn.join({ playerId, ...input }, verifiedParty);
    }
    if (verifiedParty) {
      if (!service.joinVerifiedParty) {
        throw new QueueError(503, "Native Steam parties require the durable matchmaking service.");
      }
      return service.joinVerifiedParty({ playerId, ...input }, verifiedParty);
    }
    return service.join({ playerId, ...input });
  };
  const verifiedNativeParty = async (
    playerId: string,
    input: z.infer<typeof launcherJoinSchema>
  ): Promise<VerifiedQueueParty | undefined> => {
    const nativeParty = input.nativeParty;
    if (!nativeParty) return undefined;
    if (!deps.sql) {
      throw new QueueError(503, "Native Steam party verification is unavailable.");
    }

    const rows = await deps.sql<{
      id: string;
      steam_id: string;
      ingame_name_set_at: Date | null;
      launcher_active: boolean;
    }[]>`
      select
        p.id::text,
        p.steam_id,
        p.ingame_name_set_at,
        exists (
          select 1
          from launcher_credentials lc
          where lc.player_id = p.id
            and lc.revoked_at is null
            and lc.expires_at > now()
            and lc.last_used_at >= now() - interval '15 seconds'
        ) as launcher_active
      from players p
      where p.steam_id = any(${nativeParty.memberSteamIds})
    `;
    const playersBySteamId = new Map(rows.map((row) => [row.steam_id, row]));
    const members = nativeParty.memberSteamIds.map((steamId) => playersBySteamId.get(steamId));
    if (members.some((member) => !member)) {
      throw new QueueError(409, "Every Steam lobby member needs a B2G account before queueing.");
    }
    const verifiedMembers = members.filter(
      (member): member is NonNullable<typeof member> => Boolean(member)
    );
    if (!verifiedMembers.some((member) => member.id === playerId)) {
      throw new QueueError(403, "The paired launcher is not a member of that Steam lobby.");
    }
    if (verifiedMembers.some((member) => member.ingame_name_set_at === null)) {
      throw new QueueError(409, "Every Steam lobby member must finish B2G onboarding before queueing.");
    }
    if (verifiedMembers.some((member) => !member.launcher_active)) {
      throw new QueueError(409, "Every Steam lobby member must have B2G Launcher open before queueing.");
    }
    return {
      partyId: `steam-lobby:${nativeParty.steamLobbyId}`,
      leaderPlayerId: playerId,
      memberPlayerIds: verifiedMembers.map((member) => member.id)
    };
  };
  const launcherBootstrapForPlayer = async (playerId: string): Promise<LauncherBootstrapResponse> => {
    const bootstrap = await bootstrapForPlayer(playerId);
    const rankIndex = RANKS.findIndex((rank) => rank.name === bootstrap.player.rank.name);
    const [profile] = deps.sql ? await deps.sql<{
      steam_id: string | null;
      wins: number;
      profile_level: number;
      profile_xp: number;
      service_drop_count: number;
      b2g_inventory_version: number;
    }[]>`
      select player.steam_id, player.wins, player.profile_level, player.profile_xp,
             (select count(*)::int from player_service_drops reward
              where reward.player_id = player.id) as service_drop_count,
             player.b2g_inventory_revision::double precision as b2g_inventory_version
      from players player where player.id = ${playerId}
    ` : [];
    const steamId = profile?.steam_id
      ?? (deps.devIdentity?.playerId === playerId ? deps.devIdentity.steamId : null);
    if (!steamId || !/^\d{17}$/.test(steamId)) {
      throw new LauncherDeviceError(409, "A valid Steam account is required before starting CS:GO.");
    }
    return {
      ...bootstrap,
      gameProfile: {
        steamId,
        competitiveRankId: rankIndex >= 0 ? rankIndex + 1 : 0,
        competitiveWins: profile?.wins ?? 0,
        playerLevel: profile?.profile_level ?? 3,
        playerXp: profile?.profile_xp ?? 0,
        serviceDropCount: profile?.service_drop_count ?? 0,
        b2gInventoryVersion: profile?.b2g_inventory_version ?? 0
      },
      launcher: {
        content: deps.launcherContent ?? defaultLauncherContent
      }
    };
  };
  const launcherPlayerProfilesForPlayer = async (
    playerId: string,
    accountIds: number[]
  ): Promise<LauncherPlayerProfilesResponse> => {
    if (!deps.sql) {
      throw new LauncherDeviceError(503, "In-game player profiles are unavailable.");
    }
    const steamIdByAccountId = new Map(accountIds.map((accountId) => [
      accountId,
      (76_561_197_960_265_728n + BigInt(accountId)).toString()
    ]));
    const rows = await deps.sql<{
      steam_id: string;
      rating: number;
      wins: number;
      profile_level: number;
      profile_xp: number;
    }[]>`
      select steam_id, rating, wins, profile_level, profile_xp
      from players
      where steam_id = any(${[...steamIdByAccountId.values()]})
        and (id = ${playerId} or profile_visibility in ('public', 'players'))
    `;
    const rowsBySteamId = new Map(rows.map((row) => [row.steam_id, row]));
    return {
      version: 1 as const,
      profiles: accountIds.flatMap((accountId) => {
        const row = rowsBySteamId.get(steamIdByAccountId.get(accountId)!);
        if (!row) return [];
        let rankId = 1;
        for (let index = RANKS.length - 1; index >= 0; index -= 1) {
          if (row.rating >= RANKS[index]!.floor) {
            rankId = index + 1;
            break;
          }
        }
        return [{
          accountId,
          competitiveRankId: rankId,
          competitiveWins: row.wins,
          playerLevel: row.profile_level,
          playerXp: row.profile_xp
        }];
      })
    };
  };
  const auth = buildAuthRoutes({
    onLogin: async (steamId, profile) => {
      if (databasePlayers) {
        const existing = await databasePlayers.findBySteamId(steamId);
        if (!existing) await deps.operations?.assertRegistrationEnabled();
        const player = existing ?? await databasePlayers.findOrCreateBySteam(steamId, profile);
        if (steamId === deps.bootstrapAdminSteamId) {
          await databasePlayers.setRoleBySteamId(steamId, "admin");
        }
        return player;
      }
      return {
        id: `steam:${steamId}`,
        displayName: profile.displayName
      };
    },
    ...deps.auth
  });

  const authRateLimiter = createRateLimiter({
    windowMs: rateLimits.windowMs,
    limit: rateLimits.authLimit,
    store: rateLimits.authStore,
    identifier: "aftertick-auth"
  });
  app.get("/api/auth/steam", authRateLimiter, auth.login);
  app.get("/api/auth/steam/callback", auth.callback);
  app.get("/api/auth/me", auth.me);
  app.get("/api/auth/csrf", csrfToken);

  // Launcher pairing uses a short-lived device code approved through the
  // browser session. The resulting credential is independent of browser
  // cookies and can be revoked without ending the Steam session.
  app.post("/api/launcher/v1/device/authorizations", authRateLimiter, async (_req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      res.set("Cache-Control", "no-store");
      res.status(201).json(await deps.launcherDevices.issue());
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/device/token", authRateLimiter, async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const input = launcherAuthorizationSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(await deps.launcherDevices.exchange(input.deviceCode, input.deviceName));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/launcher/v1/bootstrap", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      res.set("Cache-Control", "no-store");
      res.json(await launcherBootstrapForPlayer(identity.playerId));
    } catch (error) {
      next(error);
    }
  });
  // Launcher account surfaces use device credentials, never browser cookies.
  app.post("/api/launcher/v1/account/onboarding", authRateLimiter, async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !ps?.completeOnboarding) throw new LauncherDeviceError(503, "Account setup is unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = onboardingSchema.parse(req.body);
      const current = await ps.getPlayerView(identity.playerId);
      if (!current) throw new LauncherDeviceError(404, "Player not found.");
      if (!current.onboardingRequired) throw new LauncherDeviceError(409, "This account has already completed setup.");
      res.set("Cache-Control", "no-store").json(await ps.completeOnboarding(identity.playerId, input.displayName, input.region));
    } catch (error) { next(error); }
  });
  app.get("/api/launcher/v1/account", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !ps) throw new LauncherDeviceError(503, "Account settings are unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const player = await ps.getPlayerView(identity.playerId);
      if (!player) throw new LauncherDeviceError(404, "Player not found.");
      res.set("Cache-Control", "no-store").json(player);
    } catch (error) { next(error); }
  });
  app.post("/api/launcher/v1/account/settings", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !ps?.updateSettings) throw new LauncherDeviceError(503, "Account settings are unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = accountSettingsSchema.parse(req.body);
      res.set("Cache-Control", "no-store").json(await ps.updateSettings(identity.playerId, input));
    } catch (error) { next(error); }
  });
  app.get("/api/launcher/v1/matches", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !ps) throw new LauncherDeviceError(503, "Match history is unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const query = paginationSchema.parse(req.query);
      res.set("Cache-Control", "no-store").json(await ps.matchHistory(identity.playerId, query.limit, query.offset));
    } catch (error) { next(error); }
  });
  app.get("/api/launcher/v1/matches/:matchId", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !ps) throw new LauncherDeviceError(503, "Match details are unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const match = await ps.getMatchDetails(z.string().uuid().parse(req.params["matchId"]));
      if (!match || !Object.values(match.teams).flat().some(player => player.playerId === identity.playerId)) {
        throw new LauncherDeviceError(404, "Match not found in your history.");
      }
      res.set("Cache-Control", "no-store").json(match);
    } catch (error) { next(error); }
  });
  app.get("/api/launcher/v1/matches/:matchId/demo", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !ps || !deps.demoIngestion) throw new LauncherDeviceError(503, "Demo downloads are unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      const match = await ps.getMatchDetails(matchId);
      if (!match || !Object.values(match.teams).flat().some(player => player.playerId === identity.playerId)) {
        throw new LauncherDeviceError(404, "Match not found in your history.");
      }
      const demo = await deps.demoIngestion.openDemo(matchId);
      res.set("Cache-Control", "no-store");
      res.setHeader("Content-Type", demo.contentType);
      res.setHeader("Content-Length", String(demo.contentLength));
      res.setHeader("Content-Disposition", `attachment; filename="${demo.filename}"`);
      demo.body.once("error", next);
      demo.body.pipe(res);
    } catch (error) { next(error); }
  });

  app.post("/api/launcher/v1/player-profiles", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const { accountIds } = launcherPlayerProfilesSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(await launcherPlayerProfilesForPlayer(identity.playerId, accountIds));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/latency/challenges", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const { regions } = latencyProbeChallengeSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      if (!deps.latencyProbes) {
        res.json({ enabled: false, launcherUrl: null });
        return;
      }
      const challenge = await deps.latencyProbes.issue(identity.playerId, regions);
      res.status(201).json({ ...challenge, enabled: true });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/queue/join", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherJoinSchema.parse(req.body);
      const party = await verifiedNativeParty(identity.playerId, input);
      res.set("Cache-Control", "no-store");
      res.status(201).json(await joinQueueForPlayer(identity.playerId, input, party));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/queue/session-ended", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const { ticketId } = z.object({ ticketId: z.string().uuid() }).parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json({ released: await service.releaseSearch(identity.playerId, ticketId) });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/queue/leave", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      res.set("Cache-Control", "no-store");
      res.json(await service.leave(identity.playerId));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/matches/:matchId/accept", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      res.set("Cache-Control", "no-store");
      res.json(await service.accept(identity.playerId, matchId));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/device/revoke", async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const token = launcherAccessToken(req);
      await deps.launcherDevices.revoke(token);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Node agents use scoped bearer credentials rather than browser sessions/CSRF.
  app.post("/api/node/v1/heartbeat", async (req, res, next) => {
    try {
      if (!deps.nodeControl) {
        res.status(503).json({ error: "The server control plane is unavailable." });
        return;
      }
      const heartbeat = nodeHeartbeatSchema.parse(req.body);
      res.json(await deps.nodeControl.heartbeat(bearerToken(req), heartbeat));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/node/v1/commands/:commandId/ack", async (req, res, next) => {
    try {
      if (!deps.nodeControl) {
        res.status(503).json({ error: "The server control plane is unavailable." });
        return;
      }
      const commandId = z.string().uuid().parse(req.params["commandId"]);
      const acknowledgement = nodeAckSchema.parse(req.body);
      const accepted = await deps.nodeControl.acknowledgeCommand(
        bearerToken(req),
        commandId,
        acknowledgement.claimToken,
        acknowledgement.succeeded,
        acknowledgement.result ?? {}
      );
      res.status(accepted ? 200 : 409).json({ accepted });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/node/v1/matches/:matchId/events", async (req, res, next) => {
    try {
      if (!deps.matchIngestion) {
        res.status(503).json({ error: "Match ingestion is unavailable." });
        return;
      }
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      const batch = matchEventBatchSchema.parse(req.body);
      const result = await deps.matchIngestion.ingestEvents(
        bearerToken(req),
        matchId,
        batch,
        req.get("X-Aftertick-Signature") ?? "",
        req.get("X-Aftertick-Counter-Receipt") === "1"
      );
      res.status(result.conflicts > 0 ? 202 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/node/v1/matches/:matchId/result", async (req, res, next) => {
    try {
      if (!deps.matchIngestion) {
        res.status(503).json({ error: "Match ingestion is unavailable." });
        return;
      }
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      const submission = matchResultSchema.parse(req.body);
      const result = await deps.matchIngestion.ingestResult(
        bearerToken(req),
        matchId,
        submission,
        req.get("X-Aftertick-Signature") ?? ""
      );
      res.status(result.status === "pending" ? 202 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.put("/api/node/v1/matches/:matchId/demo", async (req, res, next) => {
    try {
      if (!deps.demoIngestion) {
        req.resume();
        res.status(503).json({ error: "Demo ingestion is unavailable." });
        return;
      }
      if (req.is("application/octet-stream") !== "application/octet-stream") {
        req.resume();
        throw new MatchIngestionError(415, "Demo uploads must use application/octet-stream.");
      }
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      const submission = demoUploadSchema.parse({
        demoVersion: Number(req.get("X-Aftertick-Demo-Version")),
        leaseId: req.get("X-Aftertick-Lease-Id"),
        fencingToken: req.get("X-Aftertick-Fencing-Token"),
        objectKey: req.get("X-Aftertick-Demo-Key"),
        sizeBytes: Number(req.get("Content-Length")),
        sha256: req.get("X-Aftertick-Demo-Sha256")
      });
      const result = await deps.demoIngestion.upload(
        bearerToken(req),
        matchId,
        submission,
        req.get("X-Aftertick-Signature") ?? "",
        req
      );
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });
  // Launcher reports use one-use challenge credentials rather than browser cookies/CSRF.
  app.post("/api/latency/v1/reports", async (req, res, next) => {
    try {
      if (!deps.latencyProbes) {
        res.status(503).json({ error: "Regional latency measurement is unavailable." });
        return;
      }
      const submission = latencyProbeSubmissionSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(await deps.latencyProbes.submit(
        latencyProbeToken(req),
        req.get("X-B2G-Probe-Signature") ?? "",
        submission
      ));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/launcher/v1/account/inventory", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory) throw new InventoryError(503, "Inventory is unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.inventory.view(identity.playerId));
    } catch (error) { next(error); }
  });
  app.post("/api/launcher/v1/account/inventory/refresh", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory) throw new InventoryError(503, "Inventory import is unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      z.object({}).strict().parse(req.body ?? {});
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.inventory.refresh(identity.playerId));
    } catch (error) { next(error); }
  });
  app.get("/api/launcher/v1/inventory/:grantId", async (req, res, next) => {
    try {
      if (!deps.inventory?.launcherBundle) {
        res.status(503).json({ error: "Launcher inventory is unavailable." });
        return;
      }
      const grantId = z.string().uuid().parse(req.params["grantId"]);
      res.set("Cache-Control", "no-store");
      res.set("X-Content-Type-Options", "nosniff");
      res.json(await deps.inventory.launcherBundle(grantId, launcherInventoryToken(req)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/launcher/v1/inventory", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.launcherAccountBundle) {
        res.status(503).json({ error: "Launcher inventory is unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      res.set("Cache-Control", "no-store");
      res.set("X-Content-Type-Options", "nosniff");
      res.json(await deps.inventory.launcherAccountBundle(identity.playerId));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/cases/open", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.openB2GCase) {
        res.status(503).json({ error: "B2G case opening is unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherCaseOpenSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.set("X-Content-Type-Options", "nosniff");
      res.json(await deps.inventory.openB2GCase(identity.playerId, input.caseAssetId, input.keyAssetId));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/launcher/v1/service-medal", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.serviceMedals)
        throw new ServiceMedalError(503, "Service medal redemption is unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      res.set("Cache-Control", "no-store");
      res.json(await deps.serviceMedals.preview(identity.playerId));
    } catch (error) { next(error); }
  });
  registerFriendsRoutes(app, deps.friends ?? (deps.sql ? new FriendsService(deps.sql) : undefined), async req => {
    const token = launcherAccessToken(req);
    if (!deps.launcherDevices) throw new LauncherDeviceError(503, "Launcher authentication is unavailable.");
    return deps.launcherDevices.authenticate(token);
  });
  registerTradingRoutes(app, deps.trading, async req => {
    const token = launcherAccessToken(req);
    if (!deps.launcherDevices) throw new LauncherDeviceError(503, "Launcher authentication is unavailable.");
    return deps.launcherDevices.authenticate(token);
  });
  app.post("/api/launcher/v1/service-medal", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.serviceMedals)
        throw new ServiceMedalError(503, "Service medal redemption is unavailable.");
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = z.object({ definitionIndex: z.number().int().min(1).max(65535) }).strict().parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(await deps.serviceMedals.redeem(identity.playerId, input.definitionIndex));
    } catch (error) { next(error); }
  });
  app.post("/api/launcher/v1/trade-ups", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.tradeUpB2G) {
        res.status(503).json({ error: "B2G Trade Up Contracts are unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherTradeUpSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.set("X-Content-Type-Options", "nosniff");
      res.json(await deps.inventory.tradeUpB2G(identity.playerId, input.inputAssetIds));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/inventory/loadout", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.syncLauncherLoadout) {
        res.status(503).json({ error: "B2G loadout persistence is unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherLoadoutSyncSchema.parse(req.body);
      await deps.inventory.syncLauncherLoadout(identity.playerId, input.assetIds, input.ownershipGenerations);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/inventory/acknowledge", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.acknowledgeB2GItems) {
        res.status(503).json({ error: "B2G inventory acknowledgement is unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherAcknowledgementSchema.parse(req.body);
      await deps.inventory.acknowledgeB2GItems(identity.playerId, input.positions);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/inventory/rename", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.renameB2GItem) {
        res.status(503).json({ error: "B2G item naming is unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherItemRenameSchema.parse(req.body);
      await deps.inventory.renameB2GItem(identity.playerId, input.assetId, input.customName);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/inventory/sprays/unseal", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.unsealB2GGraffiti) {
        res.status(503).json({ error: "B2G graffiti activation is unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherSpraySchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(await deps.inventory.unsealB2GGraffiti(identity.playerId, input.assetId));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/launcher/v1/inventory/sprays/use", async (req, res, next) => {
    try {
      if (!deps.launcherDevices || !deps.inventory?.consumeB2GGraffiti) {
        res.status(503).json({ error: "B2G graffiti usage is unavailable." });
        return;
      }
      const identity = await deps.launcherDevices.authenticate(launcherAccessToken(req));
      const input = launcherSpraySchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(await deps.inventory.consumeB2GGraffiti(identity.playerId, input.assetId));
    } catch (error) {
      next(error);
    }
  });
  app.use("/api", requireCsrf);
  app.post("/api/auth/logout", auth.logout);
  app.post("/api/launcher/v1/device/approve", requireAuth, async (req, res, next) => {
    try {
      if (!deps.launcherDevices) {
        throw new LauncherDeviceError(503, "Launcher authorization is unavailable.");
      }
      const { userCode } = launcherApprovalSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.json(await deps.launcherDevices.approve(req.session.playerId!, userCode));
    } catch (error) {
      next(error);
    }
  });

  // ── Protected routes ──
  app.get("/api/party", requireAuth, async (req, res, next) => {
    try {
      res.json({ party: await partyView(await parties.getForPlayer(req.session.playerId!)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/party/invites", requireAuth, async (req, res, next) => {
    try {
      res.json({ invites: await parties.listInvites(req.session.playerId!) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/party", requireAuth, async (req, res, next) => {
    try {
      res.status(201).json(await partyView(await parties.create(req.session.playerId!)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/party/invites", requireAuth, async (req, res, next) => {
    try {
      const { playerId } = partyPlayerSchema.parse(req.body);
      res.status(201).json(await parties.invite(req.session.playerId!, playerId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/party/invites/:inviteId/accept", requireAuth, async (req, res, next) => {
    try {
      const inviteId = z.string().uuid().parse(req.params["inviteId"]);
      res.json(await partyView(await parties.acceptInvite(req.session.playerId!, inviteId)));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/party/ready", requireAuth, async (req, res, next) => {
    try {
      const { ready } = partyReadySchema.parse(req.body);
      res.json(await partyView(await parties.setReady(req.session.playerId!, ready)));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/party/leader", requireAuth, async (req, res, next) => {
    try {
      const { playerId } = partyPlayerSchema.parse(req.body);
      res.json(await partyView(await parties.transferLeader(req.session.playerId!, playerId)));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/party", requireAuth, async (req, res, next) => {
    try {
      res.json({ party: await partyView(await parties.leave(req.session.playerId!)) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/latency-probes", requireAuth, async (req, res, next) => {
    try {
      if (!deps.latencyProbes) {
        res.json({ enabled: false, regions: [], measurements: [] });
        return;
      }
      res.json(await deps.latencyProbes.status(req.session.playerId!));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/latency-probes/challenges", requireAuth, async (req, res, next) => {
    try {
      if (!deps.latencyProbes) {
        res.status(503).json({ error: "Regional latency measurement is unavailable." });
        return;
      }
      const { regions } = latencyProbeChallengeSchema.parse(req.body);
      res.set("Cache-Control", "no-store");
      res.status(201).json(await deps.latencyProbes.issue(req.session.playerId!, regions));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/bootstrap", requireAuth, async (req, res, next) => {
    try {
      res.json(await bootstrapForPlayer(req.session.playerId!, req.session.displayName));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/platform", requireAuth, async (req, res, next) => {
    try {
      res.json(await platformSnapshot(deps, service, req.session.playerId!));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/players/:playerId", requireAuth, async (req, res, next) => {
    try {
      if (!ps) {
        res.status(503).json({ error: "Player profiles are unavailable." });
        return;
      }
      const playerId = z.string().trim().min(1).max(128).parse(req.params["playerId"]);
      const profile = await ps.getProfile(playerId);
      if (!profile) {
        res.status(404).json({ error: "Player not found." });
        return;
      }
      res.json(profile);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/players/:playerId/matches", requireAuth, async (req, res, next) => {
    try {
      if (!ps) {
        res.status(503).json({ error: "Match history is unavailable." });
        return;
      }
      const playerId = z.string().trim().min(1).max(128).parse(req.params["playerId"]);
      const query = paginationSchema.parse(req.query);
      res.json(await ps.matchHistory(playerId, query.limit, query.offset));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/account/onboarding", requireAuth, async (req, res, next) => {
    try {
      if (!ps?.completeOnboarding) {
        res.status(503).json({ error: "Account setup is unavailable." });
        return;
      }
      const input = onboardingSchema.parse(req.body);
      const player = await ps.completeOnboarding(req.session.playerId!, input.displayName, input.region);
      req.session.displayName = player.displayName;
      res.json(player);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        res.status(409).json({ error: "That in-game name is already taken." });
        return;
      }
      next(error);
    }
  });

  app.patch("/api/account/settings", requireAuth, async (req, res, next) => {
    try {
      if (!ps?.updateSettings) {
        res.status(503).json({ error: "Account settings are unavailable." });
        return;
      }
      const input = accountSettingsSchema.parse(req.body);
      res.json(await ps.updateSettings(req.session.playerId!, input));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/account/inventory", requireAuth, async (req, res, next) => {
    try {
      if (!deps.inventory) throw new InventoryError(503, "Inventory import is unavailable.");
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.inventory.view(req.session.playerId!));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/account/inventory/refresh", requireAuth, async (req, res, next) => {
    try {
      if (!deps.inventory) throw new InventoryError(503, "Inventory import is unavailable.");
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.inventory.refresh(req.session.playerId!));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/account/loadout", requireAuth, async (req, res, next) => {
    try {
      if (!deps.inventory) throw new InventoryError(503, "Inventory loadouts are unavailable.");
      const { selections } = cosmeticLoadoutSchema.parse(req.body);
      res.set("Cache-Control", "private, no-store");
      res.json(await deps.inventory.saveLoadout(req.session.playerId!, selections));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/leaderboard", requireAuth, async (req, res, next) => {
    try {
      if (!ps) {
        res.status(503).json({ error: "The leaderboard is unavailable." });
        return;
      }
      const query = z.object({
        region: z.string().trim().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(10_000).default(0)
      }).parse(req.query);
      res.json({ entries: await ps.leaderboard(query.region ?? null, query.limit, query.offset) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/matches/:matchId", requireAuth, async (req, res, next) => {
    try {
      if (!ps) {
        res.status(503).json({ error: "Match details are unavailable." });
        return;
      }
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      const match = await ps.getMatchDetails(matchId);
      if (!match) {
        res.status(404).json({ error: "Match not found." });
        return;
      }
      res.json(match);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/matches/:matchId/demo", requireAuth, async (req, res, next) => {
    try {
      if (!deps.demoIngestion) {
        res.status(503).json({ error: "Demo downloads are unavailable." });
        return;
      }
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      const demo = await deps.demoIngestion.openDemo(matchId);
      res.status(200);
      res.setHeader("Content-Type", demo.contentType);
      res.setHeader("Content-Length", String(demo.contentLength));
      res.setHeader("Content-Disposition", `attachment; filename=\"${demo.filename}\"`);
      demo.body.once("error", next);
      demo.body.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/platform/controls", requireAuth, async (_req, res, next) => {
    try {
      res.json(await operationsService(deps).getControls());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/reports", requireAuth, async (req, res, next) => {
    try {
      const input = createReportSchema.parse(req.body);
      res.status(201).json(await operationsService(deps).createReport({
        reporterId: req.session.playerId!,
        ...input,
        ipAddress: req.ip ?? null
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sanctions", requireAuth, async (req, res, next) => {
    try {
      const query = paginationSchema.parse(req.query);
      res.json({
        sanctions: await operationsService(deps).listOwnSanctions(
          req.session.playerId!, query.limit, query.offset
        )
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sanctions/:sanctionId/appeals", requireAuth, async (req, res, next) => {
    try {
      const sanctionId = z.string().uuid().parse(req.params["sanctionId"]);
      const { statement } = createAppealSchema.parse(req.body);
      res.status(201).json(await operationsService(deps).createAppeal(
        req.session.playerId!, sanctionId, statement, req.ip ?? null
      ));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/moderation/reports", requireAuth, async (req, res, next) => {
    try {
      const query = paginationSchema.extend({ status: reportStatusSchema.optional() }).parse(req.query);
      res.json({ reports: await operationsService(deps).listReports(
        req.session.playerId!, query.status ?? null, query.limit, query.offset
      ) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/moderation/reports/:reportId", requireAuth, async (req, res, next) => {
    try {
      const reportId = z.string().uuid().parse(req.params["reportId"]);
      const input = reviewReportSchema.parse(req.body);
      res.json(await operationsService(deps).reviewReport({
        actorId: req.session.playerId!, reportId, ...input, ipAddress: req.ip ?? null
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/moderation/sanctions", requireAuth, async (req, res, next) => {
    try {
      const query = paginationSchema.extend({ playerId: z.string().uuid().optional() }).parse(req.query);
      res.json({ sanctions: await operationsService(deps).listSanctions(
        req.session.playerId!, query.playerId ?? null, query.limit, query.offset
      ) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/moderation/sanctions", requireAuth, async (req, res, next) => {
    try {
      const input = createSanctionSchema.parse(req.body);
      res.status(201).json(await operationsService(deps).createSanction({
        actorId: req.session.playerId!, ...input, ipAddress: req.ip ?? null
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/moderation/appeals", requireAuth, async (req, res, next) => {
    try {
      const query = paginationSchema.extend({ status: appealStatusSchema.optional() }).parse(req.query);
      res.json({ appeals: await operationsService(deps).listAppeals(
        req.session.playerId!, query.status ?? null, query.limit, query.offset
      ) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/moderation/anticheat-signals", requireAuth, async (req, res, next) => {
    try {
      const query = paginationSchema.parse(req.query);
      res.json({ signals: await operationsService(deps).listAntiCheatSignals(
        req.session.playerId!, query.limit, query.offset
      ) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/moderation/appeals/:appealId", requireAuth, async (req, res, next) => {
    try {
      const appealId = z.string().uuid().parse(req.params["appealId"]);
      const input = resolveAppealSchema.parse(req.body);
      res.json(await operationsService(deps).resolveAppeal({
        actorId: req.session.playerId!, appealId, ...input, ipAddress: req.ip ?? null
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/controls", requireAuth, async (req, res, next) => {
    try {
      const service = operationsService(deps);
      await service.assertAdmin(req.session.playerId!);
      res.json(await service.getControls());
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/controls", requireAuth, async (req, res, next) => {
    try {
      const input = controlsSchema.parse(req.body);
      res.json(await operationsService(deps).updateControls({
        actorId: req.session.playerId!, ...input, ipAddress: req.ip ?? null
      }));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/players/:playerId/role", requireAuth, async (req, res, next) => {
    try {
      const playerId = z.string().uuid().parse(req.params["playerId"]);
      const { role } = roleSchema.parse(req.body);
      await operationsService(deps).setRole(req.session.playerId!, playerId, role, req.ip ?? null);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/audit", requireAuth, async (req, res, next) => {
    try {
      const query = paginationSchema.parse(req.query);
      res.json({ entries: await operationsService(deps).listAudit(
        req.session.playerId!, query.limit, query.offset
      ) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/match-recovery", requireAuth, async (req, res, next) => {
    try {
      const query = paginationSchema.extend({ status: recoveryStatusSchema.optional() }).parse(req.query);
      res.json({ incidents: await recoveryService(deps).list(
        req.session.playerId!, query.status ?? null, query.limit, query.offset
      ) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/match-recovery/:incidentId/resolve", requireAuth, async (req, res, next) => {
    try {
      const incidentId = z.string().uuid().parse(req.params["incidentId"]);
      const input = resolveRecoverySchema.parse(req.body);
      res.json(await recoveryService(deps).resolve({
        actorId: req.session.playerId!,
        incidentId,
        ...input,
        ipAddress: req.ip ?? null
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/queue/join", requireAuth, async (req, res, next) => {
    try {
      const input = joinSchema.parse(req.body);
      res.status(201).json(await joinQueueForPlayer(req.session.playerId!, input));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/queue/leave", requireAuth, async (req, res, next) => {
    try {
      const playerId = req.session.playerId!;
      res.json(await service.leave(playerId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/matches/:matchId/accept", requireAuth, async (req, res, next) => {
    try {
      const playerId = req.session.playerId!;
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      res.json(await service.accept(playerId, matchId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/matches/:matchId/veto", requireAuth, async (req, res, next) => {
    try {
      const playerId = req.session.playerId!;
      const matchId = z.string().uuid().parse(req.params["matchId"]);
      const { map } = mapVetoSchema.parse(req.body);
      res.json(await service.banMap(playerId, matchId, map));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/dev/reset", requireAuth, async (req, res, next) => {
    try {
      const playerId = req.session.playerId!;
      const reset = withSessionIdentity(
        await service.reset(playerId),
        req.session.displayName
      );
      const player = ps ? await ps.getPlayerView(playerId) : null;
      const controls = deps.operations ? await deps.operations.getControls() : undefined;
      const response = player ? { ...reset, player } : reset;
      res.json(controls ? { ...response, platform: { ...response.platform, controls } } : response);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/events", requireAuth, async (req, res, next) => {
    try {
      const playerId = req.session.playerId!;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      res.write(": connected\n\n");
      await service.touchPresence?.(playerId);

      let closed = false;
      let unsubscribe: () => void | Promise<void> = () => undefined;
      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
        void service.touchPresence?.(playerId);
      }, 15_000);
      req.on("close", async () => {
        closed = true;
        clearInterval(keepAlive);
        await unsubscribe();
      });

      unsubscribe = await service.subscribe(playerId, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      if (closed) await unsubscribe();
    } catch (error) {
      next(error);
    }
  });

  // ── 404 + error handler ──
  app.use((_req, res) => {
    res.status(404).json({ error: "Route not found." });
  });

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof QueueError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof PartyError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof NodeAuthenticationError) {
        res.status(401).json({ error: "Invalid node credentials." });
        return;
      }
      if (error instanceof MatchIngestionError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof PlatformAccessError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof LatencyProbeError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof InventoryError || error instanceof ServiceMedalError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof TradingError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof LauncherDeviceError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "Invalid request.",
          details: error.issues.map((i) => i.message)
        });
        return;
      }
      console.error(error);
      res.status(500).json({ error: "Internal server error." });
    }
  );

  return app;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
