import type { Sql } from "@aftertick/db";
import type postgres from "postgres";
import type { DemoObjectStore } from "./demo-ingestion-service.js";

const POLICY_VERSION = "demo-retention-v1";
const CLAIM_RECOVERY_MS = 15 * 60 * 1_000;

type DeletableStatus = "analyzed" | "invalid";

interface RetentionCandidateRow {
  match_id: string;
  object_key: string;
  sha256: string;
  size_bytes: bigint | number;
  status: DeletableStatus | "deleting";
  retention_previous_status: DeletableStatus | null;
  uploaded_at: Date;
}
export interface DemoRetentionCandidate {
  matchId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  uploadedAt: string;
  resumedInterruptedClaim: boolean;
}

export interface DemoRetentionResult {
  policyVersion: string;
  mode: "dry-run" | "apply";
  retentionDays: number;
  cutoff: string;
  candidates: DemoRetentionCandidate[];
  deleted: number;
  failed: number;
  failures: Array<{ matchId: string; message: string }>;
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function view(row: RetentionCandidateRow): DemoRetentionCandidate {
  return {
    matchId: row.match_id,
    objectKey: row.object_key,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    uploadedAt: row.uploaded_at.toISOString(),
    resumedInterruptedClaim: row.status === "deleting"
  };
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 1_000);
}

export class DemoRetentionService {
  constructor(
    private readonly sql: Sql,
    private readonly objects: Pick<DemoObjectStore, "delete">
  ) {}

  async run(input: {
    apply: boolean;
    retentionDays: number;
    limit?: number;
    now?: Date;
  }): Promise<DemoRetentionResult> {
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 30 || input.retentionDays > 3_650) {
      throw new Error("Demo retention must be between 30 and 3650 whole days.");
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Retention batch size must be between 1 and 1000.");
    }
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - input.retentionDays * 86_400_000);
    const claimRecoveryCutoff = new Date(now.getTime() - CLAIM_RECOVERY_MS);
    const rows = await this.candidates(cutoff, claimRecoveryCutoff, limit);
    const result: DemoRetentionResult = {
      policyVersion: POLICY_VERSION,
      mode: input.apply ? "apply" : "dry-run",
      retentionDays: input.retentionDays,
      cutoff: cutoff.toISOString(),
      candidates: rows.map(view),
      deleted: 0,
      failed: 0,
      failures: []
    };
    if (!input.apply) return result;

    for (const row of rows) {
      const claimed = await this.claim(row.match_id, cutoff, claimRecoveryCutoff, now);
      if (!claimed) continue;
      try {
        await this.objects.delete(claimed.object_key);
        await this.complete(claimed, now, input.retentionDays);
        result.deleted += 1;
      } catch (error) {
        const message = errorMessage(error);
        await this.fail(claimed.match_id, message);
        result.failed += 1;
        result.failures.push({ matchId: claimed.match_id, message });
      }
    }
    return result;
  }

  private async candidates(
    cutoff: Date,
    claimRecoveryCutoff: Date,
    limit: number
  ): Promise<RetentionCandidateRow[]> {
    return this.sql<RetentionCandidateRow[]>`
      select artifact.match_id, artifact.object_key, artifact.sha256,
             artifact.size_bytes, artifact.status,
             artifact.retention_previous_status, artifact.uploaded_at
      from match_demo_artifacts artifact
      join matches match on match.id = artifact.match_id
      where artifact.uploaded_at <= ${cutoff}
        and (
          artifact.status in ('analyzed', 'invalid')
          or (
            artifact.status = 'deleting'
            and artifact.deletion_started_at <= ${claimRecoveryCutoff}
          )
        )
        and match.status in ('completed', 'cancelled')
        and not exists (
          select 1 from reports report
          where report.match_id = artifact.match_id
            and report.status in ('pending', 'under_review')
        )
        and not exists (
          select 1 from sanctions sanction
          join sanction_appeals appeal on appeal.sanction_id = sanction.id
          where sanction.match_id = artifact.match_id
            and appeal.status = 'pending'
        )
      order by artifact.uploaded_at, artifact.match_id
      limit ${limit}
    `;
  }

  private async claim(
    matchId: string,
    cutoff: Date,
    claimRecoveryCutoff: Date,
    now: Date
  ): Promise<RetentionCandidateRow | null> {
    return this.sql.begin(async (transaction) => {
      const [row] = await transaction<RetentionCandidateRow[]>`
        select artifact.match_id, artifact.object_key, artifact.sha256,
               artifact.size_bytes, artifact.status,
               artifact.retention_previous_status, artifact.uploaded_at
        from match_demo_artifacts artifact
        join matches match on match.id = artifact.match_id
        where artifact.match_id = ${matchId}
          and artifact.uploaded_at <= ${cutoff}
          and (
            artifact.status in ('analyzed', 'invalid')
            or (
              artifact.status = 'deleting'
              and artifact.deletion_started_at <= ${claimRecoveryCutoff}
            )
          )
          and match.status in ('completed', 'cancelled')
          and not exists (
            select 1 from reports report
            where report.match_id = artifact.match_id
              and report.status in ('pending', 'under_review')
          )
          and not exists (
            select 1 from sanctions sanction
            join sanction_appeals appeal on appeal.sanction_id = sanction.id
            where sanction.match_id = artifact.match_id
              and appeal.status = 'pending'
          )
        for update of artifact skip locked
      `;
      if (!row) return null;
      const previous = row.status === "deleting"
        ? row.retention_previous_status
        : row.status;
      if (!previous) return null;
      await transaction`
        update match_demo_artifacts
        set status = 'deleting', retention_previous_status = ${previous},
            deletion_started_at = ${now}, deletion_error = null
        where match_id = ${matchId}
      `;
      return { ...row, status: "deleting", retention_previous_status: previous };
    });
  }

  private async complete(
    row: RetentionCandidateRow,
    now: Date,
    retentionDays: number
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const updated = await transaction`
        update match_demo_artifacts
        set status = 'deleted', deleted_at = ${now},
            retention_policy_version = ${POLICY_VERSION}, deletion_error = null
        where match_id = ${row.match_id} and status = 'deleting'
        returning match_id
      `;
      if (updated.length === 0) throw new Error("The demo retention claim was lost before completion.");
      await transaction`
        update matches set demo_url = null where id = ${row.match_id}
      `;
      await transaction`
        insert into audit_log (actor_id, action, target_type, target_id, detail)
        values (
          null, 'retention.demo.deleted', 'match', ${row.match_id},
          ${transaction.json(asJson({
            policyVersion: POLICY_VERSION,
            retentionDays,
            objectKey: row.object_key,
            sha256: row.sha256,
            sizeBytes: Number(row.size_bytes),
            uploadedAt: row.uploaded_at.toISOString(),
            deletedAt: now.toISOString()
          }))}
        )
      `;
    });
  }

  private async fail(matchId: string, message: string): Promise<void> {
    await this.sql`
      update match_demo_artifacts
      set status = retention_previous_status,
          retention_previous_status = null,
          deletion_started_at = null,
          deletion_error = ${message}
      where match_id = ${matchId} and status = 'deleting'
    `;
  }
}
