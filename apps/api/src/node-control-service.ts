import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { GameMode } from "@aftertick/contracts";
import type { Sql } from "@aftertick/db";
import type postgres from "postgres";
import { InventoryService } from "./inventory-service.js";

export type NodeInstanceState =
  | "starting"
  | "ready"
  | "leased"
  | "draining"
  | "quarantined"
  | "offline";

export interface InstanceHeartbeat {
  instanceKey: string;
  state: Exclude<NodeInstanceState, "leased" | "quarantined">;
  address: string;
  gamePort: number;
  gotvPort?: number | undefined;
  processId?: number | undefined;
  serverBuildId?: string | undefined;
  pluginVersion?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface NodeHeartbeat {
  agentVersion: string;
  capacityTotal: number;
  deferTerminalDrain?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
  instances: InstanceHeartbeat[];
}

export interface NodeCommand {
  id: string;
  commandType: "start" | "stop" | "prepare" | "sync-roster" | "sync-inventory" | "announce-drop" | "drain" | "quarantine" | "unquarantine";
  payload: Record<string, unknown>;
  claimToken: string;
}

export interface NodeHeartbeatResult {
  nodeId: string;
  status: "active" | "draining" | "quarantined" | "offline";
  commands: NodeCommand[];
  activeLeaseIds: string[];
  serverTime: string;
}

export interface MatchManifestPayload {
  mode?: GameMode;
  roster: Array<{ playerId: string; steamId: string; team: "alpha" | "bravo" | "ffa" }>;
  cosmetics?: Array<{
    playerId: string;
    steamId: string;
    items: Array<{
      assetId: string;
      ownershipGeneration?: string;
      source: "steam" | "b2g";
      itemKind: "cosmetic" | "case" | "key";
      definitionIndex: number;
      weaponKey: string;
      inventoryPosition: number;
      paintIndex: number | null;
      paintWear: number | null;
      paintSeed: number | null;
      quality: number;
      rarity: number;
      origin: number;
      killEaterScoreType: number | null;
      killEaterValue: number | null;
      customName: string | null;
      sprayKitId?: number | null;
      sprayTintId?: number | null;
      spraysRemaining?: number | null;
      stickers: Array<{
        slot: number;
        stickerId: number;
        wear: number | null;
        scale: number | null;
        rotation: number | null;
      }>;
      loadoutSlot: number;
      equipped: boolean;
    }>;
  }>;
  map: string;
  rulesetVersion: string;
  fragLimit?: number | null;
  timeLimitSeconds?: number | null;
  pluginVersion: string;
  serverConfigVersion: string;
  demoObjectKey: string;
  serverPassword: string;
  integrityPolicy: {
    protocolVersion: 1;
    provider: "none";
    enforcement: "disabled";
  };
  [key: string]: unknown;
}

export interface SignedMatchManifest extends MatchManifestPayload {
  manifestVersion: 1;
  manifestRevision?: number;
  matchId: string;
  leaseId: string;
  fencingToken: string;
  nodeId: string;
  serverInstanceId: string;
  serverAddress: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ServerLease {
  id: string;
  matchId: string;
  serverInstanceId: string;
  fencingToken: string;
  manifest: SignedMatchManifest;
  signature: string;
  expiresAt: string;
  commandId?: string;
}

interface NodeRow {
  id: string;
  status: "active" | "draining" | "quarantined" | "offline";
}

interface CommandRow {
  id: string;
  command_type: NodeCommand["commandType"];
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
}

interface LeaseRow {
  id: string;
  match_id: string;
  server_instance_id: string;
  fencing_token: bigint;
  manifest: SignedMatchManifest;
  manifest_signature: string;
  expires_at: Date;
}

interface LeaseFailureRow {
  id: string;
  match_id: string;
  server_instance_id: string;
  node_id: string;
  match_status: "pending" | "live" | "completed" | "cancelled" | "disputed";
  server_address: string;
  expires_at: Date;
  manifest_signature: string;
  pending_result: boolean;
}

interface SrcdsHealthEvidence {
  activeLeaseId: string;
  activeMatchId: string;
  consecutiveRconFailures: number;
  observedAt: string | null;
  lastRconSuccessAt: string | null;
  lastRconFailureAt: string | null;
}

interface ReportedMatchAuthority {
  activeLeaseId: string;
  activeMatchId: string;
}

export const SRCDS_UNREACHABLE_FAILURE_THRESHOLD = 3;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function reportedMatchAuthority(
  metadata: Record<string, unknown> | undefined
): ReportedMatchAuthority | null {
  const health = metadata?.["srcdsHealth"];
  if (!health || typeof health !== "object" || Array.isArray(health)) return null;
  const record = health as Record<string, unknown>;
  if (
    record["protocolVersion"] !== 1
    || typeof record["activeLeaseId"] !== "string"
    || !uuidPattern.test(record["activeLeaseId"])
    || typeof record["activeMatchId"] !== "string"
    || !uuidPattern.test(record["activeMatchId"])
  ) return null;
  return {
    activeLeaseId: record["activeLeaseId"],
    activeMatchId: record["activeMatchId"]
  };
}

function srcdsHealthEvidence(metadata: Record<string, unknown> | undefined): SrcdsHealthEvidence | null {
  const authority = reportedMatchAuthority(metadata);
  const health = metadata?.["srcdsHealth"];
  if (!authority || !health || typeof health !== "object" || Array.isArray(health)) return null;
  const record = health as Record<string, unknown>;
  if (
    record["rconReachable"] !== false
    || !Number.isInteger(record["consecutiveRconFailures"])
    || Number(record["consecutiveRconFailures"]) < SRCDS_UNREACHABLE_FAILURE_THRESHOLD
  ) return null;
  return {
    ...authority,
    consecutiveRconFailures: Number(record["consecutiveRconFailures"]),
    observedAt: optionalTimestamp(record["observedAt"]),
    lastRconSuccessAt: optionalTimestamp(record["lastRconSuccessAt"]),
    lastRconFailureAt: optionalTimestamp(record["lastRconFailureAt"])
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function signManifest(manifest: SignedMatchManifest, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(manifest)).digest("base64url");
}

export function verifyManifest(
  manifest: SignedMatchManifest,
  signature: string,
  secret: string
): boolean {
  const expected = Buffer.from(signManifest(manifest, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function leaseFromRow(row: LeaseRow): ServerLease {
  return {
    id: row.id,
    matchId: row.match_id,
    serverInstanceId: row.server_instance_id,
    fencingToken: String(row.fencing_token),
    manifest: row.manifest,
    signature: row.manifest_signature,
    expiresAt: row.expires_at.toISOString()
  };
}

export class NodeAuthenticationError extends Error {}
export class NoServerCapacityError extends Error {}

export class NodeControlService {
  constructor(
    private readonly sql: Sql,
    private readonly manifestSigningSecret: string
  ) {
    if (manifestSigningSecret.length < 32) {
      throw new Error("The manifest signing secret must contain at least 32 characters.");
    }
  }

  async registerNode(input: {
    name: string;
    region: string;
    publicEndpoint?: string | undefined;
  }): Promise<{ nodeId: string; token: string }> {
    const token = randomBytes(32).toString("base64url");
    const [node] = await this.sql<{ id: string }[]>`
      insert into game_nodes (name, region, public_endpoint, token_sha256)
      values (${input.name}, ${input.region}, ${input.publicEndpoint ?? null}, ${sha256(token)})
      on conflict (name) do update set
        region = excluded.region,
        public_endpoint = excluded.public_endpoint,
        token_sha256 = excluded.token_sha256,
        status = 'offline',
        updated_at = now()
      returning id
    `;
    if (!node) throw new Error("Node registration did not return an ID.");
    return { nodeId: node.id, token };
  }

  async authenticate(token: string): Promise<NodeRow> {
    const [node] = await this.sql<NodeRow[]>`
      select id, status
      from game_nodes
      where token_sha256 = ${sha256(token)}
    `;
    if (!node) throw new NodeAuthenticationError("Invalid node credentials.");
    return node;
  }

  async heartbeat(token: string, heartbeat: NodeHeartbeat): Promise<NodeHeartbeatResult> {
    const authenticated = await this.authenticate(token);
    return this.sql.begin(async (transaction) => {
      const [node] = await transaction<NodeRow[]>`
        update game_nodes
        set status = case
              when status in ('draining', 'quarantined') then status
              else 'active'::game_node_status
            end,
            capacity_total = ${heartbeat.capacityTotal},
            agent_version = ${heartbeat.agentVersion},
            metadata = ${transaction.json(asJson(heartbeat.metadata ?? {}))},
            last_heartbeat_at = now(),
            updated_at = now()
        where id = ${authenticated.id}
        returning id, status
      `;
      if (!node) throw new NodeAuthenticationError("Node no longer exists.");

      const activeLeaseIds: string[] = [];
      const inventoryLeaseIds: string[] = [];
      for (const instance of heartbeat.instances) {
        await transaction`
          insert into server_instances (
            node_id, instance_key, state, address, game_port, gotv_port,
            process_id, server_build_id, plugin_version, last_heartbeat_at, metadata
          ) values (
            ${node.id}, ${instance.instanceKey}, ${instance.state}, ${instance.address},
            ${instance.gamePort}, ${instance.gotvPort ?? null}, ${instance.processId ?? null},
            ${instance.serverBuildId ?? null}, ${instance.pluginVersion ?? null}, now(),
            ${transaction.json(asJson(instance.metadata ?? {}))}
          )
          on conflict (node_id, instance_key) do update set
            state = case
              when server_instances.state in ('leased', 'draining', 'quarantined')
                then server_instances.state
              else excluded.state
            end,
            address = excluded.address,
            game_port = excluded.game_port,
            gotv_port = excluded.gotv_port,
            process_id = excluded.process_id,
            server_build_id = excluded.server_build_id,
            plugin_version = excluded.plugin_version,
            last_heartbeat_at = now(),
            metadata = excluded.metadata,
            updated_at = now()
        `;
        const reportedAuthority = reportedMatchAuthority(instance.metadata);
        if (reportedAuthority) {
          const [activeLease] = await transaction<{ id: string }[]>`
            select lease.id::text
            from server_leases lease
            join server_instances server
              on server.id = lease.server_instance_id
            join matches match on match.id = lease.match_id
            where lease.id = ${reportedAuthority.activeLeaseId}
              and lease.match_id = ${reportedAuthority.activeMatchId}
              and lease.status = 'active'
              and match.status in ('pending', 'live')
              and server.node_id = ${node.id}
              and server.instance_key = ${instance.instanceKey}
            limit 1
          `;
          if (activeLease) {
            activeLeaseIds.push(activeLease.id);
            if (instance.state === "ready") inventoryLeaseIds.push(activeLease.id);
          }
        }
        const health = srcdsHealthEvidence(instance.metadata);
        if (instance.state !== "ready" && health) {
          const [failedLease] = await transaction<LeaseFailureRow[]>`
            select lease.id, lease.match_id, lease.server_instance_id, instance.node_id,
                   match.status as match_status, instance.address as server_address,
                   lease.expires_at, lease.manifest_signature,
                   exists (
                     select 1 from match_results result
                     where result.match_id = lease.match_id and result.status = 'pending'
                   ) as pending_result
            from server_instances instance
            join server_leases lease on lease.id = instance.active_lease_id
            join matches match on match.id = lease.match_id
            where instance.node_id = ${node.id}
              and instance.instance_key = ${instance.instanceKey}
              and lease.id = ${health.activeLeaseId}
              and lease.match_id = ${health.activeMatchId}
              and lease.status = 'active'
            for update of lease, instance, match
          `;
          if (failedLease) {
            await this.quarantineLeaseFailure(transaction, failedLease, "srcds_unreachable", {
              agentObservedAt: health.observedAt,
              consecutiveRconFailures: health.consecutiveRconFailures,
              lastRconFailureAt: health.lastRconFailureAt,
              lastRconSuccessAt: health.lastRconSuccessAt,
              reportedInstanceState: instance.state
            });
          }
        }
      }

      if (heartbeat.metadata?.["inventorySyncVersion"] === 1
        && node.status === "active" && !heartbeat.deferTerminalDrain) {
        await this.synchronizeActiveInventory(transaction, node.id, inventoryLeaseIds);
      }

      await transaction`
        update node_commands
        set status = 'pending', claim_token = null, claimed_at = null
        where node_id = ${node.id}
          and status = 'claimed'
          and claimed_at < now() - interval '30 seconds'
      `;
      const rows = await transaction<CommandRow[]>`
        select id, command_type, payload, attempt_count, max_attempts
        from node_commands
        where node_id = ${node.id} and status = 'pending'
          and next_attempt_at <= now()
          and (${heartbeat.deferTerminalDrain ?? false} = false or command_type <> 'drain')
        order by next_attempt_at, created_at, id
        for update skip locked
        limit 20
      `;
      const commands: NodeCommand[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        await transaction`
          update node_commands
          set status = 'claimed', claim_token = ${claimToken}, claimed_at = now(),
              attempt_count = attempt_count + 1
          where id = ${row.id} and status = 'pending'
        `;
        commands.push({
          id: row.id,
          commandType: row.command_type,
          payload: row.payload,
          claimToken
        });
      }

      return {
        nodeId: node.id,
        status: node.status,
        commands,
        activeLeaseIds,
        serverTime: new Date().toISOString()
      };
    });
  }

  async acknowledgeCommand(
    token: string,
    commandId: string,
    claimToken: string,
    succeeded: boolean,
    result: Record<string, unknown> = {}
  ): Promise<boolean> {
    const node = await this.authenticate(token);
    return this.sql.begin(async (transaction) => {
      const [command] = await transaction<CommandRow[]>`
        select id, command_type, payload, attempt_count, max_attempts
        from node_commands
        where id = ${commandId}
          and node_id = ${node.id}
          and status = 'claimed'
          and claim_token = ${claimToken}
        for update
      `;
      if (!command) return false;
      const terminalFailure = !succeeded && command.attempt_count >= command.max_attempts;
      if (succeeded || terminalFailure) {
        await transaction`
          update node_commands
          set status = ${succeeded ? "completed" : "failed"}::node_command_status,
              completed_at = now(), result = ${transaction.json(asJson(result))},
              last_error = ${succeeded ? null : String(result["error"] ?? "Node command failed.")}
          where id = ${command.id}
        `;
      } else {
        const retrySeconds = Math.min(30, 2 ** Math.max(0, command.attempt_count - 1));
        await transaction`
          update node_commands
          set status = 'pending', claim_token = null, claimed_at = null,
              completed_at = null, result = ${transaction.json(asJson(result))},
              last_error = ${String(result["error"] ?? "Node command failed.")},
              next_attempt_at = now() + ${retrySeconds} * interval '1 second'
          where id = ${command.id}
        `;
      }
      const instanceId = typeof command.payload["serverInstanceId"] === "string"
        ? command.payload["serverInstanceId"]
        : null;
      if (succeeded && instanceId && command.command_type === "drain") {
        const agentState = result["state"] === "offline" ? "offline" : "ready";
        await transaction`
          update server_instances
          set state = ${agentState}::server_instance_state,
              quarantine_reason = null, updated_at = now()
          where id = ${instanceId} and node_id = ${node.id} and state = 'draining'
        `;
      }
      if (succeeded && instanceId && command.command_type === "quarantine") {
        await transaction`
          update server_instances
          set state = 'quarantined', updated_at = now()
          where id = ${instanceId} and node_id = ${node.id}
        `;
      }
      if (succeeded && instanceId && command.command_type === "unquarantine") {
        await transaction`
          update server_instances
          set state = 'ready', quarantine_reason = null, updated_at = now()
          where id = ${instanceId} and node_id = ${node.id} and state = 'quarantined'
        `;
      }
      if (terminalFailure && instanceId) {
        await transaction`
          update server_instances
          set state = 'quarantined', active_lease_id = null,
              quarantine_reason = ${`command_failed:${command.command_type}`}, updated_at = now()
          where id = ${instanceId} and node_id = ${node.id}
        `;
      }
      return true;
    });
  }

  async enqueueCommand(
    nodeId: string,
    commandType: NodeCommand["commandType"],
    payload: Record<string, unknown> = {}
  ): Promise<string> {
    const [command] = await this.sql<{ id: string }[]>`
      insert into node_commands (node_id, command_type, payload)
      values (${nodeId}, ${commandType}, ${this.sql.json(asJson(payload))})
      returning id
    `;
    if (!command) throw new Error("Node command creation failed.");
    return command.id;
  }

  async leaseReadyServer(input: {
    matchId: string;
    region: string;
    ttlSeconds: number;
    payload: MatchManifestPayload;
  }): Promise<ServerLease> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await this.leaseReadyServerNow(input);
      } catch (error) {
        if (!(error instanceof NoServerCapacityError)) throw error;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    let wake = await this.wakeServerInRegion(input.region);
    if (!wake) throw new NoServerCapacityError(`No ready server capacity in ${input.region}.`);
    if (wake.commandId) await this.waitForCommand(wake.commandId);

    const readyDeadline = Date.now() + 90_000;
    while (Date.now() < readyDeadline) {
      try {
        // Another join can finish this same match's allocation while we wait.
        // Re-read its existing lease instead of waiting for "ready" forever.
        return await this.leaseReadyServerNow(input);
      } catch (error) {
        if (!(error instanceof NoServerCapacityError)) throw error;
      }
      const [instance] = await this.sql<{ state: NodeInstanceState; fresh: boolean }[]>`
        select state::text as state,
               last_heartbeat_at >= now() - interval '15 seconds' as fresh
        from server_instances
        where id = ${wake.instanceId}
      `;
      if (instance?.state === "leased") {
        // Recheck after the winning allocator commits. Share our match's lease,
        // or report real contention if a different match acquired the instance.
        return this.leaseReadyServerNow(input);
      }
      if (instance?.state === "quarantined") {
        throw new NoServerCapacityError(`The game server in ${input.region} could not start.`);
      }
      if (wake.awaitingDrain && instance?.state === "offline" && instance.fresh) {
        // A released DM must finish its terminal drain before we start another
        // process. Do not fail the next join just because shutdown takes seconds.
        const nextWake = await this.wakeServerInRegion(input.region);
        if (nextWake) {
          wake = nextWake;
          if (wake.commandId) await this.waitForCommand(wake.commandId);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new NoServerCapacityError(`The game server in ${input.region} did not become ready in time.`);
  }

  private async wakeServerInRegion(region: string): Promise<{
    instanceId: string;
    commandId: string | null;
    awaitingDrain: boolean;
  } | null> {
    return this.sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext(${`b2g:wake:${region}`}))`;
      const [instance] = await transaction<{
        id: string;
        node_id: string;
        state: "offline" | "starting" | "draining";
      }[]>`
        select instance.id, instance.node_id, instance.state::text as state
        from server_instances instance
        join game_nodes node on node.id = instance.node_id
        where node.region = ${region}
          and node.status = 'active'
          and node.last_heartbeat_at >= now() - interval '15 seconds'
          and instance.state in ('offline', 'starting', 'draining')
          and instance.active_lease_id is null
          and not exists (
            select 1 from server_leases lease
            where lease.server_instance_id = instance.id and lease.status = 'active'
          )
          and instance.last_heartbeat_at >= now() - interval '15 seconds'
        order by case instance.state when 'starting' then 0 when 'offline' then 1 else 2 end,
                 instance.updated_at, instance.id
        for update of instance
        limit 1
      `;
      if (!instance) return null;
      if (instance.state !== "offline") {
        return { instanceId: instance.id, commandId: null, awaitingDrain: instance.state === "draining" };
      }
      // An offline heartbeat can arrive between scheduling and executing start.
      // Reuse the outstanding command instead of issuing duplicate process starts.
      const [pendingStart] = await transaction<{ id: string }[]>`
        select id from node_commands
        where node_id = ${instance.node_id} and command_type = 'start'
          and payload->>'serverInstanceId' = ${instance.id}
          and status in ('pending', 'claimed')
        order by created_at limit 1
      `;
      if (pendingStart) {
        return { instanceId: instance.id, commandId: pendingStart.id, awaitingDrain: false };
      }
      await transaction`
        update server_instances
        set state = 'starting', updated_at = now()
        where id = ${instance.id} and state = 'offline'
      `;
      const [command] = await transaction<{ id: string }[]>`
        insert into node_commands (node_id, command_type, payload)
        values (
          ${instance.node_id}, 'start',
          ${transaction.json(asJson({ serverInstanceId: instance.id, reason: "match_queued" }))}
        )
        returning id
      `;
      if (!command) throw new Error("Game server start command creation failed.");
      return { instanceId: instance.id, commandId: command.id, awaitingDrain: false };
    });
  }

  private async leaseReadyServerNow(input: {
    matchId: string;
    region: string;
    ttlSeconds: number;
    payload: MatchManifestPayload;
  }): Promise<ServerLease> {
    return this.sql.begin(async (transaction) => {
      const [existing] = await transaction<LeaseRow[]>`
        select id, match_id, server_instance_id, fencing_token,
               manifest, manifest_signature, expires_at
        from server_leases
        where match_id = ${input.matchId} and status = 'active'
        for update
      `;
      if (existing) return leaseFromRow(existing);

      const [instance] = await transaction<{
        id: string;
        node_id: string;
        address: string;
      }[]>`
        select instance.id, instance.node_id, instance.address
        from server_instances instance
        join game_nodes node on node.id = instance.node_id
        where node.region = ${input.region}
          and node.status = 'active'
          and node.last_heartbeat_at >= now() - interval '15 seconds'
          and instance.state = 'ready'
          and instance.last_heartbeat_at >= now() - interval '15 seconds'
        order by instance.updated_at, instance.id
        for update of instance skip locked
        limit 1
      `;
      if (!instance) throw new NoServerCapacityError(`No ready server capacity in ${input.region}.`);

      const [fence] = await transaction<{ value: bigint }[]>`
        select nextval('server_lease_fencing_seq') as value
      `;
      if (!fence) throw new Error("Could not allocate a lease fencing token.");
      const fencingToken = String(fence.value);
      const leaseId = randomUUID();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + input.ttlSeconds * 1000);
      const manifest: SignedMatchManifest = {
        ...input.payload,
        manifestVersion: 1,
        manifestRevision: 1,
        matchId: input.matchId,
        leaseId,
        fencingToken,
        nodeId: instance.node_id,
        serverInstanceId: instance.id,
        serverAddress: instance.address,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      };
      const signature = signManifest(manifest, this.manifestSigningSecret);

      const [lease] = await transaction<LeaseRow[]>`
        insert into server_leases (
          id, match_id, server_instance_id, fencing_token, manifest,
          manifest_signature, expires_at
        ) values (
          ${leaseId}, ${input.matchId}, ${instance.id}, ${fencingToken}::bigint,
          ${transaction.json(asJson(manifest))}, ${signature}, ${expiresAt}
        )
        returning id, match_id, server_instance_id, fencing_token,
                  manifest, manifest_signature, expires_at
      `;
      if (!lease) throw new Error("Server lease creation failed.");
      await transaction`
        update server_instances
        set state = 'leased', active_lease_id = ${leaseId}, updated_at = now()
        where id = ${instance.id}
      `;
      const [command] = await transaction<{ id: string }[]>`
        insert into node_commands (node_id, command_type, payload)
        values (
          ${instance.node_id},
          'prepare',
          ${transaction.json(asJson({ leaseId, fencingToken, manifest, signature }))}
        )
        returning id
      `;
      return { ...leaseFromRow(lease), ...(command ? { commandId: command.id } : {}) };
    });
  }

  async synchronizeDeathmatchRoster(matchId: string): Promise<{
    lease: ServerLease;
    commandId: string | null;
  }> {
    return this.sql.begin(async (transaction) => {
      const [lease] = await transaction<(LeaseRow & { node_id: string })[]>`
        select lease.id, lease.match_id, lease.server_instance_id, lease.fencing_token,
               lease.manifest, lease.manifest_signature, lease.expires_at,
               instance.node_id
        from server_leases lease
        join server_instances instance on instance.id = lease.server_instance_id
        join matches match on match.id = lease.match_id
        where lease.match_id = ${matchId}
          and lease.status = 'active'
          and match.mode = 'deathmatch'
          and match.status in ('pending', 'live')
        for update of lease
      `;
      if (!lease) throw new Error(`Active Deathmatch lease ${matchId} does not exist.`);

      const roster = await transaction<{
        player_id: string;
        steam_id: string | null;
        team: "alpha" | "bravo" | "ffa";
      }[]>`
        select roster.player_id::text, player.steam_id, roster.team
        from rosters roster
        join players player on player.id = roster.player_id
        where roster.match_id = ${matchId}
        order by roster.slot
        for share of roster, player
      `;
      if (
        roster.length < 1
        || roster.length > 14
        || roster.some((player) => !player.steam_id || player.team !== "ffa")
      ) {
        throw new Error("A drop-in Deathmatch roster requires 1-14 Steam-linked FFA players.");
      }
      const nextRoster: SignedMatchManifest["roster"] = roster.map((player) => ({
        playerId: player.player_id,
        steamId: player.steam_id!,
        team: "ffa"
      }));
      const unchanged = lease.manifest.roster.length === nextRoster.length
        && lease.manifest.roster.every((player, index) => {
          const next = nextRoster[index];
          return next?.playerId === player.playerId
            && next.steamId === player.steamId
            && next.team === player.team;
        });
      if (unchanged) {
        const [latest] = await transaction<{
          id: string;
          status: "pending" | "claimed" | "completed" | "failed";
        }[]>`
          select id, status
          from node_commands
          where node_id = ${lease.node_id}
            and command_type in ('prepare', 'sync-roster')
            and payload->'manifest'->>'matchId' = ${matchId}
            and payload->'manifest'->>'issuedAt' = ${lease.manifest.issuedAt}
          order by created_at desc, id desc
          limit 1
        `;
        if (latest?.status === "failed") {
          throw new Error("The latest Deathmatch server preparation command failed.");
        }
        const commandId = latest && latest.status !== "completed" ? latest.id : null;
        return {
          lease: {
            ...leaseFromRow(lease),
            ...(commandId ? { commandId } : {})
          },
          commandId
        };
      }

      const manifest: SignedMatchManifest = {
        ...lease.manifest,
        manifestRevision: (lease.manifest.manifestRevision ?? 0) + 1,
        roster: nextRoster,
        cosmetics: await new InventoryService(this.sql).manifestsForPlayers(
          nextRoster.map((member) => member.playerId), "cosmetics", transaction
        ),
        issuedAt: new Date().toISOString()
      };
      const signature = signManifest(manifest, this.manifestSigningSecret);
      await transaction`
        update server_leases
        set manifest = ${transaction.json(asJson(manifest))},
            manifest_signature = ${signature}
        where id = ${lease.id}
      `;
      const [command] = await transaction<{ id: string }[]>`
        insert into node_commands (node_id, command_type, payload)
        values (
          ${lease.node_id}, 'sync-roster',
          ${transaction.json(asJson({
            leaseId: lease.id,
            fencingToken: String(lease.fencing_token),
            manifest,
            signature,
            serverInstanceId: lease.server_instance_id
          }))}
        )
        returning id
      `;
      if (!command) throw new Error("Deathmatch roster synchronization command was not created.");
      return {
        lease: {
          ...leaseFromRow({ ...lease, manifest, manifest_signature: signature }),
          commandId: command.id
        },
        commandId: command.id
      };
    });
  }

  private async synchronizeActiveInventory(
    transaction: postgres.TransactionSql, nodeId: string, leaseIds: string[]
  ): Promise<void> {
    if (leaseIds.length === 0) return;
    const leases = await transaction<LeaseRow[]>`
      select lease.id, lease.match_id, lease.server_instance_id, lease.fencing_token,
             lease.manifest, lease.manifest_signature, lease.expires_at
      from server_leases lease
      join server_instances instance on instance.id = lease.server_instance_id
      join matches match on match.id = lease.match_id
      where lease.id::text in (select jsonb_array_elements_text(${transaction.json(leaseIds)}))
        and instance.node_id = ${nodeId} and instance.active_lease_id = lease.id
        and lease.status = 'active' and lease.expires_at > now()
        and match.status in ('pending', 'live')
      order by lease.id
      for update of lease
    `;
    const inventory = new InventoryService(this.sql);
    for (const lease of leases) {
      const cosmetics = await inventory.manifestsForPlayers(
        lease.manifest.roster.map((member) => member.playerId), "cosmetics", transaction
      );
      if (canonicalJson(cosmetics) === canonicalJson(lease.manifest.cosmetics ?? [])) continue;
      const manifest: SignedMatchManifest = {
        ...lease.manifest,
        cosmetics,
        manifestRevision: (lease.manifest.manifestRevision ?? 0) + 1,
        issuedAt: new Date().toISOString()
      };
      const signature = signManifest(manifest, this.manifestSigningSecret);
      await transaction`
        update server_leases
        set manifest = ${transaction.json(asJson(manifest))}, manifest_signature = ${signature}
        where id = ${lease.id}
      `;
      await transaction`
        insert into node_commands (node_id, command_type, payload)
        values (${nodeId}, 'sync-inventory', ${transaction.json(asJson({ manifest, signature }))})
      `;
    }
  }

  async waitForCommand(commandId: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [command] = await this.sql<{
        status: "pending" | "claimed" | "completed" | "failed";
        result: Record<string, unknown> | null;
        last_error: string | null;
      }[]>`
        select status, result, last_error
        from node_commands
        where id = ${commandId}
      `;
      if (!command) throw new Error(`Node command ${commandId} no longer exists.`);
      if (command.status === "completed") return command.result ?? {};
      if (command.status === "failed") {
        throw new Error(command.last_error ?? `Node command ${commandId} failed.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The game server did not acknowledge the roster update in time.");
  }

  async releaseLease(leaseId: string, reason: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const [lease] = await transaction<{ server_instance_id: string; node_id: string }[]>`
        select lease.server_instance_id, instance.node_id
        from server_leases lease
        join server_instances instance on instance.id = lease.server_instance_id
        where lease.id = ${leaseId} and lease.status = 'active'
        for update of lease, instance
      `;
      if (!lease) return false;
      await transaction`
        update server_leases
        set status = 'released', released_at = now(), release_reason = ${reason}
        where id = ${leaseId}
      `;
      await transaction`
        update server_instances
        set state = 'draining', active_lease_id = null, updated_at = now()
        where id = ${lease.server_instance_id}
      `;
      await transaction`
        insert into node_commands (node_id, command_type, payload)
        values (
          ${lease.node_id}, 'drain',
          ${transaction.json(asJson({ leaseId, serverInstanceId: lease.server_instance_id, reason }))}
        )
      `;
      return true;
    });
  }

  private async quarantineLeaseFailure(
    transaction: postgres.TransactionSql,
    lease: LeaseFailureRow,
    reason: "lease_expired" | "srcds_unreachable",
    extraEvidence: Record<string, unknown> = {}
  ): Promise<void> {
    await transaction`
      update server_leases
      set status = 'expired', released_at = now(), release_reason = ${reason}
      where id = ${lease.id} and status = 'active'
    `;
    await transaction`
      update server_instances
      set state = 'quarantined', active_lease_id = null,
          quarantine_reason = ${reason}, updated_at = now()
      where id = ${lease.server_instance_id}
    `;
    await transaction`
      insert into node_commands (node_id, command_type, payload)
      values (
        ${lease.node_id}, 'quarantine',
        ${transaction.json(asJson({
          leaseId: lease.id,
          serverInstanceId: lease.server_instance_id,
          reason
        }))}
      )
    `;
    if (lease.match_status === "pending") {
      const cancelledReason = reason === "lease_expired"
        ? "server_lease_expired_before_live"
        : "srcds_unreachable_before_live";
      const cancelled = await transaction`
        update matches
        set status = 'cancelled', cancelled_reason = ${cancelledReason},
            ended_at = coalesce(ended_at, now())
        where id = ${lease.match_id} and status = 'pending'
      `;
      if (cancelled.count === 1) {
        await transaction`
          insert into audit_log (actor_id, action, target_type, target_id, detail)
          values (
            null, ${`match.${cancelledReason}`}, 'match', ${lease.match_id},
            ${transaction.json(asJson({
              leaseId: lease.id,
              serverInstanceId: lease.server_instance_id,
              nodeId: lease.node_id,
              ...extraEvidence
            }))}
          )
        `;
      }
    }
    if (
      (lease.match_status === "live" || lease.match_status === "disputed")
      && !lease.pending_result
    ) {
      await transaction`
        update matches
        set status = 'disputed', ended_at = coalesce(ended_at, now())
        where id = ${lease.match_id} and status in ('live', 'disputed')
      `;
      const [incident] = await transaction<{ id: string }[]>`
        insert into match_recovery_incidents (
          match_id, lease_id, reason, evidence
        ) values (
          ${lease.match_id}, ${lease.id}, ${reason === "lease_expired" ? "server_lease_expired" : reason},
          ${transaction.json(asJson({
            previousMatchStatus: lease.match_status,
            leaseId: lease.id,
            leaseExpiredAt: reason === "lease_expired" ? lease.expires_at.toISOString() : null,
            manifestSignature: lease.manifest_signature,
            nodeId: lease.node_id,
            serverAddress: lease.server_address,
            serverInstanceId: lease.server_instance_id,
            ...extraEvidence
          }))}
        )
        on conflict (match_id) do nothing
        returning id
      `;
      if (incident) {
        await transaction`
          insert into audit_log (actor_id, action, target_type, target_id, detail)
          values (
            null, 'match.recovery.opened', 'match_recovery_incident', ${incident.id},
            ${transaction.json(asJson({
              matchId: lease.match_id,
              leaseId: lease.id,
              reason: reason === "lease_expired" ? "server_lease_expired" : reason
            }))}
          )
        `;
      }
    }
    if (
      (lease.match_status === "live" || lease.match_status === "disputed")
      && lease.pending_result
    ) {
      await transaction`
        insert into audit_log (actor_id, action, target_type, target_id, detail)
        values (
          null, 'match.recovery.deferred_for_result', 'match', ${lease.match_id},
          ${transaction.json(asJson({ leaseId: lease.id, reason, ...extraEvidence }))}
        )
      `;
    }
  }

  async quarantineExpiredLeases(limit = 100): Promise<number> {
    return this.sql.begin(async (transaction) => {
      const leases = await transaction<LeaseFailureRow[]>`
        select lease.id, lease.match_id, lease.server_instance_id, instance.node_id,
               match.status as match_status, instance.address as server_address,
               lease.expires_at, lease.manifest_signature,
               exists (
                 select 1 from match_results result
                 where result.match_id = lease.match_id and result.status = 'pending'
               ) as pending_result
        from server_leases lease
        join server_instances instance on instance.id = lease.server_instance_id
        join matches match on match.id = lease.match_id
        where lease.status = 'active' and lease.expires_at <= now()
        order by lease.expires_at
        for update of lease, instance skip locked
        limit ${limit}
      `;
      for (const lease of leases) {
        await this.quarantineLeaseFailure(transaction, lease, "lease_expired");
      }
      return leases.length;
    });
  }
}
