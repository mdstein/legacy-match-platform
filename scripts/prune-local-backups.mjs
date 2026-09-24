import { access, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const workspace = resolve(import.meta.dirname, "..");
const allowedRoot = resolve(workspace, ".artifacts");
const root = resolve(option("--root", resolve(allowedRoot, "backups")));
const retentionDays = Number(option("--retention-days", process.env.AFTERTICK_BACKUP_RETENTION_DAYS ?? "30"));
const keepMinimum = Number(option("--keep-minimum", process.env.AFTERTICK_BACKUP_KEEP_MINIMUM ?? "3"));
const now = new Date(option("--now", new Date().toISOString()));
const apply = process.argv.includes("--apply");

const fromAllowed = relative(allowedRoot, root);
if (fromAllowed === "" || fromAllowed.startsWith("..") || isAbsolute(fromAllowed)) {
  throw new Error(`Backup pruning root must be a child directory of ${allowedRoot}.`);
}
if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3_650) {
  throw new Error("Backup retention must be between 7 and 3650 whole days.");
}
if (!Number.isInteger(keepMinimum) || keepMinimum < 1 || keepMinimum > 100) {
  throw new Error("Backup minimum must be between 1 and 100.");
}
if (Number.isNaN(now.getTime())) throw new Error("The pruning clock is invalid.");

try {
  await access(root);
} catch {
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", root, deleted: [], candidates: [], skipped: [] }, null, 2));
  process.exit(0);
}

const entries = await readdir(root, { withFileTypes: true });
const valid = [];
const skipped = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const directory = resolve(root, entry.name);
  const childRelative = relative(root, directory);
  if (childRelative.startsWith("..") || isAbsolute(childRelative)) {
    skipped.push({ name: entry.name, reason: "outside-root" });
    continue;
  }
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
    const createdAt = new Date(manifest.createdAt);
    if (manifest.version !== 1 || Number.isNaN(createdAt.getTime()) || !Array.isArray(manifest.files)) {
      throw new Error("invalid manifest");
    }
    valid.push({ name: entry.name, directory, createdAt });
  } catch {
    skipped.push({ name: entry.name, reason: "missing-or-invalid-manifest" });
  }
}

valid.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
const protectedNames = new Set(valid.slice(0, keepMinimum).map((entry) => entry.name));
const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
const candidates = valid.filter((entry) => (
  !protectedNames.has(entry.name) && entry.createdAt <= cutoff
));
const deleted = [];
if (apply) {
  for (const candidate of candidates) {
    const childRelative = relative(root, candidate.directory);
    if (childRelative === "" || childRelative.startsWith("..") || isAbsolute(childRelative)) {
      throw new Error(`Refusing to delete an unresolved backup path: ${candidate.directory}`);
    }
    await rm(candidate.directory, { recursive: true, force: false });
    deleted.push(candidate.name);
  }
}

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  root,
  retentionDays,
  keepMinimum,
  cutoff: cutoff.toISOString(),
  protected: [...protectedNames],
  candidates: candidates.map((entry) => entry.name),
  deleted,
  skipped
}, null, 2));
