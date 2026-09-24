import { randomBytes, randomUUID } from "node:crypto";
import type { GameMode, MapVetoState, MatchAssignment, MapVetoTeam } from "@aftertick/contracts";
import type { Sql } from "@aftertick/db";
import { DEATHMATCH_MAP } from "./catalog.js";
import type { MatchPlan } from "./matchmaker.js";
import { NodeControlService, type MatchManifestPayload } from "./node-control-service.js";
import type { InventoryService } from "./inventory-service.js";

interface ReservedRosterPlayer {
  playerId: string;
  steamId: string;
  team: MapVetoTeam | "ffa";
}

interface ReservedMatch {
  mode: GameMode;
  map: string;
  mapPool: string[];
  region: string;
  status: "pending" | "live" | "completed" | "cancelled" | "disputed";
  roster: ReservedRosterPlayer[];
}

function validateCompletedVeto(state: MapVetoState, reserved: ReservedMatch): void {
  if (state.status !== "allocating" || !state.selectedMap) {
    throw new Error("Map veto must be complete before server allocation.");
  }
  if (state.region !== reserved.region) {
    throw new Error("Map-veto region does not match the reserved match.");
  }
  if (
    state.remainingMaps.length !== 1
    || state.remainingMaps[0] !== state.selectedMap
    || !reserved.mapPool.includes(state.selectedMap)
  ) {
    throw new Error("Map veto did not select exactly one map from the reserved pool.");
  }
  if (state.bans.length !== reserved.mapPool.length - 1) {
    throw new Error("Map veto does not contain one append-only ban for every rejected map.");
  }
  const rosterTeam = new Map(reserved.roster.map((player) => [player.playerId, player.team]));
  if (
    rosterTeam.get(state.captains.alpha) !== "alpha"
    || rosterTeam.get(state.captains.bravo) !== "bravo"
  ) {
    throw new Error("Map-veto captains must belong to their reserved teams.");
  }
  const banned = new Set<string>();
  state.bans.forEach((ban, index) => {
    const expectedTeam: MapVetoTeam = index % 2 === 0 ? "alpha" : "bravo";
    if (
      ban.sequence !== index + 1
      || ban.team !== expectedTeam
      || ban.captainPlayerId !== state.captains[ban.team]
      || !reserved.mapPool.includes(ban.map)
      || ban.map === state.selectedMap
      || banned.has(ban.map)
      || !Number.isFinite(new Date(ban.createdAt).getTime())
    ) {
      throw new Error("Map veto contains an invalid captain, order, map, or timestamp.");
    }
    banned.add(ban.map);
  });
}

export class MatchOrchestrator {
  constructor(
    private readonly sql: Sql,
    private readonly nodes: NodeControlService,
    private readonly inventory?: Pick<
      InventoryService,
      "ensureFreshForPlayers" | "manifestsForPlayers" | "issueLauncherGrant"
    >,
    private readonly publicUrl?: string
  ) {}

  private async launcherUrl(matchId: string, serverAddress: string, serverPassword: string): Promise<string> {
    const launcher = new URL("b2g://connect");
    launcher.searchParams.set("server", serverAddress);
    launcher.searchParams.set("password", serverPassword);
    if (this.inventory && this.publicUrl) {
      const grant = await this.inventory.issueLauncherGrant(matchId);
      const endpoint = new URL(`/api/launcher/v1/inventory/${grant.id}`, this.publicUrl);
      launcher.searchParams.set("inventory", endpoint.toString());
      launcher.searchParams.set("inventory_token", grant.token);
    }
    return launcher.toString();
  }

  async joinDeathmatch(input: {
    playerIds: string[];
    regions: string[];
  }): Promise<MatchAssignment> {
    const playerIds = [...new Set(input.playerIds)];
    const region = input.regions[0];
    if (playerIds.length < 1 || playerIds.length > 14 || !region) {
      throw new Error("A drop-in Deathmatch entry requires 1-14 players and a region.");
    }
    const provisionalMap = DEATHMATCH_MAP;
    const matchId = await this.sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext(${`b2g:deathmatch:${region}`}))`;
      const players = await transaction<{
        id: string;
        steam_id: string | null;
        rating: number;
      }[]>`
        select player.id::text, player.steam_id, player.rating
        from players player
        where player.id::text in (
          select jsonb_array_elements_text(${transaction.json(playerIds)})
        )
          and not (player.is_banned and (player.ban_expires_at is null or player.ban_expires_at > now()))
          and not exists (
            select 1 from sanctions sanction
            where sanction.player_id = player.id and sanction.is_active = true
              and sanction.sanction_type in ('cooldown', 'temp_ban', 'perm_ban')
              and (sanction.ends_at is null or sanction.ends_at > now())
          )
        order by player.id
      `;
      if (players.length !== playerIds.length || players.some((player) => !player.steam_id)) {
        throw new Error("Every Deathmatch player must be eligible and linked to Steam.");
      }

      const activeMemberships = await transaction<{ match_id: string; player_id: string }[]>`
        select roster.match_id::text, roster.player_id::text
        from rosters roster
        join matches match on match.id = roster.match_id
        where roster.player_id::text in (
          select jsonb_array_elements_text(${transaction.json(playerIds)})
        )
          and match.mode = 'deathmatch'
          and match.status in ('pending', 'live')
      `;
      const existingMatchIds = [...new Set(activeMemberships.map((row) => row.match_id))];
      if (existingMatchIds.length > 1) {
        throw new Error("The party is already split across active Deathmatch sessions.");
      }

      let selectedMatchId = existingMatchIds[0] ?? null;
      if (!selectedMatchId) {
        const [open] = await transaction<{ id: string }[]>`
          select match.id::text
          from matches match
          where match.mode = 'deathmatch'
            and match.region = ${region}
            and match.status in ('pending', 'live')
            and (
              match.status = 'pending'
              or exists (
                select 1 from server_leases lease
                where lease.match_id = match.id and lease.status = 'active'
                  and lease.expires_at > now()
              )
            )
            and (
              select count(*) from rosters roster where roster.match_id = match.id
            ) + ${players.length} <= 14
          order by case when match.status = 'live' then 0 else 1 end,
                   match.created_at, match.id
          limit 1
        `;
        selectedMatchId = open?.id ?? null;
      }

      if (!selectedMatchId) {
        selectedMatchId = randomUUID();
        await transaction`
          insert into matches (
            id, season_id, map, map_pool, region, status, ruleset_version,
            mode, frag_limit, time_limit_seconds
          ) values (
            ${selectedMatchId},
            (select id from seasons where is_active = true order by starts_at desc limit 1),
            ${provisionalMap}, ${[DEATHMATCH_MAP]}, ${region}, 'pending', 'dm-1.0',
            'deathmatch', 40, 600
          )
        `;
      } else {
        const [locked] = await transaction<{ id: string; region: string; roster_count: number }[]>`
          select match.id::text, match.region,
                 (select count(*)::int from rosters roster where roster.match_id = match.id) as roster_count
          from matches match
          where match.id = ${selectedMatchId}
            and match.mode = 'deathmatch'
            and match.status in ('pending', 'live')
          for update
        `;
        if (!locked || locked.region !== region) {
          throw new Error("The active Deathmatch session is no longer joinable in this region.");
        }
        const missingCount = players.filter((player) =>
          !activeMemberships.some((membership) => membership.player_id === player.id)
        ).length;
        if (locked.roster_count + missingCount > 14) {
          throw new Error("The active Deathmatch session filled before this entry completed.");
        }
      }

      const [slotRow] = await transaction<{ next_slot: number }[]>`
        select coalesce(max(slot), 0)::int + 1 as next_slot
        from rosters
        where match_id = ${selectedMatchId}
      `;
      let slot = slotRow?.next_slot ?? 1;
      for (const player of players) {
        const exists = activeMemberships.some((membership) =>
          membership.match_id === selectedMatchId && membership.player_id === player.id
        );
        if (exists) continue;
        await transaction`
          insert into rosters (match_id, player_id, team, slot, rating_at_match)
          values (${selectedMatchId}, ${player.id}, 'ffa', ${slot}, ${player.rating})
        `;
        slot += 1;
      }
      return selectedMatchId;
    });

    return this.allocateDropInDeathmatch(matchId);
  }

  async reserve(plan: MatchPlan, matchId: string): Promise<{ abort: () => Promise<void> }> {
    const players = plan.tickets.flatMap((ticket) => ticket.players);
    const expectedPlayers = plan.mode === "deathmatch" ? 14 : 10;
    if (players.length !== expectedPlayers) {
      throw new Error(`${plan.mode} match reservations require ${expectedPlayers} players.`);
    }
    if (plan.mapPool.length === 0 || !plan.mapPool.includes(plan.map)) {
      throw new Error("A match reservation requires its provisional map in the shared map pool.");
    }
    const teamByPlayer = new Map<string, MapVetoTeam | "ffa">(
      plan.mode === "deathmatch"
        ? players.map((player) => [player.playerId, "ffa" as const])
        : [
            ...plan.alphaPlayerIds.map((playerId) => [playerId, "alpha" as const] as const),
            ...plan.bravoPlayerIds.map((playerId) => [playerId, "bravo" as const] as const)
          ]
    );

    await this.sql.begin(async (transaction) => {
      await transaction`
        insert into matches (
          id, season_id, map, map_pool, region, status, ruleset_version,
          mode, frag_limit, time_limit_seconds
        )
        values (
          ${matchId},
          (select id from seasons where is_active = true order by starts_at desc limit 1),
          ${plan.map},
          ${plan.mapPool},
          ${plan.region},
          'pending',
          ${plan.mode === "deathmatch" ? "dm-1.0" : "1.0"},
          ${plan.mode},
          ${plan.mode === "deathmatch" ? 40 : null},
          ${plan.mode === "deathmatch" ? 600 : null}
        )
      `;
      const slots = { alpha: 0, bravo: 0, ffa: 0 };
      for (const player of players) {
        const team = teamByPlayer.get(player.playerId);
        if (!team) throw new Error(`Player ${player.playerId} has no assigned team.`);
        slots[team] += 1;
        await transaction`
          insert into rosters (match_id, player_id, team, slot, rating_at_match)
          values (${matchId}, ${player.playerId}, ${team}, ${slots[team]}, ${player.rating})
        `;
      }
    });

    return {
      abort: () => this.cancelReservedMatch(matchId, "ready_check_creation_failed")
    };
  }

  async finalizeMapVeto(state: MapVetoState): Promise<MatchAssignment> {
    return this.allocate(state.matchId, state.selectedMap ?? "", state);
  }

  async prepare(plan: MatchPlan, matchId: string): Promise<{
    assignment: Omit<MatchAssignment, "matchId" | "map" | "region">;
    abort: () => Promise<void>;
  }> {
    const reservation = await this.reserve(plan, matchId);
    try {
      const assignment = await this.allocate(matchId, plan.map, null);
      return {
        assignment: {
          serverLabel: assignment.serverLabel,
          address: assignment.address,
          connectUrl: assignment.connectUrl,
          launcherUrl: assignment.launcherUrl
        },
        abort: () => this.cancelReservedMatch(matchId, "ready_check_creation_failed")
      };
    } catch (error) {
      await reservation.abort();
      throw error;
    }
  }

  async cancelPendingMatch(matchId: string, reason: "decline" | "expiry"): Promise<void> {
    await this.cancelReservedMatch(matchId, `ready_check_${reason}`);
  }

  private async allocate(
    matchId: string,
    selectedMap: string,
    veto: MapVetoState | null
  ): Promise<MatchAssignment> {
    const reserved = await this.sql.begin(async (transaction): Promise<ReservedMatch> => {
      const [match] = await transaction<{
        mode: GameMode;
        map: string;
        map_pool: string[];
        region: string;
        frag_limit: number | null;
        time_limit_seconds: number | null;
        status: ReservedMatch["status"];
      }[]>`
        select mode, map, map_pool, region, frag_limit, time_limit_seconds, status::text as status
        from matches where id = ${matchId}
        for update
      `;
      if (!match) throw new Error(`Reserved match ${matchId} does not exist.`);
      if (match.status !== "pending") {
        throw new Error(`Reserved match ${matchId} is ${match.status}, not pending.`);
      }
      const roster = await transaction<{
        player_id: string;
        steam_id: string | null;
        team: MapVetoTeam | "ffa";
      }[]>`
        select roster.player_id::text, player.steam_id, roster.team
        from rosters roster
        join players player on player.id = roster.player_id
        where roster.match_id = ${matchId}
        order by roster.team, roster.slot
        for update of roster
      `;
      const expectedPlayers = match.mode === "deathmatch" ? 14 : 10;
      if (roster.length !== expectedPlayers || roster.some((player) => !player.steam_id)) {
        throw new Error(`A finalized ${match.mode} server manifest requires ${expectedPlayers} Steam-linked players.`);
      }
      if (
        (match.mode === "deathmatch" && roster.some((player) => player.team !== "ffa"))
        || (match.mode === "competitive" && roster.some((player) => player.team === "ffa"))
      ) {
        throw new Error("The reserved roster teams do not match the game mode.");
      }
      const state: ReservedMatch = {
        mode: match.mode,
        map: match.map,
        mapPool: match.map_pool,
        region: match.region,
        status: match.status,
        roster: roster.map((player) => ({
          playerId: player.player_id,
          steamId: player.steam_id!,
          team: player.team
        }))
      };
      if (!state.mapPool.includes(selectedMap)) {
        throw new Error("Selected map is outside the reserved shared pool.");
      }
      if (veto) {
        if (state.mode !== "competitive") throw new Error("Deathmatch does not support map veto.");
        if (veto.matchId !== matchId) throw new Error("Map-veto match ID does not match finalization.");
        validateCompletedVeto(veto, state);
        for (const ban of veto.bans) {
          await transaction`
            insert into match_map_veto_actions (
              match_id, sequence, team, captain_player_id, map, automated, created_at
            ) values (
              ${matchId}, ${ban.sequence}, ${ban.team}, ${ban.captainPlayerId},
              ${ban.map}, ${ban.automated}, ${new Date(ban.createdAt)}
            )
            on conflict (match_id, sequence) do nothing
          `;
        }
        const persisted = await transaction<{
          sequence: number;
          team: MapVetoTeam;
          captain_player_id: string;
          map: string;
          automated: boolean;
          created_at: Date;
        }[]>`
          select sequence, team, captain_player_id::text, map, automated, created_at
          from match_map_veto_actions
          where match_id = ${matchId}
          order by sequence
        `;
        if (
          persisted.length !== veto.bans.length
          || persisted.some((row, index) => {
            const ban = veto.bans[index]!;
            return row.sequence !== ban.sequence
              || row.team !== ban.team
              || row.captain_player_id !== ban.captainPlayerId
              || row.map !== ban.map
              || row.automated !== ban.automated
              || row.created_at.toISOString() !== new Date(ban.createdAt).toISOString();
          })
        ) {
          throw new Error("Persisted map-veto evidence conflicts with the finalization request.");
        }
      }
      await transaction`update matches set map = ${selectedMap} where id = ${matchId}`;
      return state;
    });

    const rosterPlayerIds = reserved.roster.map((player) => player.playerId);
    await this.inventory?.ensureFreshForPlayers(rosterPlayerIds);
    const payload: MatchManifestPayload = {
      mode: reserved.mode,
      roster: reserved.roster.map((player) => ({
        playerId: player.playerId,
        steamId: player.steamId,
        team: player.team
      })),
      cosmetics: await this.inventory?.manifestsForPlayers(rosterPlayerIds, "cosmetics") ?? [],
      map: selectedMap,
      rulesetVersion: reserved.mode === "deathmatch" ? "dm-1.0" : "1.0",
      fragLimit: reserved.mode === "deathmatch" ? 40 : null,
      timeLimitSeconds: reserved.mode === "deathmatch" ? 600 : null,
      pluginVersion: "0.1.0",
      serverConfigVersion: "1.0",
      demoObjectKey: `matches/${matchId}/gotv.dem`,
      eventIngestSecret: randomBytes(32).toString("base64url"),
      serverPassword: randomBytes(24).toString("base64url"),
      integrityPolicy: {
        protocolVersion: 1,
        provider: "none",
        enforcement: "disabled"
      }
    };

    const lease = await this.nodes.leaseReadyServer({
      matchId,
      region: reserved.region,
      ttlSeconds: 3 * 60 * 60,
      payload
    });
    await this.sql`
      update matches set server_address = ${lease.manifest.serverAddress}
      where id = ${matchId} and status = 'pending'
    `;
    return {
      mode: reserved.mode,
      matchId,
      map: lease.manifest.map,
      region: reserved.region,
      serverLabel: `B2G ${reserved.region} · ${lease.manifest.serverInstanceId.slice(0, 8)}`,
      address: lease.manifest.serverAddress,
      connectUrl: `steam://connect/${lease.manifest.serverAddress}/${lease.manifest.serverPassword}`,
      launcherUrl: await this.launcherUrl(
        matchId,
        lease.manifest.serverAddress,
        lease.manifest.serverPassword
      )
    };
  }

  private async allocateDropInDeathmatch(matchId: string): Promise<MatchAssignment> {
    const [match] = await this.sql<{
      map: string;
      region: string;
      status: "pending" | "live";
    }[]>`
      select map, region, status::text as status
      from matches
      where id = ${matchId} and mode = 'deathmatch' and status in ('pending', 'live')
    `;
    if (!match) throw new Error("The Deathmatch session ended before assignment completed.");
    const roster = await this.sql<ReservedRosterPlayer[]>`
      select roster.player_id::text as "playerId", player.steam_id as "steamId", roster.team
      from rosters roster
      join players player on player.id = roster.player_id
      where roster.match_id = ${matchId}
      order by roster.slot
    `;
    if (
      roster.length < 1
      || roster.length > 14
      || roster.some((player) => !player.steamId || player.team !== "ffa")
    ) {
      throw new Error("A drop-in Deathmatch manifest requires 1-14 Steam-linked humans.");
    }

    const rosterPlayerIds = roster.map((player) => player.playerId);
    await this.inventory?.ensureFreshForPlayers(rosterPlayerIds);
    const cosmetics = await this.inventory?.manifestsForPlayers(rosterPlayerIds, "cosmetics") ?? [];
    const payload: MatchManifestPayload = {
      mode: "deathmatch",
      roster,
      cosmetics,
      map: match.map,
      rulesetVersion: "dm-1.0",
      fragLimit: 40,
      timeLimitSeconds: 600,
      pluginVersion: "0.1.0",
      serverConfigVersion: "1.0",
      demoObjectKey: `matches/${matchId}/gotv.dem`,
      eventIngestSecret: randomBytes(32).toString("base64url"),
      serverPassword: randomBytes(24).toString("base64url"),
      integrityPolicy: {
        protocolVersion: 1,
        provider: "none",
        enforcement: "disabled"
      }
    };
    let lease = await this.nodes.leaseReadyServer({
      matchId,
      region: match.region,
      ttlSeconds: 3 * 60 * 60,
      payload
    });
    if (lease.commandId) await this.nodes.waitForCommand(lease.commandId);

    const synchronized = await this.nodes.synchronizeDeathmatchRoster(
      matchId
    );
    lease = synchronized.lease;
    if (synchronized.commandId) await this.nodes.waitForCommand(synchronized.commandId);

    await this.sql`
      update matches set server_address = ${lease.manifest.serverAddress}
      where id = ${matchId} and status in ('pending', 'live')
    `;
    const humanPlayers = lease.manifest.roster.length;
    return {
      mode: "deathmatch",
      matchId,
      map: lease.manifest.map,
      region: match.region,
      serverLabel: `B2G ${match.region} · Drop-in DM`,
      address: lease.manifest.serverAddress,
      connectUrl: `steam://connect/${lease.manifest.serverAddress}/${lease.manifest.serverPassword}`,
      launcherUrl: await this.launcherUrl(
        matchId,
        lease.manifest.serverAddress,
        lease.manifest.serverPassword
      ),
      humanPlayers,
      botPlayers: Math.max(0, 14 - humanPlayers),
      capacity: 14
    };
  }

  private async cancelReservedMatch(matchId: string, reason: string): Promise<void> {
    const [lease] = await this.sql<{ id: string }[]>`
      select id
      from server_leases
      where match_id = ${matchId} and status = 'active'
      order by leased_at desc
      limit 1
    `;
    if (lease) await this.nodes.releaseLease(lease.id, reason);
    await this.sql`
      update matches
      set status = 'cancelled', cancelled_reason = ${reason}
      where id = ${matchId} and status = 'pending'
    `;
  }
}
