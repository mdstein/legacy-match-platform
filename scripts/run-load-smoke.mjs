import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const port = 8792;
const origin = `http://127.0.0.1:${port}`;
const k6 = process.env.K6_BIN
  ?? (process.platform === "win32" ? "C:\\Program Files\\k6\\k6.exe" : "k6");
const artifactDirectory = resolve(root, ".artifacts/k6");

await mkdir(artifactDirectory, { recursive: true });

const api = spawn(process.execPath, ["apps/api/dist/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    AFTERTICK_PUBLIC_URL: origin,
    DATABASE_URL: process.env.TEST_DATABASE_URL
      ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick",
    REDIS_URL: process.env.TEST_REDIS_URL
      ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0",
    SESSION_SECRET: "aftertick-load-smoke-session-secret",
    AFTERTICK_E2E_PLAYER_ID: "load-smoke-player",
    AFTERTICK_E2E_STEAM_ID: "load-smoke-steam",
    AFTERTICK_E2E_DISPLAY_NAME: "Load Smoke Player",
    API_RATE_LIMIT: "100000",
    AUTH_RATE_LIMIT: "100000"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let apiOutput = "";
api.stdout.on("data", (chunk) => { apiOutput += chunk.toString(); });
api.stderr.on("data", (chunk) => { apiOutput += chunk.toString(); });

async function waitUntilReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`API exited before load test:\n${apiOutput}`);
    try {
      if ((await fetch(`${origin}/ready`)).ok) return;
    } catch {
      // API is still binding its listener.
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for load-test API:\n${apiOutput}`);
}

try {
  await waitUntilReady();
  const load = spawn(k6, [
    "run",
    "--summary-export",
    resolve(artifactDirectory, "summary.json"),
    resolve(root, "tests/load/api-smoke.js")
  ], {
    cwd: root,
    env: { ...process.env, AFTERTICK_BASE_URL: origin },
    stdio: "inherit",
    windowsHide: true
  });
  const [code] = await once(load, "exit");
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  if (api.exitCode === null) {
    api.kill("SIGTERM");
    await Promise.race([once(api, "exit"), delay(5_000)]);
  }
}
