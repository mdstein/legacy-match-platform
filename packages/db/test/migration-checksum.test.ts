import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrationChecksum, migrationChecksumMatches } from "../src/migrations.js";

describe("migration checksums", () => {
  const lf = "create table example (id uuid);\ninsert into example values ('00000000-0000-0000-0000-000000000000');\n";
  const crlf = lf.replace(/\n/g, "\r\n");

  it("uses one canonical checksum across operating-system line endings", () => {
    expect(migrationChecksum(crlf)).toBe(migrationChecksum(lf));
  });

  it("accepts legacy raw CRLF checksums for an otherwise identical migration", () => {
    const legacyCrLfChecksum = createHash("sha256").update(crlf).digest("hex");
    expect(migrationChecksumMatches(lf, legacyCrLfChecksum)).toBe(true);
  });

  it("still rejects semantic migration changes", () => {
    expect(migrationChecksumMatches(`${lf}drop table example;\n`, migrationChecksum(lf))).toBe(false);
  });
});
