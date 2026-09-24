import { createConnection, type Sql } from "@aftertick/db";
import { RedisStore as SessionRedisStore } from "connect-redis";
import { RedisStore as RateLimitRedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { createApp, closeServer } from "./app.js";
import { REGIONS } from "./catalog.js";
import { loadConfig } from "./config.js";
import { createE2EReadService } from "./e2e-read-service.js";
import { MatchOrchestrator } from "./match-orchestrator.js";
import { MatchIngestionService } from "./match-ingestion-service.js";
import { MatchRecoveryService } from "./match-recovery-service.js";
import { LatencyProbeService } from "./latency-probe-service.js";
import {
  DemoIngestionService,
  S3DemoObjectStore
} from "./demo-ingestion-service.js";
import { DeathmatchDropInService } from "./deathmatch-drop-in-service.js";
import { RedisMatchmaker, type MatchmakingPlayer } from "./matchmaker.js";
import { RedisPartyService } from "./redis-party-service.js";
import { NodeControlService } from "./node-control-service.js";
import { OperationsService } from "./operations-service.js";
import { createObservability } from "./observability.js";
import { RedisQueueService } from "./redis-queue-service.js";
import type { QueueServiceLike } from "./queue-service.js";
import type { PartyServiceLike } from "./party-service.js";
import { InventoryService } from "./inventory-service.js";
import { ServiceMedalService } from "./service-medal-service.js";
import { TradingService } from "./trading-service.js";
import { LauncherDeviceService } from "./launcher-device-service.js";

type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3, {}>>;

async function timedCheck(check: () => Promise<unknown>, timeoutMs = 1_500) {
  const startedAt = performance.now();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Dependency readiness exceeded ${timeoutMs} ms.`)),
          timeoutMs
        );
        timeout.unref();
      })
    ]);
    return { status: "ok" as const, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { status: "error" as const, latencyMs: Math.round(performance.now() - startedAt) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function start() {
  const config = loadConfig();
  const observability = createObservability();
  let sql: Sql | undefined;
  let redisClient: RedisClient | undefined;
  let queueService: QueueServiceLike | undefined;
  let redisQueueService: RedisQueueService | undefined;
  let partyService: PartyServiceLike | undefined;
  let nodeControl: NodeControlService | undefined;
  let matchIngestion: MatchIngestionService | undefined;
  let demoIngestion: DemoIngestionService | undefined;
  let demoObjectStore: S3DemoObjectStore | undefined;
  let operations: OperationsService | undefined;
  let matchRecovery: MatchRecoveryService | undefined;
  let latencyProbes: LatencyProbeService | undefined;
  let deathmatchDropIn: DeathmatchDropInService | undefined;
  let inventory: InventoryService | undefined;
  let trading: TradingService | undefined;
  let tradingExpiryTimer: NodeJS.Timeout | undefined;
  let tradingExpiry: Promise<unknown> | undefined;
  let launcherDevices: LauncherDeviceService | undefined;
  let readySweepTimer: NodeJS.Timeout | undefined;
  let matchmakerTimer: NodeJS.Timeout | undefined;
  let cancellationTimer: NodeJS.Timeout | undefined;
  let vetoFinalizationTimer: NodeJS.Timeout | undefined;
  let leaseSweepTimer: NodeJS.Timeout | undefined;
  let resultSweepTimer: NodeJS.Timeout | undefined;

  if (config.databaseUrl) {
    sql = createConnection(config.databaseUrl);
    await sql`select 1`;
    nodeControl = new NodeControlService(sql, config.manifestSigningSecret);
    inventory = new InventoryService(sql);
    trading = new TradingService(sql);
    tradingExpiryTimer = setInterval(() => {
      if (tradingExpiry) return;
      tradingExpiry = trading!.expireOffers().catch(error => console.error("Trading expiry sweep failed:", error))
        .finally(() => { tradingExpiry = undefined; });
    }, 30_000);
    tradingExpiryTimer.unref();
    if (config.publicUrl) {
      launcherDevices = new LauncherDeviceService(sql, {
        publicUrl: config.publicUrl,
        allowInsecureLoopback: config.environment !== "production"
      });
    }
    operations = new OperationsService(sql);
    if (config.latencyProbes && config.publicUrl) {
      latencyProbes = new LatencyProbeService(sql, {
        publicUrl: config.publicUrl,
        endpoints: config.latencyProbes.endpoints,
        challengeSeconds: config.latencyProbes.challengeSeconds,
        measurementSeconds: config.latencyProbes.measurementSeconds
      });
      console.log(`Configured ${latencyProbes.regions().length} regional latency probes.`);
    }
    matchIngestion = new MatchIngestionService(sql, nodeControl, async (matchId) => {
      await redisQueueService?.completeDeathmatch(matchId);
    });
    if (config.objectStorage) {
      demoObjectStore = new S3DemoObjectStore(config.objectStorage);
      demoIngestion = new DemoIngestionService(sql, matchIngestion, demoObjectStore);
      await demoObjectStore.ready();
      console.log("Connected to S3-compatible object storage.");
    }
    console.log("Connected to PostgreSQL.");
  } else {
    console.log("No DATABASE_URL — PostgreSQL features are disabled.");
  }

  if (config.redisUrl) {
    redisClient = createClient({ url: config.redisUrl });
    redisClient.on("error", (error) => {
      console.error("Redis client error:", error instanceof Error ? error.message : "Unknown error");
    });
    await redisClient.connect();
    await redisClient.ping();
    redisQueueService = await RedisQueueService.create(redisClient);
    queueService = redisQueueService;
    partyService = new RedisPartyService(redisClient);
    readySweepTimer = setInterval(() => {
      Promise.all([
        redisQueueService!.sweepExpiredReadyChecks(),
        redisQueueService!.sweepExpiredMapVetos()
      ]).catch((error) => {
        console.error("Ready-check/map-veto expiry sweep failed:", error);
      });
    }, 1_000);
    readySweepTimer.unref();
    console.log("Connected to Redis.");
  } else {
    console.log("No REDIS_URL — using process-local sessions and rate limits.");
  }

  if (sql && nodeControl && operations) {
    matchRecovery = new MatchRecoveryService(sql, nodeControl, operations, redisQueueService);
  }

  if (sql && redisQueueService && nodeControl) {
    const database = sql;
    const orchestrator = new MatchOrchestrator(database, nodeControl, inventory, config.publicUrl);
    deathmatchDropIn = new DeathmatchDropInService(redisQueueService, orchestrator);
    const matchmaker = new RedisMatchmaker(
      redisQueueService,
      async (playerIds) => {
        const validIds = playerIds.filter((playerId) =>
          /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(playerId)
        );
        if (validIds.length === 0) return new Map<string, MatchmakingPlayer>();
        const measuredPings = latencyProbes
          ? await latencyProbes.pingsForPlayers(validIds)
          : null;
        const rows = await database<{
          id: string;
          steam_id: string | null;
          rating: number;
          is_placement: boolean;
          trust_score: number;
          region: string;
        }[]>`
          select id::text, steam_id, rating, is_placement, trust_score, region
          from players
          where id::text in (
            select jsonb_array_elements_text(${database.json(validIds)})
          )
            and not (is_banned and (ban_expires_at is null or ban_expires_at > now()))
            and not exists (
              select 1 from sanctions sanction
              where sanction.player_id = players.id and sanction.is_active = true
                and sanction.sanction_type in ('cooldown', 'temp_ban', 'perm_ban')
                and (sanction.ends_at is null or sanction.ends_at > now())
            )
        `;
        return new Map(rows.flatMap((row): Array<[string, MatchmakingPlayer]> => {
          if (!row.steam_id) return [];
          const pings = measuredPings?.get(row.id) ?? (latencyProbes
            ? {}
            : Object.fromEntries(REGIONS.map((region) => {
                const sameContinent = region.startsWith("NA") === row.region.startsWith("NA");
                return [region, region === row.region ? 30 : sameContinent ? 55 : 115];
              })));
          return [[row.id, {
            playerId: row.id,
            steamId: row.steam_id,
            rating: row.rating,
            uncertainty: row.is_placement ? 200 : 60,
            moderationBand: row.trust_score < 50 ? "restricted" : "normal",
            regionPings: pings
          }]];
        }));
      },
      {
        readyCheckSeconds: 20,
        competitiveMapSelection: "client-selection",
        reserveMatch: async (plan, matchId) => {
          await operations!.assertAllocationEnabled();
          return orchestrator.reserve(plan, matchId);
        },
        prepareMatch: async (plan, matchId) => {
          await operations!.assertAllocationEnabled();
          return orchestrator.prepare(plan, matchId);
        }
      }
    );
    let running = false;
    let lastFailureLog = 0;
    matchmakerTimer = setInterval(() => {
      if (running) return;
      running = true;
      matchmaker.runOnce().catch((error) => {
        if (Date.now() - lastFailureLog >= 30_000) {
          console.error("Matchmaker pass failed:", error instanceof Error ? error.message : error);
          lastFailureLog = Date.now();
        }
      }).finally(() => {
        running = false;
      });
    }, 1_000);
    matchmakerTimer.unref();
    let reconcilingCancellations = false;
    cancellationTimer = setInterval(() => {
      if (reconcilingCancellations) return;
      reconcilingCancellations = true;
      redisQueueService.listReadyCheckCancellations().then(async (cancellations) => {
        for (const cancellation of cancellations) {
          await redisQueueService.runCancellationExclusive(cancellation.matchId, async () => {
            await orchestrator.cancelPendingMatch(cancellation.matchId, cancellation.reason);
            await redisQueueService.acknowledgeReadyCheckCancellation(cancellation.matchId);
          });
        }
      }).catch((error) => {
        console.error("Ready-check cancellation reconciliation failed:", error);
      }).finally(() => {
        reconcilingCancellations = false;
      });
    }, 1_000);
    cancellationTimer.unref();
    let finalizingVetos = false;
    let lastVetoFailureLog = 0;
    vetoFinalizationTimer = setInterval(() => {
      if (finalizingVetos) return;
      finalizingVetos = true;
      redisQueueService!.listPendingVetoFinalizations().then(async (pending) => {
        for (const finalization of pending) {
          await redisQueueService!.runVetoFinalizationExclusive(
            finalization.state.matchId,
            async () => {
              await operations!.assertAllocationEnabled();
              const assignment = await orchestrator.finalizeMapVeto(finalization.state);
              const delivered = await redisQueueService!.completeMapVeto(
                finalization.state.matchId,
                assignment
              );
              if (delivered !== 0 && delivered !== 10) {
                throw new Error(`Map-veto assignment reached ${delivered}/10 players.`);
              }
            }
          );
        }
      }).catch((error) => {
        if (Date.now() - lastVetoFailureLog >= 30_000) {
          console.error("Map-veto finalization failed:", error instanceof Error ? error.message : error);
          lastVetoFailureLog = Date.now();
        }
      }).finally(() => {
        finalizingVetos = false;
      });
    }, 1_000);
    vetoFinalizationTimer.unref();
    leaseSweepTimer = setInterval(() => {
      nodeControl!.quarantineExpiredLeases().catch((error) => {
        console.error("Expired lease sweep failed:", error);
      });
    }, 5_000);
    leaseSweepTimer.unref();
    let settlingResults = false;
    resultSweepTimer = setInterval(() => {
      if (settlingResults) return;
      settlingResults = true;
      matchIngestion!.settlePendingResults().catch((error) => {
        console.error("Pending match-result settlement failed:", error);
      }).finally(() => {
        settlingResults = false;
      });
    }, 2_000);
    resultSweepTimer.unref();
  }

  const e2ePlayerId = process.env["AFTERTICK_E2E_PLAYER_ID"];
  const devIdentity = e2ePlayerId
    ? {
        playerId: e2ePlayerId,
        steamId: process.env["AFTERTICK_E2E_STEAM_ID"] ?? "e2e-steam-id",
        displayName: process.env["AFTERTICK_E2E_DISPLAY_NAME"] ?? "E2E Player"
      }
    : undefined;
  const testIdentitySecret = config.environment === "test"
    ? process.env["AFTERTICK_E2E_IDENTITY_HEADER_SECRET"]
    : undefined;

  const sessionStore = redisClient
    ? new SessionRedisStore({ client: redisClient, prefix: "aftertick:session:" })
    : undefined;
  const rateLimitStore = (prefix: string) => redisClient
    ? new RateLimitRedisStore({
        prefix,
        sendCommand: (...args: string[]) => redisClient!.sendCommand(args)
      })
    : undefined;

  const app = createApp({
    sql,
    playerReads: e2ePlayerId ? createE2EReadService(e2ePlayerId) : undefined,
    queueService,
    partyService,
    nodeControl,
    matchIngestion,
    demoIngestion,
    latencyProbes,
    inventory,
    serviceMedals: sql ? new ServiceMedalService(sql) : undefined,
    trading,
    launcherDevices,
    operations,
    matchRecovery,
    deathmatchDropIn,
    bootstrapAdminSteamId: config.bootstrapAdminSteamId,
    observability,
    metricsToken: config.metricsToken,
    metricsSnapshot: async () => {
      const snapshot: Record<string, number> = {
        process_uptime_seconds: Math.floor(process.uptime())
      };
      if (sql) {
        const [databaseMetrics] = await sql<{
          active_matches: number;
          healthy_nodes: number;
          invalid_demos: number;
          pending_reports: number;
          open_recovery_incidents: number;
        }[]>`
          select
            (select count(*)::int from matches where status in ('pending', 'live')) as active_matches,
            (select count(*)::int from game_nodes where status = 'active' and last_heartbeat_at > now() - interval '30 seconds') as healthy_nodes,
            (select count(*)::int from match_demo_artifacts where status = 'invalid') as invalid_demos,
            (select count(*)::int from reports where status in ('pending', 'under_review')) as pending_reports,
            (select count(*)::int from match_recovery_incidents where status in ('open', 'resolving')) as open_recovery_incidents
        `;
        if (databaseMetrics) Object.assign(snapshot, databaseMetrics);
      }
      if (redisClient) snapshot.queue_tickets = await redisClient.zCard("aftertick:queue:tickets");
      return snapshot;
    },
    devIdentity,
    testIdentity: testIdentitySecret && sql
      ? {
          secret: testIdentitySecret,
          resolve: async (playerId) => {
            if (!/^[a-f0-9-]{36}$/i.test(playerId)) return null;
            const [player] = await sql!<{
              steam_id: string | null;
              display_name: string;
            }[]>`
              select steam_id, display_name from players where id = ${playerId}
            `;
            return player?.steam_id
              ? { steamId: player.steam_id, displayName: player.display_name }
              : null;
          }
        }
      : undefined,
    allowedOrigins: config.allowedOrigins,
    session: {
      store: sessionStore,
      secret: config.sessionSecret,
      secureCookies: config.secureCookies
    },
    rateLimits: {
      windowMs: config.rateLimitWindowMs,
      apiLimit: config.apiRateLimit,
      authLimit: config.authRateLimit,
      apiStore: rateLimitStore("aftertick:rate:api:"),
      authStore: rateLimitStore("aftertick:rate:auth:"),
      nodeStore: rateLimitStore("aftertick:rate:node:")
    },
    readiness: async () => {
      const checks = {
        postgres: sql
          ? await timedCheck(() => sql!`select 1`)
          : { status: "disabled" as const },
        redis: redisClient
          ? redisClient.isReady
            ? await timedCheck(() => redisClient!.ping())
            : { status: "error" as const, latencyMs: 0 }
          : { status: "disabled" as const },
        objectStorage: demoObjectStore
          ? await timedCheck(() => demoObjectStore!.ready())
          : { status: "disabled" as const }
      };
      return {
        ready: Object.values(checks).every((check) => check.status !== "error"),
        checks
      };
    }
  });

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`Aftertick API listening on http://${config.bindHost}:${config.port}`);
    if (devIdentity) {
      console.log(`Test identity enabled for ${devIdentity.playerId}.`);
    }
  });

  let stopping = false;
  async function stop(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; shutting down.`);
    if (readySweepTimer) clearInterval(readySweepTimer);
    if (matchmakerTimer) clearInterval(matchmakerTimer);
    if (cancellationTimer) clearInterval(cancellationTimer);
    if (vetoFinalizationTimer) clearInterval(vetoFinalizationTimer);
    if (leaseSweepTimer) clearInterval(leaseSweepTimer);
    if (resultSweepTimer) clearInterval(resultSweepTimer);
    if (tradingExpiryTimer) clearInterval(tradingExpiryTimer);
    await tradingExpiry;
    await closeServer(server);
    await queueService?.close?.();
    if (redisClient?.isOpen) await redisClient.quit();
    demoObjectStore?.close();
    if (sql) await sql.end({ timeout: 5 });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stop(signal).then(
        () => process.exit(0),
        (error) => {
          console.error("Shutdown failed:", error);
          process.exit(1);
        }
      );
    });
  }
}

start().catch((error) => {
  console.error("Failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
