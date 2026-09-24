import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isOwnershipGeneration } from "@aftertick/contracts";
import { lockInventoryPlayers, settleMatch, type Sql } from "@aftertick/db";
import type postgres from "postgres";
import { NodeControlService, type SignedMatchManifest } from "./node-control-service.js";

export interface IngestedMatchEvent {
  eventId: string;
  sequence: number;
  occurredAt: string;
  type: string;
  round?: number | undefined;
  tick?: number | undefined;
  payload: Record<string, unknown>;
}

export interface MatchEventBatch {
  leaseId: string;
  fencingToken: string;
  events: IngestedMatchEvent[];
}

export interface CommittedStatTrakReceipt {
  kind: "stattrak.committed";
  version: 1;
  matchId: string;
  leaseId: string;
  fencingToken: string;
  batchChecksum: string;
  sequence: number;
  counts: Array<{ steamId: string; assetId: string; count: number; ownershipGeneration?: string }>;
}

export interface MatchResultPlayerStats {
  steamId: string;
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

export interface MatchResultSubmission {
  resultVersion: 1;
  resultId: string;
  idempotencyKey: string;
  leaseId: string;
  fencingToken: string;
  alphaRounds: number;
  bravoRounds: number;
  reason: "completed" | "surrender" | "forfeit";
  completedAt: string;
  stats: MatchResultPlayerStats[];
}

export interface MatchProgressionReceipt {
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
}

export interface MatchResultIngestionOutcome {
  status: "pending" | "settled" | "conflicting";
  duplicate: boolean;
  progression: MatchProgressionReceipt[];
}

interface LeaseAuthority {
  manifest: Record<string, unknown>;
}

const SOURCE_WEAPON_KEYS = new Map<string, string>([
  ["m4a1", "m4a4"]
]);

export function statTrakAssetForKill(
  manifest: Pick<SignedMatchManifest, "cosmetics">,
  payload: Record<string, unknown>
): { playerId: string; assetId: string; ownershipGeneration?: string } | null {
  const attackerSteamId = payload["attackerSteamId"];
  const victimSteamId = payload["victimSteamId"];
  const rawWeapon = payload["weapon"];
  const weaponItemId = payload["weaponItemId"];
  const weaponOriginalOwnerSteamId = payload["weaponOriginalOwnerSteamId"];
  if (typeof attackerSteamId !== "string" || !/^\d{17}$/.test(attackerSteamId)
    || typeof victimSteamId !== "string"
    || (victimSteamId !== "" && !/^\d{17}$/.test(victimSteamId))
    || victimSteamId === attackerSteamId
    || typeof weaponItemId !== "string" || !/^[1-9]\d{0,19}$/.test(weaponItemId)
    || BigInt(weaponItemId) > 18_446_744_073_709_551_615n
    || weaponOriginalOwnerSteamId !== attackerSteamId
    || typeof rawWeapon !== "string" || !/^[a-z0-9_]{1,63}$/.test(rawWeapon)) {
    return null;
  }
  const weapon = rawWeapon.replace(/^weapon_/, "");
  const player = manifest.cosmetics?.find((candidate) => candidate.steamId === attackerSteamId);
  if (!player) return null;
  // The signed server event identifies the item used at the moment of the kill.
  // Never infer an asset from the initial equipped flag: loadouts are mutable,
  // can differ by team, and a player can pick up someone else's weapon. Older
  // events without item/owner evidence are retained but cannot change counters.
  const item = player.items.find((candidate) => candidate.assetId === weaponItemId
    && candidate.source === "b2g"
    && candidate.itemKind === "cosmetic"
    && candidate.quality === 9
    && candidate.killEaterScoreType === 0
    && candidate.killEaterValue !== null
    && (weapon === "knife" || weapon === "knife_t"
      ? candidate.loadoutSlot === 0
      : candidate.weaponKey === (SOURCE_WEAPON_KEYS.get(weapon) ?? weapon)));
  if (!item) return null;
  const generation = item.ownershipGeneration ?? "0";
  const observed = payload["weaponOwnershipGeneration"] ?? "0";
  if (!isOwnershipGeneration(generation) || !isOwnershipGeneration(observed) || generation !== observed) return null;
  return { playerId: player.playerId, assetId: item.assetId,
    ...(item.ownershipGeneration !== undefined ? { ownershipGeneration: generation } : {}) };
}

interface ResultRow {
  match_id: string;
  lease_id: string;
  payload_checksum: string;
  alpha_rounds: number;
  bravo_rounds: number;
  status: "pending" | "settled" | "conflicting";
}

type ParticipationViolationType = "no_show" | "abandon";

const PARTICIPATION_PENALTY_MINUTES: Record<ParticipationViolationType, readonly number[]> = {
  no_show: [15, 60, 360, 1_440, 10_080],
  abandon: [30, 120, 720, 2_880, 10_080]
};

export function participationPenaltyMinutes(
  violationType: ParticipationViolationType,
  offenseNumber: number
): number {
  if (!Number.isInteger(offenseNumber) || offenseNumber < 1) {
    throw new Error("Participation offense number must be a positive integer.");
  }
  const ladder = PARTICIPATION_PENALTY_MINUTES[violationType];
  return ladder[Math.min(offenseNumber, ladder.length) - 1]!;
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function signMatchIngestion(value: unknown, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("base64url");
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function signaturesMatch(value: unknown, signature: string, secret: string): boolean {
  const expected = Buffer.from(signMatchIngestion(value, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class MatchIngestionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function validatedAntiCheatSignalPayload(
  payload: Record<string, unknown>
): { steamId: string; mode: "competitive" | "deathmatch" } {
  const steamId = payload["steamId"];
  const module = payload["module"];
  const detectionType = payload["detectionType"];
  const mode = payload["mode"];
  const automaticAction = payload["automaticAction"];
  const synthetic = payload["synthetic"] ?? false;
  if (
    payload["policyVersion"] !== 1
    || typeof steamId !== "string"
    || !/^\d{17}$/.test(steamId)
    || typeof module !== "string"
    || !/^[A-Za-z0-9_.-]{1,64}$/.test(module)
    || !Number.isInteger(detectionType)
    || Number(detectionType) < 0
    || Number(detectionType) > 65_535
    || (mode !== "competitive" && mode !== "deathmatch")
    || automaticAction !== false
    || typeof synthetic !== "boolean"
    || (synthetic && (module !== "b2g_pipeline_self_test" || detectionType !== 0))
    || (!synthetic && module === "b2g_pipeline_self_test")
  ) {
    throw new MatchIngestionError(400, "Anti-cheat evidence is malformed.");
  }
  return { steamId, mode };
}

export class MatchIngestionService {
  constructor(
    private readonly sql: Sql,
    private readonly nodes: NodeControlService,
    private readonly onMatchTerminal?: (matchId: string) => Promise<void>
  ) {}

  async ingestEvents(
    nodeToken: string,
    matchId: string,
    batch: MatchEventBatch,
    signature: string,
    includeCounterReceipt = false
  ): Promise<{ inserted: number; duplicates: number; conflicts: number;
    counterReceipt?: { receipt: CommittedStatTrakReceipt; signature: string } }> {
    const node = await this.nodes.authenticate(nodeToken);
    const outcome = await this.sql.begin(async (transaction) => {
      const manifest = await this.authorizeLocked(
        transaction,
        node.id,
        matchId,
        batch.leaseId,
        batch.fencingToken,
        batch,
        signature
      );
      let inserted = 0;
      let duplicates = 0;
      let conflicts = 0;
      // Lock affected owners before item writes, consistently with trading.
      const affectedOwners = batch.events.flatMap(event => {
        if (event.type !== "player.killed") return [];
        const item = statTrakAssetForKill(manifest as Pick<SignedMatchManifest, "cosmetics">, event.payload);
        return item ? [item.playerId] : [];
      });
      if (batch.events.some(event => event.type === "roster.no_show" || event.type === "roster.abandoned")) {
        const roster = await transaction<{ player_id: string }[]>`select player_id from rosters where match_id=${matchId}`;
        affectedOwners.push(...roster.map(row => row.player_id));
      }
      await lockInventoryPlayers(transaction, affectedOwners);
      const counterAssets = new Map<string, { playerId: string; assetId: string; ownershipGeneration?: string }>();
      for (const event of batch.events) {
        const eventChecksum = checksum(event);
        const [created] = await transaction<{ id: string }[]>`
          insert into match_events (
            match_id, event_id, sequence, occurred_at, lease_id,
            event_type, round, tick, payload, payload_checksum
          ) values (
            ${matchId}, ${event.eventId}, ${event.sequence}, ${event.occurredAt},
            ${batch.leaseId}, ${event.type}, ${event.round ?? null}, ${event.tick ?? null},
            ${transaction.json(asJson(event.payload))}, ${eventChecksum}
          )
          on conflict do nothing
          returning id
        `;
        if (created) {
          inserted += 1;
          if (event.type === "match.live") {
            await transaction`
              update matches
              set status = 'live', started_at = coalesce(started_at, ${event.occurredAt})
              where id = ${matchId} and status = 'pending'
            `;
          }
          if (event.type === "match.aborted") {
            const cancelledReason = event.payload["reason"] === "no_show"
              ? "no_show"
              : "server_abort";
            await transaction`
              update matches
              set status = 'cancelled', cancelled_reason = ${cancelledReason},
                  ended_at = coalesce(ended_at, ${event.occurredAt})
              where id = ${matchId} and status in ('pending', 'live')
            `;
          }
          if (event.type === "roster.no_show" || event.type === "roster.abandoned") {
            await this.recordParticipationViolation(transaction, matchId, event);
          }
          if (event.type === "anticheat.signal") {
            await this.validateAntiCheatSignal(transaction, matchId, event);
          }
          if (event.type === "player.killed") {
            const statTrak = statTrakAssetForKill(
              manifest as Pick<SignedMatchManifest, "cosmetics">,
              event.payload
            );
            if (statTrak) {
              if (includeCounterReceipt) counterAssets.set(statTrak.assetId, statTrak);
              await transaction`
                update player_b2g_inventory_items
                set kill_eater_value = least(kill_eater_value + 1, 4294967295),
                    inventory_position = inventory_position & 1073741823
                where player_id = ${statTrak.playerId}
                  and asset_id = ${statTrak.assetId}
                  and ownership_generation = ${statTrak.ownershipGeneration ?? "0"}::bigint
                  and source = 'b2g' and state = 'active' and item_kind = 'cosmetic'
                  and quality = 9 and kill_eater_score_type = 0
                  and kill_eater_value is not null
              `;
            }
          }
          if (
            event.type === "roster.admitted"
            || event.type === "roster.reconnected"
            || event.type === "roster.disconnected"
          ) {
            await this.recordRosterPresence(transaction, matchId, event);
          }
          continue;
        }

        const [existing] = await transaction<{
          event_id: string;
          sequence: bigint;
          payload_checksum: string;
        }[]>`
          select event_id, sequence, payload_checksum
          from match_events
          where match_id = ${matchId}
            and (event_id = ${event.eventId} or sequence = ${event.sequence})
          limit 1
        `;
        if (
          existing?.event_id === event.eventId
          && Number(existing.sequence) === event.sequence
          && existing.payload_checksum === eventChecksum
        ) {
          duplicates += 1;
          if (includeCounterReceipt && event.type === "player.killed") {
            const asset = statTrakAssetForKill(manifest as Pick<SignedMatchManifest, "cosmetics">, event.payload);
            if (asset) counterAssets.set(asset.assetId, asset);
          }
          continue;
        }
        conflicts += 1;
        await transaction`
          insert into match_event_conflicts (
            match_id, lease_id, event_id, sequence, payload_checksum,
            canonical_checksum, payload
          ) values (
            ${matchId}, ${batch.leaseId}, ${event.eventId}, ${event.sequence},
            ${eventChecksum}, ${existing?.payload_checksum ?? eventChecksum},
            ${transaction.json(asJson(event))}
          )
          on conflict do nothing
        `;
        await transaction`
          update matches set status = 'disputed'
          where id = ${matchId} and status <> 'cancelled'
        `;
      }
      if (counterAssets.size > 0) {
        // Re-read after all increments, including exact duplicate retries. The
        // response is returned only after this transaction commits. Never sign
        // a count for conflicting event data, another owner or a consumed item.
        const candidates = [...counterAssets.values()].map(item => ({...item,ownershipGeneration:item.ownershipGeneration ?? "0"}));
        const rows = await transaction<{ steam_id: string; asset_id: string; count: string; ownership_generation: string }[]>`
          select player.steam_id, item.asset_id, item.kill_eater_value::text as count,
            item.ownership_generation::text as ownership_generation
          from player_b2g_inventory_items item
          join players player on player.id = item.player_id
          join jsonb_to_recordset(${transaction.json(asJson(candidates))})
            as candidate("playerId" uuid, "assetId" text, "ownershipGeneration" bigint)
            on candidate."playerId" = item.player_id and candidate."assetId" = item.asset_id
              and candidate."ownershipGeneration" = item.ownership_generation
          where item.source = 'b2g' and item.state = 'active' and item.item_kind = 'cosmetic'
            and item.quality = 9 and item.kill_eater_score_type = 0 and item.kill_eater_value is not null
          order by player.steam_id, item.asset_id
        `;
        const receipt: CommittedStatTrakReceipt = {
          kind: "stattrak.committed", version: 1, matchId,
          leaseId: batch.leaseId, fencingToken: batch.fencingToken,
          batchChecksum: checksum(batch), sequence: Math.max(...batch.events.map((event) => event.sequence)),
          counts: rows.map((row) => ({ steamId: row.steam_id, assetId: row.asset_id, count: Number(row.count),
            ...(row.ownership_generation !== "0" ? {ownershipGeneration:row.ownership_generation} : {}) }))
        };
        return { inserted, duplicates, conflicts, counterReceipt: {
          receipt, signature: signMatchIngestion(receipt, String(manifest["eventIngestSecret"]))
        } };
      }
      return { inserted, duplicates, conflicts };
    });
    if (batch.events.some((event) => event.type === "match.aborted")) {
      await this.nodes.releaseLease(batch.leaseId, "server_abort");
      // Queue delivery is intentionally retried for duplicate terminal batches;
      // the Redis completion script is idempotent, so this heals an earlier
      // callback failure without retaining a stale assigned ticket.
      await this.onMatchTerminal?.(matchId);
    }
    return outcome;
  }

  async ingestResult(
    nodeToken: string,
    matchId: string,
    submission: MatchResultSubmission,
    signature: string
  ): Promise<MatchResultIngestionOutcome> {
    const node = await this.nodes.authenticate(nodeToken);
    const payloadChecksum = checksum(submission);
    const stored = await this.sql.begin(async (transaction) => {
      await this.authorizeLocked(
        transaction,
        node.id,
        matchId,
        submission.leaseId,
        submission.fencingToken,
        submission,
        signature
      );
      const [match] = await transaction<{ mode: "competitive" | "deathmatch" }[]>`
        select mode from matches where id = ${matchId}
      `;
      if (!match) throw new MatchIngestionError(404, "The leased match no longer exists.");
      const roster = await transaction<{ player_id: string; steam_id: string }[]>`
        select roster.player_id, player.steam_id
        from rosters roster
        join players player on player.id = roster.player_id
        where roster.match_id = ${matchId}
        order by roster.team, roster.slot
      `;
      const expectedSteamIds = new Set(roster.map((player) => player.steam_id));
      const submittedSteamIds = new Set(submission.stats.map((line) => line.steamId));
      const expectedPlayers = match.mode === "deathmatch" ? roster.length : 10;
      if (
        roster.length !== expectedPlayers
        || (match.mode === "deathmatch" && (expectedPlayers < 1 || expectedPlayers > 14))
        || submittedSteamIds.size !== expectedPlayers
        || [...submittedSteamIds].some((steamId) => !expectedSteamIds.has(steamId))
      ) {
        throw new MatchIngestionError(409, "The result statistics do not match the leased roster.");
      }

      const [created] = await transaction<{ id: string }[]>`
        insert into match_results (
          id, match_id, lease_id, result_version, idempotency_key,
          payload_checksum, alpha_rounds, bravo_rounds, reason, completed_at, payload
        ) values (
          ${submission.resultId}, ${matchId}, ${submission.leaseId},
          ${submission.resultVersion}, ${submission.idempotencyKey}, ${payloadChecksum},
          ${submission.alphaRounds}, ${submission.bravoRounds}, ${submission.reason},
          ${submission.completedAt}, ${transaction.json(asJson(submission))}
        )
        on conflict do nothing
        returning id
      `;
      const [canonical] = await transaction<ResultRow[]>`
        select match_id, lease_id, payload_checksum, alpha_rounds, bravo_rounds, status
        from match_results
        where match_id = ${matchId}
        for update
      `;
      if (!canonical) throw new Error("The canonical result could not be loaded.");
      if (canonical.payload_checksum !== payloadChecksum) {
        await transaction`
          insert into match_result_conflicts (
            match_id, lease_id, idempotency_key, payload_checksum,
            canonical_checksum, payload
          ) values (
            ${matchId}, ${submission.leaseId}, ${submission.idempotencyKey},
            ${payloadChecksum}, ${canonical.payload_checksum},
            ${transaction.json(asJson(submission))}
          )
          on conflict do nothing
        `;
        await transaction`
          update match_results set status = 'conflicting' where match_id = ${matchId}
        `;
        await transaction`
          update matches set status = 'disputed'
          where id = ${matchId} and status <> 'cancelled'
        `;
        return { status: "conflicting" as const, duplicate: false };
      }

      if (created) {
        const playerBySteam = new Map(roster.map((player) => [player.steam_id, player.player_id]));
        for (const line of submission.stats) {
          await transaction`
            insert into match_stats (
              match_id, player_id, kills, deaths, assists, adr, kast,
              opening_kills, opening_deaths, trades, clutches, flash_assists,
              utility_damage, rounds_played
            ) values (
              ${matchId}, ${playerBySteam.get(line.steamId)!}, ${line.kills}, ${line.deaths},
              ${line.assists}, ${line.adr}, ${line.kast}, ${line.openingKills},
              ${line.openingDeaths}, ${line.trades}, ${line.clutches},
              ${line.flashAssists}, ${line.utilityDamage}, ${line.roundsPlayed}
            )
            on conflict (match_id, player_id) do update set
              kills = excluded.kills, deaths = excluded.deaths, assists = excluded.assists,
              adr = excluded.adr, kast = excluded.kast,
              opening_kills = excluded.opening_kills,
              opening_deaths = excluded.opening_deaths, trades = excluded.trades,
              clutches = excluded.clutches, flash_assists = excluded.flash_assists,
              utility_damage = excluded.utility_damage, rounds_played = excluded.rounds_played
          `;
        }
      }
      return { status: canonical.status, duplicate: !created };
    });

    if (stored.status === "pending") {
      try {
        await this.settlePendingResult(matchId);
        return {
          status: "settled",
          duplicate: stored.duplicate,
          progression: await this.progressionForMatch(matchId)
        };
      } catch {
        return { ...stored, progression: [] };
      }
    }
    return {
      ...stored,
      progression: stored.status === "settled"
        ? await this.progressionForMatch(matchId)
        : []
    };
  }

  async settlePendingResult(matchId: string): Promise<boolean> {
    const [result] = await this.sql<ResultRow[]>`
      select match_id, lease_id, payload_checksum, alpha_rounds, bravo_rounds, status
      from match_results
      where match_id = ${matchId}
    `;
    if (!result || result.status !== "pending") return false;
    await settleMatch(this.sql, {
      matchId,
      alphaRounds: result.alpha_rounds,
      bravoRounds: result.bravo_rounds
    });
    await this.nodes.releaseLease(result.lease_id, "match_completed");
    await this.onMatchTerminal?.(matchId);
    await this.sql`
      update match_results
      set status = 'settled', settled_at = coalesce(settled_at, now())
      where match_id = ${matchId} and status = 'pending'
    `;
    return true;
  }

  async settlePendingResults(limit = 20): Promise<number> {
    const rows = await this.sql<{ match_id: string }[]>`
      select match_id from match_results
      where status = 'pending'
      order by received_at
      limit ${limit}
    `;
    let settled = 0;
    for (const row of rows) {
      if (await this.settlePendingResult(row.match_id)) settled += 1;
    }
    return settled;
  }

  private async progressionForMatch(matchId: string): Promise<MatchProgressionReceipt[]> {
    const rows = await this.sql<Array<{
      steam_id: string;
      delta: number;
      previous_level: number;
      previous_xp: number;
      next_level: number;
      next_xp: number;
      service_drop_id: string | null;
      service_drop_level: number | null;
      mode: "competitive" | "deathmatch";
    }>>`
      select player.steam_id, ledger.delta, ledger.previous_level,
             ledger.previous_xp, ledger.next_level, ledger.next_xp,
             reward.id as service_drop_id,
             reward.service_level as service_drop_level,
             game.mode::text as mode
      from player_xp_ledger ledger
      join players player on player.id = ledger.player_id
      join matches game on game.id = ledger.match_id
      join rosters roster
        on roster.match_id = ledger.match_id and roster.player_id = ledger.player_id
      left join player_service_drops reward
        on reward.match_id = ledger.match_id and reward.player_id = ledger.player_id
      where ledger.match_id = ${matchId}
      order by roster.team, roster.slot
    `;
    return rows.map((entry) => ({
      steamId: entry.steam_id,
      earnedXp: entry.delta,
      previousLevel: entry.previous_level,
      previousXp: entry.previous_xp,
      nextLevel: entry.next_level,
      nextXp: entry.next_xp,
      xpCategory: entry.mode === "deathmatch" ? 1 : 2,
      serviceDrop: entry.service_drop_id && entry.service_drop_level
        ? {
            id: entry.service_drop_id,
            serviceLevel: entry.service_drop_level,
            rewardType: "b2g_service_drop" as const
          }
        : null
    }));
  }

  async authorizeSubmission(
    nodeToken: string,
    matchId: string,
    leaseId: string,
    fencingToken: string,
    signedValue: unknown,
    signature: string
  ): Promise<Record<string, unknown>> {
    const node = await this.nodes.authenticate(nodeToken);
    const [authority] = await this.sql<LeaseAuthority[]>`
      select lease.manifest
      from server_leases lease
      join server_instances instance on instance.id = lease.server_instance_id
      where lease.id = ${leaseId}
        and lease.match_id = ${matchId}
        and lease.fencing_token = ${fencingToken}::bigint
        and instance.node_id = ${node.id}
        and lease.status in ('active', 'released')
        and (lease.released_at is null or lease.released_at >= now() - interval '15 minutes')
    `;
    if (!authority) {
      throw new MatchIngestionError(401, "The match ingestion authority is no longer valid.");
    }
    const secret = authority.manifest["eventIngestSecret"];
    if (typeof secret !== "string" || secret.length < 32 || !signaturesMatch(signedValue, signature, secret)) {
      throw new MatchIngestionError(401, "The match ingestion signature is invalid.");
    }
    return authority.manifest;
  }

  private async recordRosterPresence(
    transaction: postgres.TransactionSql,
    matchId: string,
    event: IngestedMatchEvent
  ): Promise<void> {
    const steamId = event.payload["steamId"];
    if (typeof steamId !== "string" || !/^\d{17}$/.test(steamId)) {
      throw new MatchIngestionError(400, "Roster-presence evidence is malformed.");
    }
    const [roster] = await transaction<{ player_id: string }[]>`
      select roster.player_id::text
      from rosters roster
      join players player on player.id = roster.player_id
      where roster.match_id = ${matchId} and player.steam_id = ${steamId}
    `;
    if (!roster) {
      throw new MatchIngestionError(409, "Roster-presence evidence is not on the human roster.");
    }
    const connected = event.type !== "roster.disconnected";
    await transaction`
      insert into match_player_presence (
        match_id, player_id, connected, connected_at, disconnected_at, updated_at
      ) values (
        ${matchId}, ${roster.player_id}, ${connected},
        ${connected ? event.occurredAt : null},
        ${connected ? null : event.occurredAt},
        ${event.occurredAt}
      )
      on conflict (match_id, player_id) do update set
        connected = excluded.connected,
        connected_at = case
          when excluded.connected then excluded.connected_at
          else match_player_presence.connected_at
        end,
        disconnected_at = case
          when excluded.connected then null
          else excluded.disconnected_at
        end,
        updated_at = excluded.updated_at
    `;
  }

  private async validateAntiCheatSignal(
    transaction: postgres.TransactionSql,
    matchId: string,
    event: IngestedMatchEvent
  ): Promise<void> {
    const { steamId, mode } = validatedAntiCheatSignalPayload(event.payload);
    const [roster] = await transaction<{ player_id: string }[]>`
      select roster.player_id::text
      from rosters roster
      join players player on player.id = roster.player_id
      join matches game on game.id = roster.match_id
      where roster.match_id = ${matchId}
        and player.steam_id = ${steamId}
        and game.mode = ${mode}
    `;
    if (!roster) {
      throw new MatchIngestionError(409, "Anti-cheat evidence is not tied to the active human roster.");
    }
  }

  private async recordParticipationViolation(
    transaction: postgres.TransactionSql,
    matchId: string,
    event: IngestedMatchEvent
  ): Promise<void> {
    const [match] = await transaction<{ mode: "competitive" | "deathmatch" }[]>`
      select mode
      from matches
      where id = ${matchId}
    `;
    if (!match) {
      throw new MatchIngestionError(409, "Participation-violation match does not exist.");
    }
    // Drop-in Deathmatch has no fixed attendance commitment. Humans may join or
    // leave freely while bots backfill, so no-show and abandon evidence must
    // never create a platform sanction even if an outdated game plugin emits it.
    if (match.mode === "deathmatch") return;

    const violationType: ParticipationViolationType = event.type === "roster.no_show"
      ? "no_show"
      : "abandon";
    const steamId = event.payload["steamId"];
    const team = event.payload["team"];
    const policyVersion = event.payload["policyVersion"];
    const absenceStartedAt = event.payload["absenceStartedAt"];
    const graceSeconds = event.payload["graceSeconds"];
    const occurredAt = new Date(event.occurredAt);
    if (
      typeof steamId !== "string"
      || !/^\d{17}$/.test(steamId)
      || (team !== "alpha" && team !== "bravo" && team !== "ffa")
      || policyVersion !== 1
      || !Number.isInteger(absenceStartedAt)
      || !Number.isInteger(graceSeconds)
      || Number(graceSeconds) < 30
      || Number(graceSeconds) > 900
    ) {
      throw new MatchIngestionError(400, "Participation-violation evidence is malformed.");
    }
    const absenceDate = new Date(Number(absenceStartedAt) * 1_000);
    if (
      !Number.isFinite(occurredAt.getTime())
      || !Number.isFinite(absenceDate.getTime())
      || occurredAt.getTime() - absenceDate.getTime() < Number(graceSeconds) * 1_000
    ) {
      throw new MatchIngestionError(400, "Participation-violation grace evidence is invalid.");
    }

    const expectedStatus = violationType === "no_show" ? "pending" : "live";
    const [roster] = await transaction<{
      player_id: string;
      roster_team: "alpha" | "bravo" | "ffa";
      match_status: string;
    }[]>`
      select player.id as player_id, roster.team as roster_team,
             game.status::text as match_status
      from rosters roster
      join players player on player.id = roster.player_id
      join matches game on game.id = roster.match_id
      where roster.match_id = ${matchId} and player.steam_id = ${steamId}
      for update of player, game
    `;
    if (!roster || roster.roster_team !== team || roster.match_status !== expectedStatus) {
      throw new MatchIngestionError(
        409,
        "Participation-violation evidence does not match the authoritative roster state."
      );
    }

    const [existing] = await transaction<{ id: string }[]>`
      select id from match_participation_violations
      where match_id = ${matchId} and player_id = ${roster.player_id}
        and violation_type = ${violationType}
    `;
    if (existing) return;

    const [history] = await transaction<{ count: number }[]>`
      select count(*)::int as count
      from match_participation_violations violation
      join sanctions sanction on sanction.id = violation.sanction_id
      where violation.player_id = ${roster.player_id}
        and violation.created_at >= now() - interval '30 days'
        and sanction.is_active = true
    `;
    const offenseNumber = (history?.count ?? 0) + 1;
    const penaltyMinutes = participationPenaltyMinutes(violationType, offenseNumber);
    const reason = violationType === "no_show"
      ? `Automatic warmup no-show penalty (policy v1, offense ${offenseNumber} in 30 days).`
      : `Automatic live-match abandon penalty (policy v1, offense ${offenseNumber} in 30 days).`;
    const [sanction] = await transaction<{ id: string }[]>`
      insert into sanctions (
        player_id, issued_by, sanction_type, reason, match_id,
        duration_minutes, starts_at, ends_at
      ) values (
        ${roster.player_id}, null, 'cooldown', ${reason}, ${matchId},
        ${penaltyMinutes}, now(), now() + (${penaltyMinutes}::int * interval '1 minute')
      )
      returning id
    `;
    if (!sanction) throw new Error("Automatic participation sanction creation failed.");
    const [violation] = await transaction<{ id: string }[]>`
      insert into match_participation_violations (
        match_id, player_id, event_id, violation_type, occurred_at,
        absence_started_at, grace_seconds, policy_version, offense_number,
        penalty_minutes, sanction_id
      ) values (
        ${matchId}, ${roster.player_id}, ${event.eventId}, ${violationType},
        ${event.occurredAt}, ${absenceDate}, ${Number(graceSeconds)}, 1,
        ${offenseNumber}, ${penaltyMinutes}, ${sanction.id}
      )
      returning id
    `;
    if (!violation) throw new Error("Automatic participation violation creation failed.");
    await transaction`
      insert into audit_log (actor_id, action, target_type, target_id, detail)
      values (
        null, 'sanction.automatic_participation', 'sanction', ${sanction.id},
        ${transaction.json(asJson({
          matchId,
          playerId: roster.player_id,
          eventId: event.eventId,
          violationType,
          policyVersion: 1,
          offenseNumber,
          penaltyMinutes
        }))}
      )
    `;
  }

  private async authorizeLocked(
    transaction: postgres.TransactionSql,
    nodeId: string,
    matchId: string,
    leaseId: string,
    fencingToken: string,
    signedValue: unknown,
    signature: string
  ): Promise<Record<string, unknown>> {
    const [authority] = await transaction<LeaseAuthority[]>`
      select lease.manifest
      from server_leases lease
      join server_instances instance on instance.id = lease.server_instance_id
      where lease.id = ${leaseId}
        and lease.match_id = ${matchId}
        and lease.fencing_token = ${fencingToken}::bigint
        and instance.node_id = ${nodeId}
        and lease.status in ('active', 'released')
        and (lease.released_at is null or lease.released_at >= now() - interval '15 minutes')
      for share of lease
    `;
    if (!authority) {
      throw new MatchIngestionError(401, "The match ingestion authority is no longer valid.");
    }
    const secret = authority.manifest["eventIngestSecret"];
    if (typeof secret !== "string" || secret.length < 32 || !signaturesMatch(signedValue, signature, secret)) {
      throw new MatchIngestionError(401, "The match ingestion signature is invalid.");
    }
    return authority.manifest;
  }
}
