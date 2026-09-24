import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const port = 8791;
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick";
const redisUrl = process.env.TEST_REDIS_URL
  ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0";

function launch(withIdentity) {
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    // The listener remains local HTTP, while launcher device authorization must
    // exercise the same credential-free HTTPS public-origin contract as production.
    AFTERTICK_PUBLIC_URL: "https://play.example.test",
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SESSION_SECRET: "aftertick-built-api-integration-session-secret",
    API_RATE_LIMIT: "1000",
    AUTH_RATE_LIMIT: "1000"
  };
  if (withIdentity) {
    environment.AFTERTICK_E2E_PLAYER_ID = "api-integration-player";
    environment.AFTERTICK_E2E_STEAM_ID = "api-integration-steam";
    environment.AFTERTICK_E2E_DISPLAY_NAME = "API Integration Player";
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
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.aftertickOutput = () => output;
  return child;
}

async function waitUntilReady(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited before readiness:\n${child.aftertickOutput()}`);
    }
    try {
      const response = await fetch(`${origin}/ready`);
      if (response.ok) {
        const body = await response.json();
        if (body.checks?.postgres?.status !== "ok" || body.checks?.redis?.status !== "ok") {
          throw new Error(`Unexpected readiness response: ${JSON.stringify(body)}`);
        }
        return;
      }
    } catch {
      // Startup can race the first probe.
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for API readiness:\n${child.aftertickOutput()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

let api;
try {
  api = launch(true);
  await waitUntilReady(api);

  const csrfResponse = await fetch(`${origin}/api/auth/csrf`);
  if (!csrfResponse.ok) throw new Error("CSRF token request failed.");
  const cookie = csrfResponse.headers.get("set-cookie");
  const { token } = await csrfResponse.json();
  if (!cookie || !token) throw new Error("Session cookie or CSRF token was not issued.");

  const mutation = await fetch(`${origin}/api/queue/leave`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": token }
  });
  if (!mutation.ok) throw new Error(`Authenticated mutation failed with ${mutation.status}.`);

  await stop(api);
  api = launch(false);
  await waitUntilReady(api);

  const restored = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  const auth = await restored.json();
  if (!restored.ok || auth.playerId !== "api-integration-player") {
    throw new Error(`Session did not survive API restart: ${JSON.stringify(auth)}`);
  }

  console.log("Built API readiness, CSRF, Redis session persistence, and restart recovery passed.");
} finally {
  if (api) await stop(api);
}
