import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const root = resolve(workspace, ".artifacts", "retention-test", `backups-${process.pid}`);

async function backup(name, createdAt) {
  const directory = resolve(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify({
    version: 1,
    createdAt,
    files: []
  }));
}
async function run(args) {
  const child = spawn(process.execPath, [resolve(workspace, "scripts", "prune-local-backups.mjs"), ...args], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(output);
  return JSON.parse(output);
}

try {
  await backup("oldest", "2026-01-01T00:00:00.000Z");
  await backup("older", "2026-02-01T00:00:00.000Z");
  await backup("recent-a", "2026-08-20T00:00:00.000Z");
  await backup("recent-b", "2026-08-21T00:00:00.000Z");
  await mkdir(resolve(root, "incomplete"), { recursive: true });

  const common = ["--root", root, "--retention-days", "30", "--keep-minimum", "3", "--now", "2026-08-29T12:00:00.000Z"];
  const preview = await run(common);
  if (preview.deleted.length !== 0 || preview.candidates.join(",") !== "oldest") {
    throw new Error(`Unexpected dry-run: ${JSON.stringify(preview)}`);
  }
  const applied = await run([...common, "--apply"]);
  if (applied.deleted.join(",") !== "oldest" || !applied.skipped.some((entry) => entry.name === "incomplete")) {
    throw new Error(`Unexpected apply result: ${JSON.stringify(applied)}`);
  }
  const repeated = await run([...common, "--apply"]);
  if (repeated.deleted.length !== 0) throw new Error(`Pruning was not idempotent: ${JSON.stringify(repeated)}`);
  console.log("Backup retention dry-run, minimum-copy protection, manifest guard, apply, and idempotency passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
