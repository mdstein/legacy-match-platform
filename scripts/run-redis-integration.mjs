import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, [
  "node_modules/vitest/vitest.mjs",
  "run",
  "--exclude", "**/.artifacts/**",
  "apps/api/test/redis-session.integration.test.ts",
  "apps/api/test/redis-queue.integration.test.ts",
  "apps/api/test/redis-party.integration.test.ts",
  "apps/api/test/redis-ready-check.integration.test.ts",
  "--reporter=verbose"
], {
  cwd: root,
  env: {
    ...process.env,
    TEST_REDIS_URL: process.env.TEST_REDIS_URL
      ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0"
  },
  stdio: "inherit",
  windowsHide: true
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Redis integration tests stopped by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
