import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { createClient } from "redis";

const root = resolve(import.meta.dirname, "..");
const port = 8794;
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick";
const redisUrl = process.env.TEST_REDIS_URL
  ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0";
const windowsDocker = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const docker = process.env.AFTERTICK_DOCKER_BIN
  ?? (process.platform === "win32" && existsSync(windowsDocker) ? windowsDocker : "docker");

function launchApi(withIdentity) {
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    AFTERTICK_PUBLIC_URL: origin,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SESSION_SECRET: "aftertick-resilience-drill-session-secret",
    API_RATE_LIMIT: "2000",
    AUTH_RATE_LIMIT: "2000"
  };
  if (withIdentity) {
    environment.AFTERTICK_E2E_PLAYER_ID = "resilience-drill-player";
    environment.AFTERTICK_E2E_STEAM_ID = "resilience-drill-steam";
    environment.AFTERTICK_E2E_DISPLAY_NAME = "Resilience Drill Player";
  } else {
    delete environment.AFTERTICK_E2E_PLAYER_ID;
    delete environment.AFTERTICK_E2E_STEAM_ID;
    delete environment.AFTERTICK_E2E_DISPLAY_NAME;
  }

  const child = spawn(process.execPath, ["apps/api/dist/server.js"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-65_536); });
  child.stderr.on("data", (chunk) => { output = (output + chunk.toString()).slice(-65_536); });
  child.aftertickOutput = () => output;
  return child;
}

async function stopApi(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

async function compose(...args) {
  const child = spawn(docker, ["compose", "-f", "compose.yml", ...args], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed (${signal ?? code}):\n${output}`);
  }
}

async function waitFor(label, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`${label} timed out.${lastError ? ` ${lastError.message}` : ""}`);
}

async function readReadiness() {
  const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(3_000) });
  return { status: response.status, body: await response.json() };
}

async function waitForReady(api) {
  return waitFor("API readiness", async () => {
    if (api.exitCode !== null) throw new Error(api.aftertickOutput());
    const readiness = await readReadiness();
    return readiness.status === 200 ? readiness : null;
  });
}

async function waitForDependencyFailure(api, dependency) {
  return waitFor(`${dependency} readiness failure`, async () => {
    if (api.exitCode !== null) throw new Error(api.aftertickOutput());
    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!health.ok) throw new Error("Liveness failed during a dependency outage.");
    const readiness = await readReadiness();
    return readiness.status === 503
      && readiness.body.checks?.[dependency]?.status === "error"
      ? readiness
      : null;
  });
}

async function authenticatedPlayer(cookie) {
  const response = await fetch(`${origin}/api/auth/me`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(3_000)
  });
  const body = await response.json();
  if (!response.ok || body.playerId !== "resilience-drill-player") {
    throw new Error(`Session recovery failed: ${JSON.stringify(body)}`);
  }
}

const report = {
  startedAt: new Date().toISOString(),
  scenarios: [],
  verified: []
};
let api;
let cookie;
let redisSentinel;

try {
  await compose("up", "-d", "--wait", "postgres", "redis");

  let sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  const [migrationState] = await sql`
    select count(*)::int as count, max(applied_at) as latest
    from schema_migrations
  `;
  await sql.end({ timeout: 5 });

  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();
  redisSentinel = `aftertick:resilience:${randomUUID()}`;
  await redis.set(redisSentinel, report.startedAt);

  api = launchApi(true);
  await waitForReady(api);
  const csrf = await fetch(`${origin}/api/auth/csrf`, { signal: AbortSignal.timeout(3_000) });
  cookie = csrf.headers.get("set-cookie");
  const csrfBody = await csrf.json();
  if (!csrf.ok || !cookie || !csrfBody.token) throw new Error("Could not establish the drill session.");
  await redis.sendCommand(["SAVE"]);
  await redis.quit();

  const apiLossStarted = performance.now();
  await stopApi(api);
  await waitFor("API process loss", async () => {
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
      return false;
    } catch {
      return true;
    }
  }, 5_000);
  api = launchApi(false);
  await waitForReady(api);
  await authenticatedPlayer(cookie);
  report.scenarios.push({ name: "api_process_loss", recoveredMs: Math.round(performance.now() - apiLossStarted) });
  report.verified.push("Redis session survived an API process loss and clean restart");

  const redisLossStarted = performance.now();
  await compose("stop", "redis");
  await waitForDependencyFailure(api, "redis");
  await compose("up", "-d", "--wait", "redis");
  await waitForReady(api);
  await authenticatedPlayer(cookie);
  const recoveredRedis = createClient({ url: redisUrl });
  recoveredRedis.on("error", () => undefined);
  await recoveredRedis.connect();
  if (await recoveredRedis.get(redisSentinel) !== report.startedAt) {
    throw new Error("Redis AOF state did not survive the outage.");
  }
  await recoveredRedis.del(redisSentinel);
  await recoveredRedis.quit();
  report.scenarios.push({ name: "redis_process_loss", recoveredMs: Math.round(performance.now() - redisLossStarted) });
  report.verified.push("API stayed live and unready while Redis was down");
  report.verified.push("Redis AOF queue/session state recovered without an API restart");

  const postgresLossStarted = performance.now();
  await compose("stop", "postgres");
  await waitForDependencyFailure(api, "postgres");
  await compose("up", "-d", "--wait", "postgres");
  await waitForReady(api);
  sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  const [recoveredMigrationState] = await sql`
    select count(*)::int as count, max(applied_at) as latest
    from schema_migrations
  `;
  await sql.end({ timeout: 5 });
  if (
    recoveredMigrationState.count !== migrationState.count
    || String(recoveredMigrationState.latest) !== String(migrationState.latest)
  ) {
    throw new Error("PostgreSQL durable migration state changed across the outage.");
  }
  report.scenarios.push({
    name: "postgres_process_loss",
    recoveredMs: Math.round(performance.now() - postgresLossStarted)
  });
  report.verified.push("API stayed live and unready while PostgreSQL was down");
  report.verified.push("PostgreSQL durable state recovered without an API restart");

  report.completedAt = new Date().toISOString();
  const artifactDirectory = resolve(root, ".artifacts", "resilience");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    resolve(artifactDirectory, "latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stopApi(api);
  await compose("up", "-d", "--wait", "postgres", "redis").catch((error) => {
    console.error("Could not restore durable services after the drill:", error.message);
    process.exitCode = 1;
  });
}
