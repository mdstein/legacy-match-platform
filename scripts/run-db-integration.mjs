import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick";

const child = spawn(process.execPath, [
  "node_modules/vitest/vitest.mjs",
  "run",
  "--exclude", "**/.artifacts/**",
  "packages/db/test/migrations.integration.test.ts",
  "packages/db/test/xp-conversion.integration.test.ts",
  "packages/db/test/settle-match.integration.test.ts",
  "apps/api/test/launcher-device-service.integration.test.ts",
  "apps/api/test/launcher-player-profiles.integration.test.ts",
  "apps/api/test/friends-service.integration.test.ts",
  "apps/api/test/inventory-service.integration.test.ts",
  "apps/api/test/stattrak-ingestion.integration.test.ts",
  "apps/api/test/service-medal.integration.test.ts",
  "apps/api/test/trading-service.integration.test.ts",
  "apps/api/test/node-control.integration.test.ts",
  "apps/api/test/operations.integration.test.ts",
  "apps/api/test/retention.integration.test.ts",
  "apps/api/test/match-recovery.integration.test.ts",
  "apps/api/test/latency-probe.integration.test.ts",
  "--reporter=verbose"
], {
  cwd: root,
  env: { ...process.env, TEST_DATABASE_URL: testUrl },
  stdio: "inherit",
  windowsHide: true
});

child.once("exit", (code) => process.exit(code ?? 1));
