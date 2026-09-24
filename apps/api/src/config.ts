import { z } from "zod";
import { REGIONS } from "./catalog.js";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    AFTERTICK_PUBLIC_URL: z.string().url().optional(),
    DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url().optional(),
    SESSION_SECRET: z.string().min(32).optional(),
    MANIFEST_SIGNING_SECRET: z.string().min(32).optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
    S3_ACCESS_KEY: z.string().min(3).optional(),
    S3_SECRET_KEY: z.string().min(8).optional(),
    CORS_ORIGINS: z.string().optional(),
    API_RATE_LIMIT: z.coerce.number().int().positive().default(240),
    AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
    DEV_PLAYER_ID: z.string().optional(),
    AFTERTICK_E2E_PLAYER_ID: z.string().optional(),
    AFTERTICK_E2E_IDENTITY_HEADER_SECRET: z.string().min(16).optional(),
    AFTERTICK_BOOTSTRAP_ADMIN_STEAM_ID: z.string().regex(/^\d{17}$/).optional(),
    METRICS_BEARER_TOKEN: z.string().min(32).optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    AFTERTICK_LATENCY_PROBE_ENDPOINTS: z.string().optional(),
    AFTERTICK_LATENCY_PROBE_CHALLENGE_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
    AFTERTICK_LATENCY_MEASUREMENT_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900)
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;

    for (const key of [
      "AFTERTICK_PUBLIC_URL",
      "DATABASE_URL",
      "REDIS_URL",
      "SESSION_SECRET",
      "MANIFEST_SIGNING_SECRET",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "METRICS_BEARER_TOKEN",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "AFTERTICK_LATENCY_PROBE_ENDPOINTS"
    ] as const) {
      if (!value[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in production.`
        });
      }
    }

    if (value.AFTERTICK_PUBLIC_URL && new URL(value.AFTERTICK_PUBLIC_URL).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["AFTERTICK_PUBLIC_URL"],
        message: "AFTERTICK_PUBLIC_URL must use HTTPS in production."
      });
    }

    if (
      value.DEV_PLAYER_ID
      || value.AFTERTICK_E2E_PLAYER_ID
      || value.AFTERTICK_E2E_IDENTITY_HEADER_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: [
          value.DEV_PLAYER_ID
            ? "DEV_PLAYER_ID"
            : value.AFTERTICK_E2E_PLAYER_ID
              ? "AFTERTICK_E2E_PLAYER_ID"
              : "AFTERTICK_E2E_IDENTITY_HEADER_SECRET"
        ],
        message: "Development identity overrides cannot be enabled in production."
      });
    }
  });

export interface AppConfig {
  environment: "development" | "test" | "production";
  bindHost: "127.0.0.1" | "0.0.0.0";
  port: number;
  publicUrl: string | undefined;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  sessionSecret: string;
  manifestSigningSecret: string;
  secureCookies: boolean;
  allowedOrigins: string[];
  apiRateLimit: number;
  authRateLimit: number;
  rateLimitWindowMs: number;
  bootstrapAdminSteamId: string | undefined;
  metricsToken: string | undefined;
  objectStorage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  } | undefined;
  latencyProbes: {
    endpoints: Record<string, string>;
    challengeSeconds: number;
    measurementSeconds: number;
  } | undefined;
}

function parseProbeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(`udp://${value}`);
  } catch {
    throw new Error(`Invalid latency probe endpoint: ${value}`);
  }
  const port = Number(endpoint.port);
  if (
    !endpoint.hostname
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== ""
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error(`Invalid latency probe endpoint: ${value}`);
  }
  return value;
}

export function parseLatencyProbeEndpoints(value?: string): Record<string, string> {
  if (!value?.trim()) return {};
  const result: Record<string, string> = {};
  for (const entry of value.split(";")) {
    const separator = entry.indexOf("=");
    const region = entry.slice(0, separator).trim();
    const endpoint = entry.slice(separator + 1).trim();
    if (separator <= 0 || !(REGIONS as readonly string[]).includes(region) || result[region]) {
      throw new Error(`Invalid or duplicate latency probe region: ${region || entry}`);
    }
    result[region] = parseProbeEndpoint(endpoint);
  }
  return result;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const latencyProbeEndpoints = parseLatencyProbeEndpoints(parsed.AFTERTICK_LATENCY_PROBE_ENDPOINTS);
  const configuredOrigins = parsed.CORS_ORIGINS
    ?.split(",")
    .map((origin) => new URL(origin.trim()).origin)
    .filter(Boolean) ?? [];
  const publicOrigin = parsed.AFTERTICK_PUBLIC_URL
    ? new URL(parsed.AFTERTICK_PUBLIC_URL).origin
    : undefined;

  return {
    environment: parsed.NODE_ENV,
    bindHost: parsed.HOST,
    port: parsed.PORT,
    publicUrl: parsed.AFTERTICK_PUBLIC_URL,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    sessionSecret: parsed.SESSION_SECRET ?? "aftertick-development-session-secret-only",
    manifestSigningSecret:
      parsed.MANIFEST_SIGNING_SECRET ?? "aftertick-development-manifest-signing-secret-only",
    secureCookies: parsed.NODE_ENV === "production",
    allowedOrigins: [...new Set([
      ...(publicOrigin ? [publicOrigin] : []),
      ...configuredOrigins
    ])],
    apiRateLimit: parsed.API_RATE_LIMIT,
    authRateLimit: parsed.AUTH_RATE_LIMIT,
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    bootstrapAdminSteamId: parsed.AFTERTICK_BOOTSTRAP_ADMIN_STEAM_ID,
    metricsToken: parsed.METRICS_BEARER_TOKEN,
    objectStorage: parsed.S3_ENDPOINT
      && parsed.S3_BUCKET
      && parsed.S3_ACCESS_KEY
      && parsed.S3_SECRET_KEY
      ? {
          endpoint: parsed.S3_ENDPOINT,
          region: parsed.S3_REGION,
          bucket: parsed.S3_BUCKET,
          accessKey: parsed.S3_ACCESS_KEY,
          secretKey: parsed.S3_SECRET_KEY
        }
      : undefined,
    latencyProbes: Object.keys(latencyProbeEndpoints).length > 0
      ? {
          endpoints: latencyProbeEndpoints,
          challengeSeconds: parsed.AFTERTICK_LATENCY_PROBE_CHALLENGE_SECONDS,
          measurementSeconds: parsed.AFTERTICK_LATENCY_MEASUREMENT_SECONDS
        }
      : undefined
  };
}
