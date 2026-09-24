import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createConnection, runMigrations, runSeeds, type Sql } from "@aftertick/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DemoIngestionService,
  type DemoObjectStore
} from "../src/demo-ingestion-service.js";
import type { MatchIngestionService } from "../src/match-ingestion-service.js";
import { DemoRetentionService } from "../src/retention-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

class MemoryObjects implements DemoObjectStore {
  readonly values = new Map<string, Buffer>();
  failDeletes = false;

  async put(input: { key: string; body: Readable }): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    this.values.set(input.key, Buffer.concat(chunks));
  }

  async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("simulated object-store outage");
    this.values.delete(key);
  }

  uri(key: string): string {
    return `s3://retention-test/${key}`;
  }

  async get(key: string): Promise<{ body: Readable; contentLength: number; contentType: string }> {
    const value = this.values.get(key);
    if (!value) throw new Error("missing object");
    return {
      body: Readable.from(value),
      contentLength: value.length,
      contentType: "application/octet-stream"
    };
  }
}

integration("demo retention", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const player1 = "00000000-0000-4000-8000-000000000001";
  const player2 = "00000000-0000-4000-8000-000000000002";
  const now = new Date("2026-08-29T12:00:00.000Z");
  let admin: Sql;
  let sql: Sql;
  let objects: MemoryObjects;

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  async function createArtifact(input: {
    status?: "completed" | "cancelled" | "disputed";
    held?: boolean;
  } = {}): Promise<{ matchId: string; objectKey: string }> {
    const matchId = randomUUID();
    const nodeId = randomUUID();
    const instanceId = randomUUID();
    const leaseId = randomUUID();
    const objectKey = `matches/${matchId}/gotv.dem`;
    await sql`
      insert into matches (
        id, map, region, status, ended_at, demo_url, demo_checksum, created_at
      ) values (
        ${matchId}, 'Inferno', 'NA Central', ${input.status ?? "completed"}::match_status,
        ${new Date("2026-04-01T00:00:00.000Z")}, ${`s3://retention-test/${objectKey}`},
        ${"a".repeat(64)}, ${new Date("2026-04-01T00:00:00.000Z")}
      )
    `;
    await sql`
      insert into game_nodes (id, name, region, token_sha256)
      values (${nodeId}, ${`retention-${nodeId}`}, 'NA Central', ${nodeId.replaceAll("-", "").padEnd(64, "0")})
    `;
    await sql`
      insert into server_instances (
        id, node_id, instance_key, state, address, game_port
      ) values (${instanceId}, ${nodeId}, 'server-1', 'offline', '127.0.0.1:27015', 27015)
    `;
    await sql`
      insert into server_leases (
        id, match_id, server_instance_id, fencing_token, status,
        manifest, manifest_signature, leased_at, expires_at, released_at
      ) values (
        ${leaseId}, ${matchId}, ${instanceId}, nextval('server_lease_fencing_seq'), 'released',
        '{}', 'retention-test-signature',
        ${new Date("2026-04-01T00:00:00.000Z")}, ${new Date("2026-04-01T03:00:00.000Z")},
        ${new Date("2026-04-01T02:00:00.000Z")}
      )
    `;
    await sql`
      insert into match_demo_artifacts (
        match_id, lease_id, object_key, sha256, size_bytes,
        status, analyzer_version, analysis_sha256, analysis,
        uploaded_at, analyzed_at
      ) values (
        ${matchId}, ${leaseId}, ${objectKey}, ${"a".repeat(64)}, 12,
        'analyzed', 'retention-test', ${"b".repeat(64)}, '{}',
        ${new Date("2026-04-01T02:00:00.000Z")}, ${new Date("2026-04-01T02:05:00.000Z")}
      )
    `;
    objects.values.set(objectKey, Buffer.from("demo-evidence"));
    if (input.held) {
      await sql`
        insert into rosters (match_id, player_id, team, slot, rating_at_match)
        values (${matchId}, ${player1}, 'alpha', 1, 1000), (${matchId}, ${player2}, 'bravo', 1, 1000)
      `;
      await sql`
        insert into reports (reporter_id, reported_id, match_id, category, status)
        values (${player1}, ${player2}, ${matchId}, 'griefing', 'under_review')
      `;
    }
    return { matchId, objectKey };
  }

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
    await runMigrations(sql);
    await runSeeds(sql, { includeTestPlayers: true });
    objects = new MemoryObjects();
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it("dry-runs without mutation, applies exactly once, and preserves checksum/audit metadata", async () => {
    const artifact = await createArtifact();
    const service = new DemoRetentionService(sql, objects);

    const preview = await service.run({ apply: false, retentionDays: 90, now });
    expect(preview.candidates.map((candidate) => candidate.matchId)).toContain(artifact.matchId);
    expect(objects.values.has(artifact.objectKey)).toBe(true);

    const applied = await service.run({ apply: true, retentionDays: 90, now });
    expect(applied).toMatchObject({ deleted: 1, failed: 0 });
    expect(objects.values.has(artifact.objectKey)).toBe(false);

    const [row] = await sql<{
      status: string;
      sha256: string;
      deleted_at: Date | null;
      retention_policy_version: string | null;
      demo_url: string | null;
    }[]>`
      select artifact.status, artifact.sha256, artifact.deleted_at,
             artifact.retention_policy_version, match.demo_url
      from match_demo_artifacts artifact
      join matches match on match.id = artifact.match_id
      where artifact.match_id = ${artifact.matchId}
    `;
    expect(row).toMatchObject({
      status: "deleted",
      sha256: "a".repeat(64),
      retention_policy_version: "demo-retention-v1",
      demo_url: null
    });
    expect(row?.deleted_at).toEqual(now);
    const [audit] = await sql<{ action: string; detail: { sha256: string } }[]>`
      select action, detail from audit_log
      where target_id = ${artifact.matchId} and action = 'retention.demo.deleted'
    `;
    expect(audit).toMatchObject({ action: "retention.demo.deleted", detail: { sha256: "a".repeat(64) } });
    expect((await service.run({ apply: true, retentionDays: 90, now })).deleted).toBe(0);

    const downloads = new DemoIngestionService(
      sql,
      {} as MatchIngestionService,
      objects
    );
    await expect(downloads.openDemo(artifact.matchId)).rejects.toMatchObject({ status: 410 });
  });

  it("keeps disputed and active-moderation evidence under hold", async () => {
    const disputed = await createArtifact({ status: "disputed" });
    const moderated = await createArtifact({ held: true });
    const preview = await new DemoRetentionService(sql, objects).run({
      apply: false,
      retentionDays: 90,
      now
    });
    expect(preview.candidates.map((candidate) => candidate.matchId)).not.toContain(disputed.matchId);
    expect(preview.candidates.map((candidate) => candidate.matchId)).not.toContain(moderated.matchId);
    expect(objects.values.has(disputed.objectKey)).toBe(true);
    expect(objects.values.has(moderated.objectKey)).toBe(true);
  });

  it("restores a claim when object deletion fails", async () => {
    const artifact = await createArtifact();
    objects.failDeletes = true;
    const result = await new DemoRetentionService(sql, objects).run({
      apply: true,
      retentionDays: 90,
      now
    });
    objects.failDeletes = false;
    expect(result).toMatchObject({ deleted: 0, failed: 1 });
    const [row] = await sql<{ status: string; deletion_error: string | null }[]>`
      select status, deletion_error from match_demo_artifacts where match_id = ${artifact.matchId}
    `;
    expect(row).toMatchObject({ status: "analyzed", deletion_error: "simulated object-store outage" });
    expect(objects.values.has(artifact.objectKey)).toBe(true);
  });
});
