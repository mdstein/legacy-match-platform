import { randomUUID } from "node:crypto";
import { createConnection, runMigrations, runSeeds, type Sql } from "@aftertick/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OperationsService, PlatformAccessError } from "../src/operations-service.js";
import { createApp } from "../src/app.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("platform operations", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const player1 = "00000000-0000-4000-8000-000000000001";
  const player2 = "00000000-0000-4000-8000-000000000002";
  const moderator = "00000000-0000-4000-8000-000000000009";
  const adminId = "00000000-0000-4000-8000-000000000010";
  let admin: Sql;
  let sql: Sql;
  let service: OperationsService;
  let matchId: string;

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
    await sql`
      update players set platform_role = case
        when id = ${moderator} then 'moderator'::platform_role
        when id = ${adminId} then 'admin'::platform_role
        else platform_role end
    `;
    matchId = randomUUID();
    await sql`insert into matches (id, map, region, status) values (${matchId}, 'Inferno', 'NA Central', 'completed')`;
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match)
      values (${matchId}, ${player1}, 'alpha', 1, 1000), (${matchId}, ${player2}, 'bravo', 1, 1010)
    `;
    await sql`
      insert into match_events (
        match_id, event_type, payload, event_id, sequence, occurred_at, payload_checksum
      ) values (
        ${matchId}, 'anticheat.signal',
        ${sql.json({
          policyVersion: 1,
          steamId: "90000000000000001",
          module: "smac_aimbot.smx",
          detectionType: 100,
          mode: "competitive",
          automaticAction: false
        })}::jsonb,
        ${randomUUID()}, 1, now(), ${"0".repeat(64)}
      )
    `;
    service = new OperationsService(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it("accepts only roster-backed reports and enforces moderator access", async () => {
    const report = await service.createReport({
      reporterId: player1,
      reportedId: player2,
      matchId,
      category: "griefing",
      description: "Repeatedly blocked teammates during live rounds.",
      ipAddress: "127.0.0.1"
    });
    expect(report).toMatchObject({
      reporterId: player1,
      reportedId: player2,
      matchId,
      category: "griefing",
      status: "pending"
    });

    await expect(service.createReport({
      reporterId: player1,
      reportedId: player2,
      matchId,
      category: "griefing",
      description: null,
      ipAddress: null
    })).rejects.toMatchObject({ status: 409 });
    await expect(service.listReports(player1, null, 50, 0))
      .rejects.toMatchObject({ status: 403 });

    expect(await service.listReports(moderator, "pending", 50, 0)).toHaveLength(1);
    const reviewed = await service.reviewReport({
      actorId: moderator,
      reportId: report.id,
      status: "resolved",
      resolution: "GOTV and event evidence confirmed the behavior.",
      ipAddress: "127.0.0.1"
    });
    expect(reviewed.status).toBe("resolved");
  });

  it("blocks sanctioned queue entry and restores access after an upheld workflow is overturned", async () => {
    const sanction = await service.createSanction({
      actorId: moderator,
      playerId: player2,
      sanctionType: "cooldown",
      reason: "Confirmed match disruption.",
      durationMinutes: 60,
      reportId: null,
      matchId,
      ipAddress: "127.0.0.1"
    });
    expect(sanction.isActive).toBe(true);
    await expect(service.assertCanQueue(player2)).rejects.toMatchObject({ status: 403 });

    const appeal = await service.createAppeal(
      player2,
      sanction.id,
      "The evidence was associated with the wrong round and should be reviewed.",
      "127.0.0.1"
    );
    expect(appeal.status).toBe("pending");
    expect(await service.listAppeals(moderator, "pending", 50, 0)).toHaveLength(1);

    const resolved = await service.resolveAppeal({
      actorId: moderator,
      appealId: appeal.id,
      status: "overturned",
      resolution: "Round context confirmed the report targeted the wrong player.",
      newDurationMinutes: null,
      ipAddress: "127.0.0.1"
    });
    expect(resolved.status).toBe("overturned");
    await expect(service.assertCanQueue(player2)).resolves.toBeUndefined();
  });

  it("exposes signed anti-cheat evidence only to moderators without automatic action", async () => {
    await expect(service.listAntiCheatSignals(player1, 50, 0))
      .rejects.toMatchObject({ status: 403 });
    const [signal] = await service.listAntiCheatSignals(moderator, 50, 0);
    expect(signal).toMatchObject({
      matchId,
      playerId: player2,
      steamId: "90000000000000001",
      displayName: "Aftertick Test 2",
      module: "smac_aimbot.smx",
      detectionType: 100,
      mode: "competitive",
      map: "Inferno",
      automaticAction: false,
      synthetic: false
    });
  });

  it("uses optimistic admin kill switches and journals every consequential action", async () => {
    const controls = await service.getControls();
    await expect(service.updateControls({
      actorId: moderator,
      version: controls.version,
      registrationEnabled: true,
      queueEnabled: false,
      serverAllocationEnabled: true,
      userMessage: "Maintenance in progress.",
      ipAddress: "127.0.0.1"
    })).rejects.toBeInstanceOf(PlatformAccessError);

    const updated = await service.updateControls({
      actorId: adminId,
      version: controls.version,
      registrationEnabled: true,
      queueEnabled: false,
      serverAllocationEnabled: false,
      userMessage: "Maintenance in progress.",
      ipAddress: "127.0.0.1"
    });
    expect(updated).toMatchObject({ queueEnabled: false, serverAllocationEnabled: false, version: 2 });
    await expect(service.assertCanQueue(player1)).rejects.toMatchObject({ status: 503 });
    await expect(service.assertAllocationEnabled()).rejects.toMatchObject({ status: 503 });
    await expect(service.updateControls({
      actorId: adminId,
      version: controls.version,
      registrationEnabled: true,
      queueEnabled: true,
      serverAllocationEnabled: true,
      userMessage: null,
      ipAddress: null
    })).rejects.toMatchObject({ status: 409 });

    const audit = await service.listAudit(adminId, 100, 0);
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "report.created",
      "report.reviewed",
      "sanction.created",
      "sanction.appealed",
      "appeal.resolved",
      "platform.controls.updated"
    ]));
  });

  it("enforces CSRF, player identity, role checks, and kill switches through HTTP", async () => {
    const playerApp = createApp({
      sql,
      operations: service,
      devIdentity: { playerId: player1, steamId: "90000000000000000", displayName: "Aftertick Test 1" },
      session: { secret: "aftertick-operations-integration-session-secret" }
    });
    const playerAgent = request.agent(playerApp);
    const csrf = await playerAgent.get("/api/auth/csrf").expect(200);

    await playerAgent.post("/api/reports").send({
      reportedId: player2,
      matchId,
      category: "toxicity",
      description: "Voice communication abuse during the match."
    }).expect(403);
    await playerAgent.post("/api/reports")
      .set("X-CSRF-Token", csrf.body.token)
      .send({
        reportedId: player2,
        matchId,
        category: "toxicity",
        description: "Voice communication abuse during the match."
      })
      .expect(201);
    await playerAgent.get("/api/moderation/reports").expect(403);
    await playerAgent.post("/api/queue/join")
      .set("X-CSRF-Token", csrf.body.token)
      .send({ regions: ["NA Central"], maps: ["Inferno"] })
      .expect(503);

    const adminApp = createApp({
      sql,
      operations: service,
      devIdentity: { playerId: adminId, steamId: "90000000000000009", displayName: "Aftertick Test 10" },
      session: { secret: "aftertick-operations-admin-integration-secret" }
    });
    const adminAgent = request.agent(adminApp);
    const adminCsrf = await adminAgent.get("/api/auth/csrf").expect(200);
    const controls = await adminAgent.get("/api/admin/controls").expect(200);
    await adminAgent.patch("/api/admin/controls")
      .set("X-CSRF-Token", adminCsrf.body.token)
      .send({
        version: controls.body.version,
        registrationEnabled: true,
        queueEnabled: true,
        serverAllocationEnabled: true,
        userMessage: null
      })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ queueEnabled: true, serverAllocationEnabled: true });
      });
  });
});
