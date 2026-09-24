import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createConnection } from "@aftertick/db";
import { NodeControlService } from "../apps/api/src/node-control-service.js";

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? "") : (fallback ?? "");
}

async function main(): Promise<void> {
const workspace = resolve(import.meta.dirname, "..");
const outputRoot = resolve(workspace, ".artifacts", "nodes");
const output = resolve(argument("output", resolve(outputRoot, "local.env")));
const outputRelative = relative(outputRoot, output);
if (isAbsolute(outputRelative) || outputRelative.startsWith("..")) {
  throw new Error(`Node credentials may only be written below ${outputRoot}`);
}

const name = argument("name", "local-windows-01");
const region = argument("region", "NA Central");
const apiUrl = argument("api-url", "http://127.0.0.1:8787");
const production = process.argv.includes("--production");
const databaseUrl = process.env["DATABASE_URL"]
  ?? (production ? "" : "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick");
const signingSecret = process.env["MANIFEST_SIGNING_SECRET"]
  ?? (production ? "" : "aftertick-development-manifest-signing-secret-only");
if (!databaseUrl || signingSecret.length < 32) {
  throw new Error("Production registration requires DATABASE_URL and MANIFEST_SIGNING_SECRET.");
}
const serverRoot = resolve(argument("server-root", resolve(workspace, ".tools", "csgo-server")));
const launcherScript = resolve(argument(
  "launcher-script",
  resolve(workspace, "scripts", "start-srcds-hidden.ps1")
));
const instanceKey = argument("instance-key", "csgo-01");
const serverAddress = argument("server-address", "127.0.0.1:27115");
const srcdsHost = argument("srcds-host", "127.0.0.1");
const gamePort = Number(argument("game-port", "27115"));
const gotvPort = Number(argument("gotv-port", "27120"));
const latencyProbePort = Number(argument("latency-probe-port", "27125"));
const lanMode = argument("lan", "1");
const publicEndpoint = argument("public-endpoint", "") || undefined;
const gsltToken = argument("gslt", process.env["AFTERTICK_SRCDS_GSLT"] ?? "");
for (const [label, port] of [
  ["game-port", gamePort],
  ["gotv-port", gotvPort],
  ["latency-probe-port", latencyProbePort]
] as const) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid --${label}.`);
}
if (!["0", "1"].includes(lanMode)) throw new Error("--lan must be 0 or 1.");
if (production) {
  if (new URL(apiUrl).protocol !== "https:") throw new Error("Production API URL must use HTTPS.");
  if (lanMode !== "0" || srcdsHost !== "0.0.0.0") {
    throw new Error("Production registration requires --lan 0 and --srcds-host 0.0.0.0.");
  }
  if (/^(127\.|localhost|0\.0\.0\.0)/i.test(serverAddress)) {
    throw new Error("Production --server-address must be externally routable.");
  }
  if (!/^[a-fA-F0-9]{32}$/.test(gsltToken)) {
    throw new Error("Production registration requires AFTERTICK_SRCDS_GSLT for standalone AppID 4465480.");
  }
}
const rconPassword = production ? randomBytes(32).toString("base64url") : "aftertick-local-rcon-test";
const idlePassword = production ? randomBytes(32).toString("base64url") : "aftertick-local-server";

const sql = createConnection(databaseUrl);
try {
  const service = new NodeControlService(sql, signingSecret);
  const credentials = await service.registerNode({ name, region, publicEndpoint });
  await mkdir(resolve(output, ".."), { recursive: true });
  const content = [
    `AFTERTICK_API_URL=${apiUrl}`,
    `AFTERTICK_NODE_TOKEN=${credentials.token}`,
    `MANIFEST_SIGNING_SECRET=${signingSecret}`,
    `AFTERTICK_SERVER_ROOT=${serverRoot}`,
    `AFTERTICK_SRCDS_LAUNCHER=${launcherScript}`,
    `AFTERTICK_NODE_INSTANCE_KEY=${instanceKey}`,
    `AFTERTICK_SERVER_ADDRESS=${serverAddress}`,
    `AFTERTICK_SRCDS_HOST=${srcdsHost}`,
    `AFTERTICK_SRCDS_PORT=${gamePort}`,
    `AFTERTICK_GOTV_PORT=${gotvPort}`,
    `AFTERTICK_LATENCY_PROBE_PORT=${latencyProbePort}`,
    `AFTERTICK_SRCDS_LAN=${lanMode}`,
    ...(gsltToken ? [`AFTERTICK_SRCDS_GSLT=${gsltToken}`] : []),
    `AFTERTICK_SRCDS_RCON=${rconPassword}`,
    `AFTERTICK_SRCDS_IDLE_PASSWORD=${idlePassword}`,
    "AFTERTICK_NODE_HEARTBEAT_MS=2000",
    "AFTERTICK_SERVER_BUILD_ID=12426148",
    "AFTERTICK_PLUGIN_VERSION=0.1.0",
    ""
  ].join("\n");
  await writeFile(output, content, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ nodeId: credentials.nodeId, credentialsFile: output }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
