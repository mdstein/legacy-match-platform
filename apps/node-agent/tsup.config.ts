import { defineConfig } from "tsup";
import release from "../../packages/contracts/src/release.json" with { type: "json" };

const version = process.env.B2G_NODE_BUILD_VERSION ?? release.nodeVersion;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
  throw new Error("B2G_NODE_BUILD_VERSION must be a semantic release identifier.");
}

export default defineConfig({
  entry: {
    main: "src/main.ts"
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  define: { __B2G_NODE_VERSION__: JSON.stringify(version) },
  noExternal: ["zod", /^@aftertick\//]
});
