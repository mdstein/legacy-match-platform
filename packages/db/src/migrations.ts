import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Sql } from "./connection.js";
import { convertProfileXpTo1000 } from "./services/convert-profile-xp.js";

const defaultMigrationsDir = resolve(import.meta.dirname, "..", "migrations");
const migrationLockId = 2_483_101_947;

interface AppliedMigration {
  version: string;
  checksum: string | null;
}

interface Migration {
  version: string;
  checksum: string;
  content: string;
}

export interface MigrationResult {
  applied: string[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

export function migrationChecksum(content: string): string {
  return sha256(normalizeLineEndings(content));
}

export function migrationChecksumMatches(content: string, recordedChecksum: string): boolean {
  const normalized = normalizeLineEndings(content);
  return recordedChecksum === sha256(normalized)
    || recordedChecksum === sha256(normalized.replace(/\n/g, "\r\n"));
}

async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  return Promise.all(files.map(async (file) => {
    const content = await readFile(join(directory, file), "utf8");
    return {
      version: file.slice(0, -4),
      checksum: migrationChecksum(content),
      content
    };
  }));
}

export async function runMigrations(
  sql: Sql,
  directory = defaultMigrationsDir
): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);

  return sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(${migrationLockId})`;
    await transaction`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await transaction`
      ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum TEXT
    `;

    const rows = await transaction<AppliedMigration[]>`
      SELECT version, checksum
      FROM schema_migrations
      ORDER BY version
    `;
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));
    const newlyApplied: string[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        const recordedChecksum = applied.get(migration.version);
        if (recordedChecksum && !migrationChecksumMatches(migration.content, recordedChecksum)) {
          throw new Error(
            `Migration ${migration.version} changed after it was applied.`
          );
        }
        if (recordedChecksum !== migration.checksum) {
          await transaction`
            UPDATE schema_migrations
            SET checksum = ${migration.checksum}
            WHERE version = ${migration.version}
          `;
        }
        continue;
      }

      await transaction.unsafe(migration.content);
      if (migration.version === "033_profile_xp_1000") await convertProfileXpTo1000(transaction);
      await transaction`
        INSERT INTO schema_migrations (version, checksum)
        VALUES (${migration.version}, ${migration.checksum})
      `;
      newlyApplied.push(migration.version);
    }

    return { applied: newlyApplied };
  });
}
