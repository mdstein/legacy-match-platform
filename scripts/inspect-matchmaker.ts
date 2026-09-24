import { createConnection } from "@aftertick/db";
import { createClient } from "redis";
import { REGIONS } from "../apps/api/src/catalog.js";
import {
  findMatch,
  type MatchmakingPlayer,
  type MatchmakingTicket
} from "../apps/api/src/matchmaker.js";
import { RedisQueueService } from "../apps/api/src/redis-queue-service.js";

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]
    ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick";
  const redisUrl = process.env["REDIS_URL"]
    ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0";
  const sql = createConnection(databaseUrl);
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  const queue = await RedisQueueService.create(redis);
  try {
    const tickets = await queue.listSearchingTickets();
    const ids = [...new Set(tickets.flatMap((ticket) => ticket.memberPlayerIds))];
    const rows = ids.length === 0 ? [] : await sql<{
      id: string;
      steam_id: string | null;
      rating: number;
      is_placement: boolean;
      trust_score: number;
      region: string;
    }[]>`
      select id::text, steam_id, rating, is_placement, trust_score, region
      from players
      where id::text in (select jsonb_array_elements_text(${sql.json(ids)}))
    `;
    const profiles = new Map<string, MatchmakingPlayer>(rows.flatMap((row) => {
      if (!row.steam_id) return [];
      return [[row.id, {
        playerId: row.id,
        steamId: row.steam_id,
        rating: row.rating,
        uncertainty: row.is_placement ? 200 : 60,
        moderationBand: row.trust_score < 50 ? "restricted" as const : "normal" as const,
        regionPings: Object.fromEntries(REGIONS.map((region) => [
          region,
          region === row.region ? 30 : region.startsWith("NA") === row.region.startsWith("NA") ? 55 : 115
        ]))
      }]] as Array<[string, MatchmakingPlayer]>;
    }));
    const candidates = tickets.flatMap((ticket): MatchmakingTicket[] => {
      const players = ticket.memberPlayerIds.map((id) => profiles.get(id));
      if (!ticket.queue.joinedAt || players.some((player) => !player)) return [];
      return [{
        id: ticket.id,
        fencingToken: ticket.fencingToken,
        joinedAt: ticket.queue.joinedAt,
        mode: ticket.queue.mode ?? "competitive",
        regions: ticket.queue.regions,
        maps: ticket.queue.maps,
        players: players as MatchmakingPlayer[],
        source: ticket
      }];
    });
    const plan = findMatch(candidates);
    console.log(JSON.stringify({
      tickets: tickets.length,
      playerIds: ids.length,
      profiles: profiles.size,
      candidates: candidates.length,
      plan: plan ? {
        tickets: plan.tickets.length,
        players: plan.tickets.reduce((total, ticket) => total + ticket.players.length, 0),
        mode: plan.mode,
        map: plan.map,
        region: plan.region,
        quality: plan.quality
      } : null
    }, null, 2));
  } finally {
    await queue.close();
    await redis.quit();
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
