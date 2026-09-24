import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this through npm.");
const environment = {
  ...process.env,
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: "8787",
  AFTERTICK_PUBLIC_URL: "http://127.0.0.1:5173",
  CORS_ORIGINS: "http://127.0.0.1:5173",
  DATABASE_URL: process.env.DATABASE_URL
    ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick",
  REDIS_URL: process.env.REDIS_URL
    ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0",
  SESSION_SECRET: process.env.SESSION_SECRET
    ?? "aftertick-real-steam-smoke-session-secret",
  MANIFEST_SIGNING_SECRET: process.env.MANIFEST_SIGNING_SECRET
    ?? "aftertick-real-steam-smoke-manifest-secret",
  API_RATE_LIMIT: "2000",
  AUTH_RATE_LIMIT: "2000"
};

for (const key of [
  "DEV_PLAYER_ID",
  "AFTERTICK_E2E_PLAYER_ID",
  "AFTERTICK_E2E_STEAM_ID",
  "AFTERTICK_E2E_DISPLAY_NAME",
  "AFTERTICK_E2E_IDENTITY_HEADER_SECRET"
]) {
  delete environment[key];
}

const child = spawn(process.execPath, [npmCli, "run", "dev"], {
  cwd: root,
  env: environment,
  stdio: "inherit",
  windowsHide: true
});

child.once("error", (error) => {
  console.error("Could not start the Steam OpenID smoke services:", error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exit(code ?? 1);
});
