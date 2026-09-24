import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  AFTERTICK_API_URL: z.string().url(),
  AFTERTICK_NODE_TOKEN: z.string().min(32),
  MANIFEST_SIGNING_SECRET: z.string().min(32),
  AFTERTICK_SERVER_ROOT: z.string().min(1),
  AFTERTICK_SRCDS_LAUNCHER: z.string().min(1),
  AFTERTICK_NODE_INSTANCE_KEY: z.string().min(1).max(128).default("csgo-01"),
  AFTERTICK_SERVER_ADDRESS: z.string().min(1).default("127.0.0.1:27115"),
  AFTERTICK_SRCDS_HOST: z.string().min(1).default("127.0.0.1"),
  AFTERTICK_SRCDS_PORT: z.coerce.number().int().min(1).max(65_535).default(27115),
  AFTERTICK_GOTV_PORT: z.coerce.number().int().min(1).max(65_535).default(27120),
  AFTERTICK_LATENCY_PROBE_PORT: z.coerce.number().int().min(1).max(65_535).default(27125),
  AFTERTICK_SRCDS_LAN: z.enum(["0", "1"]).default("1"),
  AFTERTICK_SRCDS_GSLT: z.string().regex(/^[a-fA-F0-9]{32}$/).optional(),
  AFTERTICK_SRCDS_RCON: z.string().regex(/^[a-zA-Z0-9_-]{12,128}$/),
  AFTERTICK_SRCDS_IDLE_PASSWORD: z.string()
    .regex(/^[a-zA-Z0-9_-]{16,128}$/)
    .default("aftertick-local-server"),
  AFTERTICK_NODE_HEARTBEAT_MS: z.coerce.number().int().min(500).max(30_000).default(2_000),
  AFTERTICK_EVENT_FLUSH_MS: z.coerce.number().int().min(25).max(2_000).default(100),
  AFTERTICK_SERVER_BUILD_ID: z.string().default("12426148"),
  AFTERTICK_PLUGIN_VERSION: z.string().default("0.1.0")
});

export interface AgentConfig {
  apiUrl: string;
  nodeToken: string;
  manifestSigningSecret: string;
  serverRoot: string;
  launcherScript: string;
  instanceKey: string;
  serverAddress: string;
  host: string;
  gamePort: number;
  gotvPort: number;
  latencyProbePort: number;
  lanMode: boolean;
  gsltToken?: string | undefined;
  rconPassword: string;
  idlePassword: string;
  heartbeatMs: number;
  eventFlushMs?: number;
  serverBuildId: string;
  pluginVersion: string;
}

export function loadAgentConfig(environment: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = schema.parse(environment);
  return {
    apiUrl: new URL(parsed.AFTERTICK_API_URL).origin,
    nodeToken: parsed.AFTERTICK_NODE_TOKEN,
    manifestSigningSecret: parsed.MANIFEST_SIGNING_SECRET,
    serverRoot: resolve(parsed.AFTERTICK_SERVER_ROOT),
    launcherScript: resolve(parsed.AFTERTICK_SRCDS_LAUNCHER),
    instanceKey: parsed.AFTERTICK_NODE_INSTANCE_KEY,
    serverAddress: parsed.AFTERTICK_SERVER_ADDRESS,
    host: parsed.AFTERTICK_SRCDS_HOST,
    gamePort: parsed.AFTERTICK_SRCDS_PORT,
    gotvPort: parsed.AFTERTICK_GOTV_PORT,
    latencyProbePort: parsed.AFTERTICK_LATENCY_PROBE_PORT,
    lanMode: parsed.AFTERTICK_SRCDS_LAN === "1",
    gsltToken: parsed.AFTERTICK_SRCDS_GSLT,
    rconPassword: parsed.AFTERTICK_SRCDS_RCON,
    idlePassword: parsed.AFTERTICK_SRCDS_IDLE_PASSWORD,
    heartbeatMs: parsed.AFTERTICK_NODE_HEARTBEAT_MS,
    eventFlushMs: parsed.AFTERTICK_EVENT_FLUSH_MS,
    serverBuildId: parsed.AFTERTICK_SERVER_BUILD_ID,
    pluginVersion: parsed.AFTERTICK_PLUGIN_VERSION
  };
}
