import type {
  AntiCheatSignal,
  PlatformControls,
  PlayerReport,
  PlayerSanction,
  ReportCategory,
  ReportStatus,
  SanctionAppeal,
  SanctionType
} from "@aftertick/contracts";
import type { Sql } from "@aftertick/db";
import type postgres from "postgres";

export type PlatformRole = "player" | "moderator" | "admin";
type Transaction = postgres.TransactionSql;

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export class PlatformAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ControlsRow {
  registration_enabled: boolean;
  queue_enabled: boolean;
  server_allocation_enabled: boolean;
  user_message: string | null;
  version: number;
  updated_at: Date;
}

interface ReportRow {
  id: string;
  reporter_id: string;
  reported_id: string;
  reported_display_name: string;
  match_id: string;
  category: ReportCategory;
  status: ReportStatus;
  description: string | null;
  reviewer_id: string | null;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

interface SanctionRow {
  id: string;
  player_id: string;
  display_name: string;
  issued_by: string | null;
  sanction_type: SanctionType;
  reason: string;
  report_id: string | null;
  match_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

interface AppealRow {
  id: string;
  sanction_id: string;
  player_id: string;
  display_name: string;
  statement: string;
  status: SanctionAppeal["status"];
  reviewer_id: string | null;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

interface AntiCheatSignalRow {
  id: string;
  match_id: string;
  player_id: string | null;
  steam_id: string;
  display_name: string;
  module: string;
  detection_type: number;
  mode: AntiCheatSignal["mode"];
  map: string;
  match_status: AntiCheatSignal["matchStatus"];
  occurred_at: Date;
  synthetic: boolean;
}

function controlsView(row: ControlsRow): PlatformControls {
  return {
    registrationEnabled: row.registration_enabled,
    queueEnabled: row.queue_enabled,
    serverAllocationEnabled: row.server_allocation_enabled,
    userMessage: row.user_message,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString()
  };
}

function reportView(row: ReportRow): PlayerReport {
  return {
    id: row.id,
    reporterId: row.reporter_id,
    reportedId: row.reported_id,
    reportedDisplayName: row.reported_display_name,
    matchId: row.match_id,
    category: row.category,
    status: row.status,
    description: row.description,
    reviewerId: row.reviewer_id,
    resolution: row.resolution,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null
  };
}

function sanctionView(row: SanctionRow): PlayerSanction {
  return {
    id: row.id,
    playerId: row.player_id,
    displayName: row.display_name,
    issuedBy: row.issued_by,
    sanctionType: row.sanction_type,
    reason: row.reason,
    reportId: row.report_id,
    matchId: row.match_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at?.toISOString() ?? null,
    isActive: row.is_active && (!row.ends_at || row.ends_at > new Date()),
    createdAt: row.created_at.toISOString()
  };
}

function appealView(row: AppealRow): SanctionAppeal {
  return {
    id: row.id,
    sanctionId: row.sanction_id,
    playerId: row.player_id,
    displayName: row.display_name,
    statement: row.statement,
    status: row.status,
    reviewerId: row.reviewer_id,
    resolution: row.resolution,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null
  };
}

export class OperationsService {
  constructor(private readonly sql: Sql) {}

  async getControls(): Promise<PlatformControls> {
    const [row] = await this.sql<ControlsRow[]>`
      select registration_enabled, queue_enabled, server_allocation_enabled,
             user_message, version, updated_at
      from platform_controls where singleton = true
    `;
    if (!row) throw new Error("Platform controls are not initialized.");
    return controlsView(row);
  }

  async assertRegistrationEnabled(): Promise<void> {
    if (!(await this.getControls()).registrationEnabled) {
      throw new PlatformAccessError(503, "New account registration is temporarily disabled.");
    }
  }

  async assertCanQueue(playerId: string): Promise<void> {
    const controls = await this.getControls();
    if (!controls.queueEnabled) {
      throw new PlatformAccessError(503, controls.userMessage ?? "Matchmaking is temporarily paused.");
    }
    const [access] = await this.sql<{ blocked: boolean; reason: string | null }[]>`
      select (
        (player.is_banned and (player.ban_expires_at is null or player.ban_expires_at > now()))
        or exists (
          select 1 from sanctions sanction
          where sanction.player_id = player.id and sanction.is_active = true
            and sanction.sanction_type in ('cooldown', 'temp_ban', 'perm_ban')
            and (sanction.ends_at is null or sanction.ends_at > now())
        )
      ) as blocked,
      coalesce(
        (select sanction.reason from sanctions sanction
         where sanction.player_id = player.id and sanction.is_active = true
           and sanction.sanction_type in ('cooldown', 'temp_ban', 'perm_ban')
           and (sanction.ends_at is null or sanction.ends_at > now())
         order by sanction.created_at desc limit 1),
        player.ban_reason
      ) as reason
      from players player where player.id = ${playerId}
    `;
    if (!access) throw new PlatformAccessError(404, "Player not found.");
    if (access.blocked) {
      throw new PlatformAccessError(403, access.reason ?? "This account cannot enter matchmaking.");
    }
  }

  async assertAllocationEnabled(): Promise<void> {
    const controls = await this.getControls();
    if (!controls.serverAllocationEnabled) {
      throw new PlatformAccessError(503, controls.userMessage ?? "New game-server allocation is paused.");
    }
  }

  async roleFor(playerId: string): Promise<PlatformRole> {
    const [row] = await this.sql<{ platform_role: PlatformRole }[]>`
      select platform_role from players where id = ${playerId}
    `;
    if (!row) throw new PlatformAccessError(404, "Player not found.");
    return row.platform_role;
  }

  async assertAdmin(playerId: string): Promise<void> {
    await this.requireRole(playerId, "admin");
  }

  async createReport(input: {
    reporterId: string;
    reportedId: string;
    matchId: string;
    category: ReportCategory;
    description: string | null;
    ipAddress: string | null;
  }): Promise<PlayerReport> {
    if (input.reporterId === input.reportedId) {
      throw new PlatformAccessError(400, "You cannot report yourself.");
    }
    return this.sql.begin(async (transaction) => {
      const [roster] = await transaction<{ count: number }[]>`
        select count(distinct player_id)::int as count from rosters
        where match_id = ${input.matchId}
          and player_id in (${input.reporterId}, ${input.reportedId})
      `;
      if (roster?.count !== 2) {
        throw new PlatformAccessError(403, "Reports require a match shared by both players.");
      }
      const [created] = await transaction<ReportRow[]>`
        insert into reports (reporter_id, reported_id, match_id, category, description)
        values (${input.reporterId}, ${input.reportedId}, ${input.matchId}, ${input.category}, ${input.description})
        on conflict (reporter_id, reported_id, match_id, category) where match_id is not null
        do nothing
        returning id, reporter_id, reported_id,
          (select display_name from players where id = reported_id) as reported_display_name,
          match_id, category, status, description, reviewer_id, resolution, created_at, resolved_at
      `;
      if (!created) throw new PlatformAccessError(409, "This report category was already submitted for that player and match.");
      await this.audit(transaction, input.reporterId, "report.created", "report", created.id, {
        matchId: input.matchId,
        reportedId: input.reportedId,
        category: input.category
      }, input.ipAddress);
      return reportView(created);
    });
  }

  async listReports(actorId: string, status: ReportStatus | null, limit: number, offset: number): Promise<PlayerReport[]> {
    await this.requireRole(actorId, "moderator");
    const rows = status
      ? await this.sql<ReportRow[]>`
          select report.*, player.display_name as reported_display_name
          from reports report join players player on player.id = report.reported_id
          where report.status = ${status}
          order by report.created_at asc limit ${limit} offset ${offset}
        `
      : await this.sql<ReportRow[]>`
          select report.*, player.display_name as reported_display_name
          from reports report join players player on player.id = report.reported_id
          order by report.created_at desc limit ${limit} offset ${offset}
        `;
    return rows.map(reportView);
  }

  async reviewReport(input: {
    actorId: string;
    reportId: string;
    status: Exclude<ReportStatus, "pending">;
    resolution: string | null;
    ipAddress: string | null;
  }): Promise<PlayerReport> {
    await this.requireRole(input.actorId, "moderator");
    if (["resolved", "dismissed"].includes(input.status) && !input.resolution) {
      throw new PlatformAccessError(400, "A resolution is required to close a report.");
    }
    return this.sql.begin(async (transaction) => {
      const [updated] = await transaction<ReportRow[]>`
        update reports report set status = ${input.status}, reviewer_id = ${input.actorId},
          resolution = ${input.resolution}, updated_at = now(),
          resolved_at = case when ${input.status} in ('resolved', 'dismissed') then now() else null end
        from players player
        where report.id = ${input.reportId} and player.id = report.reported_id
          and report.status in ('pending', 'under_review')
        returning report.id, report.reporter_id, report.reported_id,
          player.display_name as reported_display_name, report.match_id, report.category,
          report.status, report.description, report.reviewer_id, report.resolution,
          report.created_at, report.resolved_at
      `;
      if (!updated) throw new PlatformAccessError(409, "The report is missing or already closed.");
      await this.audit(transaction, input.actorId, "report.reviewed", "report", updated.id, {
        status: input.status,
        resolution: input.resolution
      }, input.ipAddress);
      return reportView(updated);
    });
  }

  async createSanction(input: {
    actorId: string;
    playerId: string;
    sanctionType: SanctionType;
    reason: string;
    durationMinutes: number | null;
    reportId: string | null;
    matchId: string | null;
    ipAddress: string | null;
  }): Promise<PlayerSanction> {
    const actorRole = await this.requireRole(input.actorId, "moderator");
    const targetRole = await this.roleFor(input.playerId);
    if (input.actorId === input.playerId || (actorRole === "moderator" && targetRole !== "player")) {
      throw new PlatformAccessError(403, "This moderator cannot sanction that account.");
    }
    const timed = input.sanctionType === "cooldown" || input.sanctionType === "temp_ban";
    if (timed && !input.durationMinutes) {
      throw new PlatformAccessError(400, "A positive duration is required for a timed sanction.");
    }
    return this.sql.begin(async (transaction) => {
      const [created] = await transaction<SanctionRow[]>`
        insert into sanctions (
          player_id, issued_by, sanction_type, reason, duration_minutes,
          report_id, match_id, ends_at
        ) values (
          ${input.playerId}, ${input.actorId}, ${input.sanctionType}, ${input.reason},
          ${input.durationMinutes}, ${input.reportId}, ${input.matchId},
          case when ${input.durationMinutes}::int is null then null
               else now() + (${input.durationMinutes}::int * interval '1 minute') end
        )
        returning *, (select display_name from players where id = player_id) as display_name
      `;
      if (!created) throw new Error("Sanction creation failed.");
      if (input.sanctionType === "temp_ban" || input.sanctionType === "perm_ban") {
        await transaction`
          update players set is_banned = true, ban_reason = ${input.reason},
            ban_expires_at = ${created.ends_at}, updated_at = now()
          where id = ${input.playerId}
        `;
      }
      await this.audit(transaction, input.actorId, "sanction.created", "sanction", created.id, {
        playerId: input.playerId,
        sanctionType: input.sanctionType,
        durationMinutes: input.durationMinutes,
        reportId: input.reportId
      }, input.ipAddress);
      return sanctionView(created);
    });
  }

  async listSanctions(actorId: string, playerId: string | null, limit: number, offset: number): Promise<PlayerSanction[]> {
    await this.requireRole(actorId, "moderator");
    const rows = playerId
      ? await this.sql<SanctionRow[]>`
          select sanction.*, player.display_name from sanctions sanction
          join players player on player.id = sanction.player_id
          where sanction.player_id = ${playerId}
          order by sanction.created_at desc limit ${limit} offset ${offset}
        `
      : await this.sql<SanctionRow[]>`
          select sanction.*, player.display_name from sanctions sanction
          join players player on player.id = sanction.player_id
          order by sanction.created_at desc limit ${limit} offset ${offset}
        `;
    return rows.map(sanctionView);
  }

  async listOwnSanctions(playerId: string, limit: number, offset: number): Promise<PlayerSanction[]> {
    const rows = await this.sql<SanctionRow[]>`
      select sanction.*, player.display_name from sanctions sanction
      join players player on player.id = sanction.player_id
      where sanction.player_id = ${playerId}
      order by sanction.created_at desc limit ${limit} offset ${offset}
    `;
    return rows.map(sanctionView);
  }

  async createAppeal(playerId: string, sanctionId: string, statement: string, ipAddress: string | null): Promise<SanctionAppeal> {
    return this.sql.begin(async (transaction) => {
      const [created] = await transaction<AppealRow[]>`
        insert into sanction_appeals (sanction_id, player_id, statement)
        select sanction.id, sanction.player_id, ${statement}
        from sanctions sanction where sanction.id = ${sanctionId} and sanction.player_id = ${playerId}
        on conflict (sanction_id, player_id) do nothing
        returning *, (select display_name from players where id = player_id) as display_name
      `;
      if (!created) throw new PlatformAccessError(409, "The sanction is unavailable or already appealed.");
      await transaction`update sanctions set appealed = true, appeal_text = ${statement} where id = ${sanctionId}`;
      await this.audit(transaction, playerId, "sanction.appealed", "sanction", sanctionId, { appealId: created.id }, ipAddress);
      return appealView(created);
    });
  }

  async listAppeals(actorId: string, status: SanctionAppeal["status"] | null, limit: number, offset: number): Promise<SanctionAppeal[]> {
    await this.requireRole(actorId, "moderator");
    const rows = status
      ? await this.sql<AppealRow[]>`
          select appeal.*, player.display_name from sanction_appeals appeal
          join players player on player.id = appeal.player_id where appeal.status = ${status}
          order by appeal.created_at asc limit ${limit} offset ${offset}
        `
      : await this.sql<AppealRow[]>`
          select appeal.*, player.display_name from sanction_appeals appeal
          join players player on player.id = appeal.player_id
          order by appeal.created_at desc limit ${limit} offset ${offset}
        `;
    return rows.map(appealView);
  }

  async listAntiCheatSignals(actorId: string, limit: number, offset: number): Promise<AntiCheatSignal[]> {
    await this.requireRole(actorId, "moderator");
    const rows = await this.sql<AntiCheatSignalRow[]>`
      select event.event_id as id, event.match_id, player.id as player_id,
        event.payload->>'steamId' as steam_id,
        coalesce(player.display_name, event.payload->>'steamId') as display_name,
        event.payload->>'module' as module,
        case when event.payload->>'detectionType' ~ '^[0-9]+$'
          then (event.payload->>'detectionType')::int else 0 end as detection_type,
        match.mode, match.map, match.status as match_status, event.occurred_at,
        case when lower(event.payload->>'synthetic') = 'true' then true else false end as synthetic
      from match_events event
      join matches match on match.id = event.match_id
      left join players player on player.steam_id = event.payload->>'steamId'
      where event.event_type = 'anticheat.signal'
      order by event.occurred_at desc
      limit ${limit} offset ${offset}
    `;
    return rows.map((row) => ({
      id: row.id,
      matchId: row.match_id,
      playerId: row.player_id,
      steamId: row.steam_id,
      displayName: row.display_name,
      module: row.module,
      detectionType: Number(row.detection_type),
      mode: row.mode,
      map: row.map,
      matchStatus: row.match_status,
      occurredAt: row.occurred_at.toISOString(),
      automaticAction: false,
      synthetic: row.synthetic
    }));
  }

  async resolveAppeal(input: {
    actorId: string;
    appealId: string;
    status: Exclude<SanctionAppeal["status"], "pending">;
    resolution: string;
    newDurationMinutes: number | null;
    ipAddress: string | null;
  }): Promise<SanctionAppeal> {
    await this.requireRole(input.actorId, "moderator");
    return this.sql.begin(async (transaction) => {
      const [updated] = await transaction<AppealRow[]>`
        update sanction_appeals appeal set status = ${input.status}, reviewer_id = ${input.actorId},
          resolution = ${input.resolution}, resolved_at = now()
        from players player
        where appeal.id = ${input.appealId} and appeal.status = 'pending'
          and player.id = appeal.player_id
        returning appeal.*, player.display_name
      `;
      if (!updated) throw new PlatformAccessError(409, "The appeal is missing or already resolved.");
      if (input.status === "overturned") {
        await transaction`update sanctions set is_active = false, appeal_resolved_at = now() where id = ${updated.sanction_id}`;
      } else if (input.status === "reduced") {
        if (!input.newDurationMinutes) throw new PlatformAccessError(400, "A reduced duration is required.");
        await transaction`
          update sanctions set duration_minutes = ${input.newDurationMinutes},
            ends_at = starts_at + (${input.newDurationMinutes}::int * interval '1 minute'),
            appeal_resolved_at = now() where id = ${updated.sanction_id}
        `;
      } else {
        await transaction`update sanctions set appeal_resolved_at = now() where id = ${updated.sanction_id}`;
      }
      if (input.status === "overturned") await this.refreshLegacyBan(transaction, updated.player_id);
      await this.audit(transaction, input.actorId, "appeal.resolved", "sanction_appeal", updated.id, {
        status: input.status,
        newDurationMinutes: input.newDurationMinutes
      }, input.ipAddress);
      return appealView(updated);
    });
  }

  async updateControls(input: {
    actorId: string;
    version: number;
    registrationEnabled: boolean;
    queueEnabled: boolean;
    serverAllocationEnabled: boolean;
    userMessage: string | null;
    ipAddress: string | null;
  }): Promise<PlatformControls> {
    await this.requireRole(input.actorId, "admin");
    return this.sql.begin(async (transaction) => {
      const [updated] = await transaction<ControlsRow[]>`
        update platform_controls set registration_enabled = ${input.registrationEnabled},
          queue_enabled = ${input.queueEnabled}, server_allocation_enabled = ${input.serverAllocationEnabled},
          user_message = ${input.userMessage}, version = version + 1,
          updated_by = ${input.actorId}, updated_at = now()
        where singleton = true and version = ${input.version}
        returning registration_enabled, queue_enabled, server_allocation_enabled,
          user_message, version, updated_at
      `;
      if (!updated) throw new PlatformAccessError(409, "Platform controls changed; reload before updating them.");
      await this.audit(transaction, input.actorId, "platform.controls.updated", "platform", null, {
        registrationEnabled: input.registrationEnabled,
        queueEnabled: input.queueEnabled,
        serverAllocationEnabled: input.serverAllocationEnabled,
        version: Number(updated.version)
      }, input.ipAddress);
      return controlsView(updated);
    });
  }

  async setRole(actorId: string, playerId: string, role: PlatformRole, ipAddress: string | null): Promise<void> {
    await this.requireRole(actorId, "admin");
    if (actorId === playerId && role !== "admin") {
      throw new PlatformAccessError(400, "An administrator cannot demote their own active account.");
    }
    await this.sql.begin(async (transaction) => {
      const result = await transaction`update players set platform_role = ${role}, updated_at = now() where id = ${playerId}`;
      if (result.count !== 1) throw new PlatformAccessError(404, "Player not found.");
      await this.audit(transaction, actorId, "player.role.updated", "player", playerId, { role }, ipAddress);
    });
  }

  async listAudit(actorId: string, limit: number, offset: number): Promise<Array<Record<string, unknown>>> {
    await this.requireRole(actorId, "admin");
    const rows = await this.sql<Array<{
      id: string; actor_id: string | null; action: string; target_type: string | null;
      target_id: string | null; detail: Record<string, unknown>; ip_address: string | null; created_at: Date;
    }>>`
      select id, actor_id, action, target_type, target_id, detail,
             host(ip_address) as ip_address, created_at
      from audit_log order by created_at desc limit ${limit} offset ${offset}
    `;
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: row.detail,
      ipAddress: row.ip_address,
      createdAt: row.created_at.toISOString()
    }));
  }

  private async requireRole(playerId: string, minimum: "moderator" | "admin"): Promise<PlatformRole> {
    const role = await this.roleFor(playerId);
    const strength: Record<PlatformRole, number> = { player: 0, moderator: 1, admin: 2 };
    if (strength[role] < strength[minimum]) {
      throw new PlatformAccessError(403, `${minimum === "admin" ? "Administrator" : "Moderator"} access is required.`);
    }
    return role;
  }

  private async refreshLegacyBan(transaction: Transaction, playerId: string): Promise<void> {
    await transaction`
      with active_ban as (
        select sanction.reason, sanction.ends_at
        from sanctions sanction
        where sanction.player_id = ${playerId}
          and sanction.is_active = true
          and sanction.sanction_type in ('temp_ban', 'perm_ban')
          and (sanction.ends_at is null or sanction.ends_at > now())
        order by sanction.ends_at desc nulls first, sanction.created_at desc
        limit 1
      )
      update players set
        is_banned = exists (select 1 from active_ban),
        ban_reason = (select reason from active_ban),
        ban_expires_at = (select ends_at from active_ban),
        updated_at = now()
      where id = ${playerId}
    `;
  }

  private async audit(
    transaction: Transaction,
    actorId: string | null,
    action: string,
    targetType: string | null,
    targetId: string | null,
    detail: Record<string, unknown>,
    ipAddress: string | null
  ): Promise<void> {
    await transaction`
      insert into audit_log (actor_id, action, target_type, target_id, detail, ip_address)
      values (${actorId}, ${action}, ${targetType}, ${targetId}, ${transaction.json(asJson(detail))}, ${ipAddress}::inet)
    `;
  }
}
