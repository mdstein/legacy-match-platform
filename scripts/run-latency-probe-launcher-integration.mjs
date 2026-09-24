import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick";

function run(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with status ${code ?? "unknown"}.`));
    });
  });
}

await run("cargo", [
  "build",
  "--locked",
  "--manifest-path",
  "apps/launcher/Cargo.toml"
]);
await run("cargo", [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  "apps/launcher/Cargo.toml"
]);
await run(process.execPath, [
  "node_modules/vitest/vitest.mjs",
  "run",
  "--exclude", "**/.artifacts/**",
  "apps/api/test/latency-probe-launcher.integration.test.ts",
  "--reporter=verbose"
], {
  ...process.env,
  TEST_DATABASE_URL: testUrl,
  AFTERTICK_RUN_NATIVE_LATENCY_INTEGRATION: "1"
});
