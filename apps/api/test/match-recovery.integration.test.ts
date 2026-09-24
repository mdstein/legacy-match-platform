import { randomUUID } from "node:crypto";
import type { MatchAssignment } from "@aftertick/contracts";
import { createConnection, runMigrations, runSeeds, type Sql } from "@aftertick/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MatchRecoveryService } from "../src/match-recovery-service.js";
import { NodeControlService } from "../src/node-control-service.js";
import { OperationsService } from "../src/operations-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("live match recovery", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const adminId = "00000000-0000-4000-8000-000000000010";
  const playerId = "00000000-0000-4000-8000-000000000001";
  const signingSecret = "aftertick-match-recovery-integration-signing-secret";
  const queueCalls: Array<{ oldMatchId: string; assignment: MatchAssignment; playerIds: string[] }> = [];
  let admin!: Sql;
  let sql!: Sql;
  let nodes!: NodeControlService;
  let operations!: OperationsService;
  let recovery!: MatchRecoveryService;
  let nodeToken = "";

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
    await runMigrations(sql);
    await runSeeds(sql, { includeTestPlayers: true });
    await sql`update players set platform_role = 'admin' where id = ${adminId}`;
    nodes = new NodeControlService(sql, signingSecret);
    operations = new OperationsService(sql);
    recovery = new MatchRecoveryService(sql, nodes, operations, {
      async reassignMatch(oldMatchId, assignment, playerIds) {
        queueCalls.push({ oldMatchId, assignment, playerIds });
        return { players: playerIds.length, tickets: playerIds.length };
      }
    });
    const registered = await nodes.registerNode({ name: "recovery-node", region: "NA Recovery" });
    nodeToken = registered.token;
    await nodes.heartbeat(nodeToken, {
      agentVersion: "recovery-integration-1",
      capacityTotal: 4,
      instances: Array.from({ length: 4 }, (_, index) => ({
        instanceKey: `recovery-${index + 1}`,
        state: "ready" as const,
        address: `127.0.0.1:${27515 + index * 10}`,
        gamePort: 27515 + index * 10,
        gotvPort: 27520 + index * 10,
        serverBuildId: "12426148",
        pluginVersion: "0.1.0"
      }))
    });
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  async function createFailedLiveMatch(): Promise<{ matchId: string; incidentId: string }> {
    const matchId = randomUUID();
    await sql`
      insert into matches (id, season_id, map, region, status, ruleset_version, started_at)
      values (
        ${matchId}, (select id from seasons where is_active = true),
        'Mirage', 'NA Recovery', 'live', '1.0', now() - interval '10 minutes'
      )
    `;
    const players = await sql<{ id: string; steam_id: string; rating: number }[]>`
      select id, steam_id, rating from players
      where steam_id is not null order by steam_id limit 10
    `;
    for (const [index, player] of players.entries()) {
      const team = index < 5 ? "alpha" : "bravo";
      await sql`
        insert into rosters (match_id, player_id, team, slot, rating_at_match)
        values (${matchId}, ${player.id}, ${team}, ${(index % 5) + 1}, ${player.rating})
      `;
    }
    const lease = await nodes.leaseReadyServer({
      matchId,
      region: "NA Recovery",
      ttlSeconds: 60,
      payload: {
        roster: players.map((player, index) => ({
          playerId: player.id,
          steamId: player.steam_id,
          team: index < 5 ? "alpha" as const : "bravo" as const
        })),
        map: "Mirage",
        region: "NA Recovery",
        rulesetVersion: "1.0",
        pluginVersion: "0.1.0",
        serverConfigVersion: "1.0",
        demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret: "aftertick-recovery-event-ingest-secret-12345",
        serverPassword: "aftertickRecoveryPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    await sql`
      update server_leases
      set leased_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
      where id = ${lease.id}
    `;
    expect(await nodes.quarantineExpiredLeases()).toBe(1);
    const [incident] = await sql<{ id: string }[]>`
      select id from match_recovery_incidents where match_id = ${matchId}
    `;
    expect(incident).toBeDefined();
    return { matchId, incidentId: incident!.id };
  }

  it("quarantines, preserves evidence, remakes once, and delivers a fresh assignment", async () => {
    const failed = await createFailedLiveMatch();
    await expect(recovery.list(playerId, null, 50, 0)).rejects.toMatchObject({ status: 403 });
    const [opened] = await recovery.list(adminId, "open", 50, 0);
    expect(opened).toMatchObject({
      id: failed.incidentId,
      matchId: failed.matchId,
      matchStatus: "disputed",
      reason: "server_lease_expired",
      status: "open"
    });
    expect(opened?.evidence).toMatchObject({ previousMatchStatus: "live" });

    const resolved = await recovery.resolve({
      actorId: adminId,
      incidentId: failed.incidentId,
      action: "remake",
      note: "Live server stopped responding; GOTV and event evidence were preserved.",
      ipAddress: "127.0.0.1"
    });
    expect(resolved).toMatchObject({
      status: "resolved",
      resolutionAction: "remake",
      queueReassignedPlayers: 10,
      queueDeliveryError: null
    });
    expect(resolved.replacementMatchId).not.toBe(failed.matchId);
    expect(resolved.replacementAssignment).toMatchObject({
      matchId: resolved.replacementMatchId,
      map: "Mirage",
      region: "NA Recovery"
    });
    expect(queueCalls.at(-1)).toMatchObject({
      oldMatchId: failed.matchId,
      playerIds: expect.arrayContaining([playerId, adminId])
    });

    const repeated = await recovery.resolve({
      actorId: adminId,
      incidentId: failed.incidentId,
      action: "remake",
      note: "Idempotent operator retry.",
      ipAddress: null
    });
    expect(repeated.replacementMatchId).toBe(resolved.replacementMatchId);
    const [evidence] = await sql<{
      originals: number;
      replacements: number;
      replacement_leases: number;
      replacement_roster: number;
      ratings: number;
      opened_audits: number;
      remade_audits: number;
    }[]>`
      select
        (select count(*)::int from matches where id = ${failed.matchId} and status = 'cancelled') as originals,
        (select count(*)::int from matches where id = ${resolved.replacementMatchId}) as replacements,
        (select count(*)::int from server_leases where match_id = ${resolved.replacementMatchId}) as replacement_leases,
        (select count(*)::int from rosters where match_id = ${resolved.replacementMatchId}) as replacement_roster,
        (select count(*)::int from rating_changes where match_id = ${failed.matchId}) as ratings,
        (select count(*)::int from audit_log where action = 'match.recovery.opened' and detail->>'matchId' = ${failed.matchId}) as opened_audits,
        (select count(*)::int from audit_log where action = 'match.recovery.remade' and detail->>'matchId' = ${failed.matchId}) as remade_audits
    `;
    expect(evidence).toEqual({
      originals: 1,
      replacements: 1,
      replacement_leases: 1,
      replacement_roster: 10,
      ratings: 0,
      opened_audits: 1,
      remade_audits: 1
    });
  });

  it("enforces admin identity and CSRF while voiding without a rating", async () => {
    const failed = await createFailedLiveMatch();
    const playerApp = createApp({
      sql,
      operations,
      matchRecovery: recovery,
      devIdentity: { playerId, steamId: "90000000000000000", displayName: "Aftertick Test 1" },
      session: { secret: "aftertick-recovery-player-http-session-secret" }
    });
    await request.agent(playerApp).get("/api/admin/match-recovery").expect(403);

    const adminApp = createApp({
      sql,
      operations,
      matchRecovery: recovery,
      devIdentity: { playerId: adminId, steamId: "90000000000000009", displayName: "Aftertick Test 10" },
      session: { secret: "aftertick-recovery-admin-http-session-secret" }
    });
    const agent = request.agent(adminApp);
    await agent.post(`/api/admin/match-recovery/${failed.incidentId}/resolve`).send({
      action: "void",
      note: "Server failure invalidated the competitive result."
    }).expect(403);
    const csrf = await agent.get("/api/auth/csrf").expect(200);
    const response = await agent.post(`/api/admin/match-recovery/${failed.incidentId}/resolve`)
      .set("X-CSRF-Token", csrf.body.token)
      .send({ action: "void", note: "Server failure invalidated the competitive result." })
      .expect(200);
    expect(response.body).toMatchObject({
      status: "resolved",
      resolutionAction: "void",
      replacementMatchId: null
    });
    const [state] = await sql<{ status: string; ratings: number }[]>`
      select match.status::text as status,
             (select count(*)::int from rating_changes where match_id = match.id) as ratings
      from matches match where match.id = ${failed.matchId}
    `;
    expect(state).toEqual({ status: "cancelled", ratings: 0 });
  });

  it("persists one staged remake through zero capacity and resumes it after capacity returns", async () => {
    const failed = await createFailedLiveMatch();
    await expect(recovery.resolve({
      actorId: adminId,
      incidentId: failed.incidentId,
      action: "remake",
      note: "Awaiting replacement capacity after the live server failure.",
      ipAddress: null
    })).rejects.toMatchObject({ status: 503 });
    const [staged] = await recovery.list(adminId, "resolving", 50, 0);
    expect(staged).toMatchObject({ id: failed.incidentId, status: "resolving" });
    expect(staged?.replacementMatchId).toBeTruthy();
    expect(staged?.resolutionError).toMatch(/No ready server capacity/);
    const stagedReplacementId = staged!.replacementMatchId!;

    await nodes.heartbeat(nodeToken, {
      agentVersion: "recovery-integration-1",
      capacityTotal: 5,
      instances: [{
        instanceKey: "recovery-5",
        state: "ready",
        address: "127.0.0.1:27555",
        gamePort: 27555,
        gotvPort: 27560,
        serverBuildId: "12426148",
        pluginVersion: "0.1.0"
      }]
    });
    const resumed = await recovery.resolve({
      actorId: adminId,
      incidentId: failed.incidentId,
      action: "remake",
      note: "Retry after capacity returned.",
      ipAddress: null
    });
    expect(resumed).toMatchObject({
      status: "resolved",
      replacementMatchId: stagedReplacementId,
      resolutionError: null
    });
    const [counts] = await sql<{ replacements: number; leases: number }[]>`
      select
        (select count(*)::int from matches where id = ${stagedReplacementId}) as replacements,
        (select count(*)::int from server_leases where match_id = ${stagedReplacementId}) as leases
    `;
    expect(counts).toEqual({ replacements: 1, leases: 1 });
  });
});
