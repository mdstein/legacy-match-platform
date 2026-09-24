import { createHmac, randomUUID } from "node:crypto";
import type { LatencyProbeSubmission } from "@aftertick/contracts";
import { createConnection, runMigrations, type Sql } from "@aftertick/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalLatencySubmission,
  LatencyProbeService
} from "../src/latency-probe-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("signed regional latency probes", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const playerId = randomUUID();
  let admin: Sql;
  let sql: Sql;
  let service: LatencyProbeService;

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
    await sql`
      insert into players (id, steam_id, display_name, region)
      values (${playerId}, '76561198000000123', 'Latency Player', 'NA Central')
    `;
    service = new LatencyProbeService(sql, {
      publicUrl: "https://play.example.test",
      endpoints: {
        "NA Central": "na.example.test:27015",
        "EU Central": "eu.example.test:27015"
      },
      challengeSeconds: 120,
      measurementSeconds: 900,
      samples: 5
    });
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  function signed(token: string, submission: LatencyProbeSubmission): string {
    return createHmac("sha256", token)
      .update(canonicalLatencySubmission(submission))
      .digest("hex");
  }

  it("consumes a challenge once and exposes conservative fresh routing values", async () => {
    const challenge = await service.issue(playerId, ["NA Central", "EU Central"]);
    const link = new URL(challenge.launcherUrl);
    const token = link.searchParams.get("token")!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(link.searchParams.get("submit")).toBe("https://play.example.test/api/latency/v1/reports");
    const [stored] = await sql<{ token_sha256: string }[]>`
      select token_sha256 from latency_probe_challenges where id = ${challenge.challengeId}
    `;
    expect(stored?.token_sha256).not.toBe(token);

    const submission: LatencyProbeSubmission = {
      version: 1,
      challengeId: challenge.challengeId,
      measurements: [
        {
          region: "NA Central",
          server: "na.example.test:27015",
          requestedSamples: 5,
          successfulSamples: 5,
          medianMs: 21.2,
          p95Ms: 28.4,
          packetLossPercent: 0
        },
        {
          region: "EU Central",
          server: "eu.example.test:27015",
          requestedSamples: 5,
          successfulSamples: 4,
          medianMs: 94.1,
          p95Ms: 105.7,
          packetLossPercent: 20
        }
      ]
    };
    const status = await service.submit(token, signed(token, submission), submission);
    expect(status.measurements).toHaveLength(2);
    await expect(service.assertFresh([playerId], ["NA Central", "EU Central"]))
      .resolves.toBeUndefined();
    expect(await service.pingsForPlayers([playerId])).toEqual(new Map([[playerId, {
      "NA Central": 28.4,
      "EU Central": 125.7
    }]]));
    await expect(service.submit(token, signed(token, submission), submission))
      .rejects.toThrow(/already consumed/i);
  });

  it("rejects tampering, expired challenges, and stale measurements", async () => {
    const challenge = await service.issue(playerId, ["NA Central"]);
    const token = new URL(challenge.launcherUrl).searchParams.get("token")!;
    const submission: LatencyProbeSubmission = {
      version: 1,
      challengeId: challenge.challengeId,
      measurements: [{
        region: "NA Central",
        server: "na.example.test:27015",
        requestedSamples: 5,
        successfulSamples: 5,
        medianMs: 20,
        p95Ms: 25,
        packetLossPercent: 0
      }]
    };
    await expect(service.submit(token, "0".repeat(64), submission))
      .rejects.toThrow(/signature/i);
    const tampered = structuredClone(submission);
    tampered.measurements[0]!.server = "attacker.example.test:27015";
    await expect(service.submit(token, signed(token, tampered), tampered))
      .rejects.toThrow(/issued endpoints/i);

    await sql`
      update latency_probe_challenges
      set issued_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
      where id = ${challenge.challengeId}
    `;
    await expect(service.submit(token, signed(token, submission), submission))
      .rejects.toThrow(/expired/i);

    await sql`
      update player_latency_measurements
      set measured_at = now() - interval '2 hours', valid_until = now() - interval '1 hour'
      where player_id = ${playerId}
    `;
    await expect(service.assertFresh([playerId], ["NA Central"]))
      .rejects.toThrow(/fresh launcher route measurement/i);
  });

  it("supersedes pending challenges and rejects measurements from rotated endpoints", async () => {
    const superseded = await service.issue(playerId, ["NA Central"]);
    const current = await service.issue(playerId, ["NA Central"]);
    const supersededToken = new URL(superseded.launcherUrl).searchParams.get("token")!;
    const supersededSubmission: LatencyProbeSubmission = {
      version: 1,
      challengeId: superseded.challengeId,
      measurements: [{
        region: "NA Central",
        server: "na.example.test:27015",
        requestedSamples: 5,
        successfulSamples: 5,
        medianMs: 20,
        p95Ms: 25,
        packetLossPercent: 0
      }]
    };
    await expect(service.submit(
      supersededToken,
      signed(supersededToken, supersededSubmission),
      supersededSubmission
    )).rejects.toThrow(/already consumed/i);

    const currentToken = new URL(current.launcherUrl).searchParams.get("token")!;
    const currentSubmission = {
      ...supersededSubmission,
      challengeId: current.challengeId
    };
    await service.submit(currentToken, signed(currentToken, currentSubmission), currentSubmission);

    const rotated = new LatencyProbeService(sql, {
      publicUrl: "https://play.example.test",
      endpoints: { "NA Central": "na-replacement.example.test:27015" },
      challengeSeconds: 120,
      measurementSeconds: 900,
      samples: 5
    });
    expect((await rotated.status(playerId)).measurements).toEqual([]);
    await expect(rotated.assertFresh([playerId], ["NA Central"]))
      .rejects.toThrow(/fresh launcher route measurement/i);
    expect(await rotated.pingsForPlayers([playerId])).toEqual(new Map());
  });
});
