import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    migrate: "../../packages/db/src/migrate.ts",
    seed: "../../packages/db/src/seed.ts",
    retention: "src/retention.ts",
    "trading-control": "src/trading-control.ts",
    "playtest-grant": "src/playtest-grant.ts"
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  noExternal: [/^@aftertick\//]
});
