import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./ui-tests",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 3,
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1360, height: 820 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: "../../.artifacts/tauri-polish-20260908/ui-results.json" },
    ],
  ],
  outputDir: "../../.artifacts/tauri-polish-20260908/test-results",
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
