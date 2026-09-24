import { randomBytes, randomUUID } from "node:crypto";
import type {
  GameMode,
  MatchAssignment,
  MatchRecoveryAction,
  MatchRecoveryIncident,
  MatchRecoveryStatus
} from "@aftertick/contracts";
import type { Sql } from "@aftertick/db";
import type postgres from "postgres";
import {
  NoServerCapacityError,
  type MatchManifestPayload,
  type NodeControlService,
  type SignedMatchManifest
} from "./node-control-service.js";
import { OperationsService, PlatformAccessError } from "./operations-service.js";

type Transaction = postgres.TransactionSql;

export interface MatchReassignmentQueue {
  reassignMatch(
    oldMatchId: string,
    assignment: MatchAssignment,
    playerIds: string[]
  ): Promise<{ players: number; tickets: number }>;
}

interface IncidentRow {
  id: string;
  match_id: string;
  map: string;
  region: string;
  match_status: MatchRecoveryIncident["matchStatus"];
  reason: MatchRecoveryIncident["reason"];
  status: MatchRecoveryStatus;
  evidence: Record<string, unknown>;
  detected_at: Date;
  resolution_action: MatchRecoveryAction | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  replacement_match_id: string | null;
  replacement_manifest: SignedMatchManifest | null;
  queue_reassigned_players: number;
  queue_delivery_error: string | null;
  resolution_error: string | null;
}

interface RemakeContext {
  match_id: string;
  replacement_match_id: string;
  map: string;
  region: string;
  ruleset_version: string;
  mode: GameMode;
  frag_limit: number | null;
  time_limit_seconds: number | null;
  previous_manifest: Record<string, unknown>;
}

interface RosterRow {
  player_id: string;
  steam_id: string | null;
  team: "alpha" | "bravo" | "ffa";
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function assignmentFromManifest(manifest: SignedMatchManifest): MatchAssignment {
  return {
    mode: manifest.mode ?? "competitive",
    matchId: manifest.matchId,
    map: manifest.map,
    region: typeof manifest["region"] === "string" ? manifest["region"] : "Unknown",
    serverLabel: `B2G ${typeof manifest["region"] === "string" ? manifest["region"] : "server"} · ${manifest.serverInstanceId.slice(0, 8)}`,
    address: manifest.serverAddress,
    connectUrl: `steam://connect/${manifest.serverAddress}/${manifest.serverPassword}`,
    launcherUrl: `b2g://connect?server=${encodeURIComponent(manifest.serverAddress)}`
      + `&password=${encodeURIComponent(manifest.serverPassword)}`
  };
}

function incidentView(row: IncidentRow): MatchRecoveryIncident {
  return {
    id: row.id,
    matchId: row.match_id,
    map: row.map,
    region: row.region,
    matchStatus: row.match_status,
    reason: row.reason,
    status: row.status,
    evidence: row.evidence,
    detectedAt: row.detected_at.toISOString(),
    resolutionAction: row.resolution_action,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    replacementMatchId: row.replacement_match_id,
    replacementAssignment: row.replacement_manifest
      ? assignmentFromManifest(row.replacement_manifest)
      : null,
    queueReassignedPlayers: row.queue_reassigned_players,
    queueDeliveryError: row.queue_delivery_error,
    resolutionError: row.resolution_error
  };
}

export class MatchRecoveryService {
  constructor(
    private readonly sql: Sql,
    private readonly nodes: NodeControlService,
    private readonly operations: OperationsService,
    private readonly queue?: MatchReassignmentQueue | undefined
  ) {}

  async list(
    actorId: string,
    status: MatchRecoveryStatus | null,
    limit: number,
    offset: number
  ): Promise<MatchRecoveryIncident[]> {
    await this.operations.assertAdmin(actorId);
    const rows = await this.queryIncidents(null, status, limit, offset);
    return rows.map(incidentView);
  }

  async resolve(input: {
    actorId: string;
    incidentId: string;
    action: MatchRecoveryAction;
    note: string;
    ipAddress: string | null;
  }): Promise<MatchRecoveryIncident> {
    await this.operations.assertAdmin(input.actorId);
    const [current] = await this.queryIncidents(input.incidentId, null, 1, 0);
    if (!current) throw new PlatformAccessError(404, "Recovery incident not found.");

    if (current.status === "resolved") {
      if (current.resolution_action !== input.action) {
        throw new PlatformAccessError(409, `This incident was already resolved with ${current.resolution_action}.`);
      }
      if (input.action === "remake") await this.deliverReplacement(current.id);
      return this.getIncident(current.id);
    }
    if (current.status === "resolving" && input.action !== "remake") {
      throw new PlatformAccessError(409, "A remake is already being provisioned for this incident.");
    }
    return input.action === "void"
      ? this.voidMatch(input)
      : this.remakeMatch(input);
  }

  private async voidMatch(input: {
    actorId: string;
    incidentId: string;
    action: "void" | "remake";
    note: string;
    ipAddress: string | null;
  }): Promise<MatchRecoveryIncident> {
    await this.sql.begin(async (transaction) => {
      const [incident] = await transaction<{
        id: string;
        match_id: string;
        status: MatchRecoveryStatus;
        resolution_action: MatchRecoveryAction | null;
      }[]>`
        select id, match_id, status, resolution_action
        from match_recovery_incidents
        where id = ${input.incidentId}
        for update
      `;
      if (!incident) throw new PlatformAccessError(404, "Recovery incident not found.");
      if (incident.status === "resolved" && incident.resolution_action === "void") return;
      if (incident.status !== "open") {
        throw new PlatformAccessError(409, "This incident is already being resolved.");
      }
      const [rated] = await transaction<{ count: number }[]>`
        select count(*)::int as count from rating_changes where match_id = ${incident.match_id}
      `;
      if ((rated?.count ?? 0) > 0) {
        throw new PlatformAccessError(409, "A rated match cannot be voided.");
      }
      const cancelled = await transaction`
        update matches
        set status = 'cancelled', cancelled_reason = 'server_failure_voided',
            ended_at = coalesce(ended_at, now())
        where id = ${incident.match_id} and status = 'disputed'
      `;
      if (cancelled.count !== 1) {
        throw new PlatformAccessError(409, "Only a disputed failed match can be voided.");
      }
      await transaction`
        update match_recovery_incidents
        set status = 'resolved', resolution_action = 'void',
            resolution_note = ${input.note}, resolved_by = ${input.actorId},
            resolved_at = now(), resolution_error = null, updated_at = now()
        where id = ${incident.id}
      `;
      await this.audit(transaction, input.actorId, "match.recovery.voided", incident.id, {
        matchId: incident.match_id,
        note: input.note
      }, input.ipAddress);
    });
    return this.getIncident(input.incidentId);
  }

  private async remakeMatch(input: {
    actorId: string;
    incidentId: string;
    action: "void" | "remake";
    note: string;
    ipAddress: string | null;
  }): Promise<MatchRecoveryIncident> {
    await this.stageRemake(input);
    const context = await this.loadRemakeContext(input.incidentId);
    const roster = await this.loadRoster(context.replacement_match_id);
    const expectedPlayers = context.mode === "deathmatch" ? 14 : 10;
    if (roster.length !== expectedPlayers || roster.some((player) => !player.steam_id)) {
      const message = `A ${context.mode} remake requires ${expectedPlayers} rostered players with linked Steam accounts.`;
      await this.recordResolutionError(input.incidentId, message);
      throw new PlatformAccessError(409, message);
    }

    const [existingLease] = await this.sql<{ id: string }[]>`
      select id from server_leases
      where match_id = ${context.replacement_match_id} and status = 'active'
      limit 1
    `;
    if (!existingLease) await this.operations.assertAllocationEnabled();

    const previous = context.previous_manifest;
    const payload: MatchManifestPayload = {
      mode: context.mode,
      roster: roster.map((player) => ({
        playerId: player.player_id,
        steamId: player.steam_id!,
        team: player.team
      })),
      map: context.map,
      region: context.region,
      rulesetVersion: typeof previous["rulesetVersion"] === "string"
        ? previous["rulesetVersion"]
        : context.ruleset_version,
      fragLimit: context.frag_limit,
      timeLimitSeconds: context.time_limit_seconds,
      pluginVersion: typeof previous["pluginVersion"] === "string"
        ? previous["pluginVersion"]
        : "0.1.0",
      serverConfigVersion: typeof previous["serverConfigVersion"] === "string"
        ? previous["serverConfigVersion"]
        : "1.0",
      demoObjectKey: `matches/${context.replacement_match_id}/gotv.dem`,
      eventIngestSecret: randomBytes(32).toString("base64url"),
      serverPassword: randomBytes(24).toString("base64url"),
      integrityPolicy: {
        protocolVersion: 1,
        provider: "none",
        enforcement: "disabled"
      }
    };

    let lease;
    try {
      lease = await this.nodes.leaseReadyServer({
        matchId: context.replacement_match_id,
        region: context.region,
        ttlSeconds: 3 * 60 * 60,
        payload
      });
    } catch (error) {
      const message = error instanceof NoServerCapacityError
        ? error.message
        : `Replacement allocation failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.recordResolutionError(input.incidentId, message);
      if (error instanceof NoServerCapacityError) {
        throw new PlatformAccessError(503, message);
      }
      throw error;
    }

    await this.sql.begin(async (transaction) => {
      const [incident] = await transaction<{
        id: string;
        match_id: string;
        status: MatchRecoveryStatus;
        replacement_match_id: string | null;
      }[]>`
        select id, match_id, status, replacement_match_id
        from match_recovery_incidents where id = ${input.incidentId}
        for update
      `;
      if (!incident) throw new PlatformAccessError(404, "Recovery incident not found.");
      if (incident.replacement_match_id !== context.replacement_match_id) {
        throw new PlatformAccessError(409, "The replacement match changed during allocation.");
      }
      if (incident.status !== "resolved") {
        await transaction`
          update matches set server_address = ${lease.manifest.serverAddress}
          where id = ${context.replacement_match_id} and status = 'pending'
        `;
        await transaction`
          update matches
          set status = 'cancelled', cancelled_reason = ${`server_failure_remade:${context.replacement_match_id}`},
              ended_at = coalesce(ended_at, now())
          where id = ${incident.match_id} and status = 'disputed'
        `;
        await transaction`
          update match_recovery_incidents
          set status = 'resolved', resolved_at = now(), resolution_error = null,
              updated_at = now()
          where id = ${incident.id}
        `;
        await this.audit(transaction, input.actorId, "match.recovery.remade", incident.id, {
          matchId: incident.match_id,
          replacementMatchId: context.replacement_match_id,
          leaseId: lease.id,
          serverInstanceId: lease.serverInstanceId
        }, input.ipAddress);
      }
    });

    await this.deliverReplacement(input.incidentId);
    return this.getIncident(input.incidentId);
  }

  private async stageRemake(input: {
    actorId: string;
    incidentId: string;
    note: string;
    ipAddress: string | null;
  }): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [incident] = await transaction<{
        id: string;
        match_id: string;
        status: MatchRecoveryStatus;
        resolution_action: MatchRecoveryAction | null;
        replacement_match_id: string | null;
      }[]>`
        select id, match_id, status, resolution_action, replacement_match_id
        from match_recovery_incidents where id = ${input.incidentId}
        for update
      `;
      if (!incident) throw new PlatformAccessError(404, "Recovery incident not found.");
      if (incident.status === "resolved") {
        if (incident.resolution_action !== "remake") {
          throw new PlatformAccessError(409, "This incident was already voided.");
        }
        return;
      }
      if (incident.status === "resolving") return;

      const [roster] = await transaction<{ count: number; expected: number }[]>`
        select count(*) filter (where player.steam_id is not null)::int as count,
               case when match.mode = 'deathmatch' then 14 else 10 end as expected
        from matches match
        left join rosters roster on roster.match_id = match.id
        left join players player on player.id = roster.player_id
        where match.id = ${incident.match_id}
        group by match.mode
      `;
      if (!roster || roster.count !== roster.expected) {
        throw new PlatformAccessError(409, "A remake requires the complete Steam-linked roster.");
      }
      const replacementMatchId = randomUUID();
      const created = await transaction`
        insert into matches (
          id, season_id, map, map_pool, region, status, ruleset_version,
          mode, frag_limit, time_limit_seconds
        )
        select ${replacementMatchId}, season_id, map, map_pool, region, 'pending', ruleset_version,
               mode, frag_limit, time_limit_seconds
        from matches where id = ${incident.match_id} and status = 'disputed'
      `;
      if (created.count !== 1) {
        throw new PlatformAccessError(409, "Only a disputed failed match can be remade.");
      }
      await transaction`
        insert into rosters (match_id, player_id, team, slot, rating_at_match)
        select ${replacementMatchId}, player_id, team, slot, rating_at_match
        from rosters where match_id = ${incident.match_id}
      `;
      await transaction`
        update match_recovery_incidents
        set status = 'resolving', resolution_action = 'remake',
            resolution_note = ${input.note}, resolved_by = ${input.actorId},
            replacement_match_id = ${replacementMatchId}, resolution_error = null,
            updated_at = now()
        where id = ${incident.id}
      `;
      await this.audit(transaction, input.actorId, "match.recovery.remake_started", incident.id, {
        matchId: incident.match_id,
        replacementMatchId
      }, input.ipAddress);
    });
  }

  private async deliverReplacement(incidentId: string): Promise<void> {
    const context = await this.loadRemakeContext(incidentId);
    const roster = await this.loadRoster(context.replacement_match_id);
    const [lease] = await this.sql<{ manifest: SignedMatchManifest }[]>`
      select manifest from server_leases
      where match_id = ${context.replacement_match_id}
      order by leased_at desc limit 1
    `;
    if (!lease) {
      await this.recordResolutionError(incidentId, "The replacement server lease is missing.");
      return;
    }
    const assignment = assignmentFromManifest(lease.manifest);
    let players = 0;
    let error: string | null = null;
    if (!this.queue) {
      error = "Queue reassignment is unavailable; use manual player handoff.";
    } else {
      try {
        const delivered = await this.queue.reassignMatch(
          context.match_id,
          assignment,
          roster.map((player) => player.player_id)
        );
        players = delivered.players;
        if (players < roster.length) {
          error = players === 0
            ? "No active assigned queue tickets were found; use manual player handoff."
            : `Replacement assignment reached ${players} of ${roster.length} rostered players.`;
        }
      } catch (caught) {
        error = `Queue reassignment failed: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
    }
    await this.sql`
      update match_recovery_incidents
      set queue_reassigned_players = greatest(queue_reassigned_players, ${players}),
          queue_delivery_error = ${error}, updated_at = now()
      where id = ${incidentId}
    `;
  }

  private async loadRemakeContext(incidentId: string): Promise<RemakeContext> {
    const [context] = await this.sql<RemakeContext[]>`
      select incident.match_id, incident.replacement_match_id,
             replacement.map, replacement.region, replacement.ruleset_version,
             replacement.mode, replacement.frag_limit, replacement.time_limit_seconds,
             original_lease.manifest as previous_manifest
      from match_recovery_incidents incident
      join matches replacement on replacement.id = incident.replacement_match_id
      join server_leases original_lease on original_lease.id = incident.lease_id
      where incident.id = ${incidentId} and incident.resolution_action = 'remake'
    `;
    if (!context) throw new PlatformAccessError(409, "The replacement match is not staged.");
    return context;
  }

  private loadRoster(matchId: string): Promise<RosterRow[]> {
    return this.sql<RosterRow[]>`
      select roster.player_id, player.steam_id, roster.team
      from rosters roster join players player on player.id = roster.player_id
      where roster.match_id = ${matchId}
      order by roster.team, roster.slot
    `;
  }

  private async recordResolutionError(incidentId: string, message: string): Promise<void> {
    await this.sql`
      update match_recovery_incidents
      set resolution_error = ${message.slice(0, 2_000)}, updated_at = now()
      where id = ${incidentId} and status = 'resolving'
    `;
  }

  private async getIncident(incidentId: string): Promise<MatchRecoveryIncident> {
    const [incident] = await this.queryIncidents(incidentId, null, 1, 0);
    if (!incident) throw new PlatformAccessError(404, "Recovery incident not found.");
    return incidentView(incident);
  }

  private queryIncidents(
    incidentId: string | null,
    status: MatchRecoveryStatus | null,
    limit: number,
    offset: number
  ): Promise<IncidentRow[]> {
    return this.sql<IncidentRow[]>`
      select incident.id, incident.match_id, match.map, match.region,
             match.status as match_status, incident.reason, incident.status,
             incident.evidence, incident.detected_at, incident.resolution_action,
             incident.resolution_note, incident.resolved_by, incident.resolved_at,
             incident.replacement_match_id, replacement_lease.manifest as replacement_manifest,
             incident.queue_reassigned_players, incident.queue_delivery_error,
             incident.resolution_error
      from match_recovery_incidents incident
      join matches match on match.id = incident.match_id
      left join lateral (
        select lease.manifest
        from server_leases lease
        where lease.match_id = incident.replacement_match_id
        order by lease.leased_at desc
        limit 1
      ) replacement_lease on true
      where (${incidentId}::text is null or incident.id::text = ${incidentId})
        and (${status}::text is null or incident.status::text = ${status})
      order by incident.detected_at desc
      limit ${limit} offset ${offset}
    `;
  }

  private async audit(
    transaction: Transaction,
    actorId: string,
    action: string,
    incidentId: string,
    detail: Record<string, unknown>,
    ipAddress: string | null
  ): Promise<void> {
    await transaction`
      insert into audit_log (actor_id, action, target_type, target_id, detail, ip_address)
      values (
        ${actorId}, ${action}, 'match_recovery_incident', ${incidentId},
        ${transaction.json(asJson(detail))}, ${ipAddress}::inet
      )
    `;
  }
}
