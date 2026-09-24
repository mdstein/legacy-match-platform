import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const artifactRelative = ".artifacts/deployment-rollback";
const artifactDirectory = resolve(root, artifactRelative);
const environmentRelative = `${artifactRelative}/production.env`;
const overrideRelative = `${artifactRelative}/compose.rollback.yml`;
const dockerfile = resolve(artifactDirectory, "Dockerfile.failed-candidate");
const runId = `${Date.now()}-${process.pid}`;
const project = `aftertick-deploy-rollback-${runId}`;
const databaseSchema = `aftertick_rollback_${runId.replaceAll("-", "_")}`;
const databaseUrl = new URL(
  "postgres://aftertick:aftertick-local-postgres@postgres:5432/aftertick"
);
databaseUrl.searchParams.set("options", `-csearch_path=${databaseSchema}`);
const origin = "http://127.0.0.1:18080";
const knownGoodApi = "aftertick-api:rollback-good";
const knownGoodWeb = "aftertick-web:rollback-good";
const failedCandidateApi = "aftertick-api:rollback-candidate";
const windowsDocker = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const docker = process.env.AFTERTICK_DOCKER_BIN
  ?? (process.platform === "win32" && existsSync(windowsDocker) ? windowsDocker : "docker");

const report = {
  startedAt: new Date().toISOString(),
  project,
  databaseSchema,
  origin,
  initial: undefined,
  failedCandidate: undefined,
  rollback: undefined,
  verified: []
};

function execute(args, environment = process.env, { tolerateFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(docker, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 && !tolerateFailure) {
        reject(new Error(`docker ${args.join(" ")} failed (${signal ?? code}):\n${output}`));
        return;
      }
      resolvePromise({ code: code ?? 1, output: output.trim() });
    });
  });
}

function baseCompose(...args) {
  return execute(["compose", "-f", "compose.yml", ...args]);
}

function deployEnvironment(apiImage = knownGoodApi) {
  return {
    ...process.env,
    AFTERTICK_DEPLOY_ENV_FILE: environmentRelative,
    AFTERTICK_MIGRATION_ENV_FILE: environmentRelative,
    AFTERTICK_API_IMAGE: apiImage,
    AFTERTICK_WEB_IMAGE: knownGoodWeb,
    AFTERTICK_BIND_ADDRESS: "127.0.0.1",
    AFTERTICK_HTTP_PORT: "18080"
  };
}

function deploymentCompose(apiImage, ...args) {
  return execute([
    "compose",
    "--project-name",
    project,
    "-f",
    "compose.deploy.yml",
    "-f",
    overrideRelative,
    ...args
  ], deployEnvironment(apiImage));
}

async function waitFor(label, check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${label} timed out.${lastError ? ` ${lastError.message}` : ""}`);
}

async function fetchWithTimeout(path) {
  return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3_000) });
}

function remainingRequests(response) {
  const header = response.headers.get("ratelimit") ?? "";
  const match = header.match(/(?:^|[;,])\s*(?:r|remaining)=(\d+)/iu);
  if (!match) throw new Error(`RateLimit header did not expose a remaining count: ${header}`);
  return Number(match[1]);
}

async function verifyTunnelClientIpForwarding() {
  const request = (clientIp) => fetch(`${origin}/api/auth/me`, {
    headers: {
      "CF-Connecting-IP": clientIp,
      "X-Forwarded-For": "203.0.113.250"
    },
    signal: AbortSignal.timeout(3_000)
  });

  const firstA = await request("198.51.100.10");
  const secondA = await request("198.51.100.10");
  const firstB = await request("198.51.100.11");
  if (![firstA, secondA, firstB].every((response) => response.ok)) {
    throw new Error(`Forwarded-IP rate-limit probes returned ${firstA.status}/${secondA.status}/${firstB.status}.`);
  }

  const remainingA1 = remainingRequests(firstA);
  const remainingA2 = remainingRequests(secondA);
  const remainingB1 = remainingRequests(firstB);
  if (remainingA2 !== remainingA1 - 1 || remainingB1 !== remainingA1) {
    throw new Error(
      `CF-Connecting-IP was not isolated into player rate-limit buckets: ${remainingA1}/${remainingA2}/${remainingB1}.`
    );
  }

  return { remainingA1, remainingA2, remainingB1 };
}

async function serviceContainerId(service, apiImage = knownGoodApi) {
  const result = await deploymentCompose(apiImage, "ps", "-q", service);
  if (!result.output) throw new Error(`${service} has no container.`);
  return result.output.split(/\r?\n/).at(-1).trim();
}

async function containerState(service, apiImage = knownGoodApi) {
  const id = await serviceContainerId(service, apiImage);
  const result = await execute([
    "inspect",
    "--format",
    "{{.Image}}|{{.Config.Image}}|{{.State.Status}}|{{.RestartCount}}|{{.State.ExitCode}}",
    id
  ]);
  const [imageId, configuredImage, status, restartCount, exitCode] = result.output.split("|");
  return {
    id,
    imageId,
    configuredImage,
    status,
    restartCount: Number(restartCount),
    exitCode: Number(exitCode)
  };
}

async function imageId(image) {
  const result = await execute(["image", "inspect", "--format", "{{.Id}}", image]);
  return result.output;
}

async function verifyRelease(label) {
  const health = await fetchWithTimeout("/health");
  const ready = await fetchWithTimeout("/ready");
  const metrics = await fetchWithTimeout("/metrics");
  const rootResponse = await fetchWithTimeout("/");
  const readiness = await ready.json();
  const document = await rootResponse.text();

  if (!health.ok) throw new Error(`${label}: /health returned ${health.status}.`);
  if (!ready.ok || readiness.status !== "ready") {
    throw new Error(`${label}: /ready returned ${ready.status}: ${JSON.stringify(readiness)}`);
  }
  for (const dependency of ["postgres", "redis", "objectStorage"]) {
    if (readiness.checks?.[dependency]?.status !== "ok") {
      throw new Error(`${label}: ${dependency} readiness was not ok.`);
    }
  }
  if (metrics.status !== 401) {
    throw new Error(`${label}: unauthenticated /metrics returned ${metrics.status}, not 401.`);
  }
  if (!rootResponse.ok || !document.includes("back2csgo")) {
    throw new Error(`${label}: the production web image was not served.`);
  }
  if (rootResponse.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error(`${label}: X-Content-Type-Options is missing.`);
  }
  const csp = rootResponse.headers.get("content-security-policy") ?? "";
  if (!csp.includes("default-src 'self'") || !csp.includes("frame-ancestors 'none'")) {
    throw new Error(`${label}: the expected Content-Security-Policy is missing.`);
  }

  return {
    healthStatus: health.status,
    readiness,
    metricsStatus: metrics.status,
    securityHeaders: {
      contentSecurityPolicy: csp,
      contentTypeOptions: rootResponse.headers.get("x-content-type-options"),
      referrerPolicy: rootResponse.headers.get("referrer-policy")
    }
  };
}

await mkdir(artifactDirectory, { recursive: true });
await writeFile(resolve(artifactDirectory, "production.env"), [
  "NODE_ENV=production",
  "HOST=0.0.0.0",
  "PORT=8787",
  "AFTERTICK_PUBLIC_URL=https://play.aftertick.local",
  "AFTERTICK_LATENCY_PROBE_ENDPOINTS=NA Central=game-node.example:27015",
  "CORS_ORIGINS=https://play.aftertick.local",
  `DATABASE_URL=${databaseUrl.toString()}`,
  "REDIS_URL=redis://:aftertick-local-redis@redis:6379/0",
  "SESSION_SECRET=aftertick-rollback-session-secret-000000000001",
  "MANIFEST_SIGNING_SECRET=aftertick-rollback-manifest-secret-000000001",
  "API_RATE_LIMIT=240",
  "AUTH_RATE_LIMIT=30",
  "RATE_LIMIT_WINDOW_MS=60000",
  "S3_ENDPOINT=http://minio:9000",
  "S3_REGION=us-east-1",
  "S3_BUCKET=aftertick-demos",
  "S3_ACCESS_KEY=aftertick-local",
  "S3_SECRET_KEY=aftertick-local-minio-secret",
  "METRICS_BEARER_TOKEN=aftertick-rollback-metrics-token-00000000001",
  "OTEL_SERVICE_NAME=aftertick-api-rollback-smoke",
  "OTEL_EXPORTER_OTLP_ENDPOINT=http://minio:4318",
  "OTEL_TRACES_SAMPLER=always_off",
  ""
].join("\n"));
await writeFile(resolve(artifactDirectory, "compose.rollback.yml"), [
  "services:",
  "  migrate:",
  "    networks:",
  "      - aftertick-infra",
  "  api:",
  "    networks:",
  "      - default",
  "      - aftertick-infra",
  "    healthcheck:",
  "      interval: 1s",
  "      timeout: 2s",
  "      retries: 5",
  "      start_period: 1s",
  "  web:",
  "    healthcheck:",
  "      test: [\"CMD\", \"wget\", \"-q\", \"-O\", \"/dev/null\", \"http://127.0.0.1:8080/health\"]",
  "      interval: 1s",
  "      timeout: 2s",
  "      retries: 5",
  "      start_period: 1s",
  "networks:",
  "  aftertick-infra:",
  "    external: true",
  "    name: aftertick_default",
  ""
].join("\n"));
await writeFile(dockerfile, [
  `FROM ${knownGoodApi}`,
  "CMD [\"node\", \"-e\", \"process.exit(42)\"]",
  ""
].join("\n"));

let databaseSchemaCreated = false;
try {
  await baseCompose("up", "-d", "--wait", "postgres", "redis", "minio", "minio-bootstrap");
  await baseCompose(
    "exec", "-T", "postgres", "psql", "-U", "aftertick", "-d", "aftertick",
    "-v", "ON_ERROR_STOP=1", "-c", `CREATE SCHEMA "${databaseSchema}"`
  );
  databaseSchemaCreated = true;
  await deploymentCompose(knownGoodApi, "down", "--remove-orphans");
  await execute(["image", "tag", "aftertick-api:local", knownGoodApi]);
  await execute(["image", "tag", "aftertick-web:local", knownGoodWeb]);
  await execute(["build", "--pull=false", "--file", dockerfile, "--tag", failedCandidateApi, artifactDirectory]);

  const goodApiImageId = await imageId(knownGoodApi);
  const failedApiImageId = await imageId(failedCandidateApi);
  if (goodApiImageId === failedApiImageId) {
    throw new Error("The failed candidate did not produce a distinct image.");
  }

  await deploymentCompose(knownGoodApi, "config", "--quiet");
  await deploymentCompose(knownGoodApi, "--profile", "ops", "run", "--rm", "migrate");
  await deploymentCompose(
    knownGoodApi,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "60",
    "--no-build",
    "api",
    "web"
  );
  const initialVerification = await waitFor("known-good release", () => verifyRelease("initial"));
  const clientIpForwarding = await verifyTunnelClientIpForwarding();
  const initialApi = await containerState("api", knownGoodApi);
  const initialWeb = await containerState("web", knownGoodApi);
  if (initialApi.imageId !== goodApiImageId) {
    throw new Error("The initial API container is not running the known-good image ID.");
  }
  report.initial = { api: initialApi, web: initialWeb, verification: initialVerification, clientIpForwarding };
  report.verified.push("known-good production images became healthy behind Nginx");
  report.verified.push("Cloudflare client IPs produced independent rate-limit buckets and spoofed forwarded chains were discarded");

  await deploymentCompose(
    failedCandidateApi,
    "up",
    "-d",
    "--no-deps",
    "--no-build",
    "api"
  );
  const failedResponse = await waitFor("failed candidate rejection", async () => {
    try {
      const response = await fetchWithTimeout("/health");
      return response.status >= 500 ? { status: response.status } : null;
    } catch (error) {
      return { status: 0, error: error.message };
    }
  });
  const failedApi = await waitFor("failed candidate container", async () => {
    const state = await containerState("api", failedCandidateApi);
    return state.imageId === failedApiImageId ? state : null;
  });
  report.failedCandidate = { api: failedApi, ingressResponse: failedResponse };
  report.verified.push("an intentionally crashing candidate became unavailable and was observed through ingress");

  await deploymentCompose(
    knownGoodApi,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "60",
    "--no-deps",
    "--no-build",
    "api"
  );
  const rollbackVerification = await waitFor(
    "known-good rollback",
    () => verifyRelease("rollback"),
    60_000
  );
  const rollbackApi = await containerState("api", knownGoodApi);
  const rollbackWeb = await containerState("web", knownGoodApi);
  if (rollbackApi.imageId !== goodApiImageId) {
    throw new Error("Rollback did not restore the exact known-good API image ID.");
  }
  if (rollbackWeb.id !== initialWeb.id) {
    throw new Error("The web proxy was unexpectedly replaced during the API-only rollback.");
  }
  report.rollback = {
    api: rollbackApi,
    web: rollbackWeb,
    verification: rollbackVerification,
    restoredExactImage: true,
    proxySurvivedApiReplacement: true
  };
  report.verified.push("the exact known-good image recovered readiness without replacing the web proxy");
  report.verified.push("PostgreSQL, Redis, object storage, metrics protection, and security headers passed after rollback");

  report.finishedAt = new Date().toISOString();
  report.passed = true;
  await writeFile(resolve(artifactDirectory, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  await writeFile(resolve(artifactDirectory, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  await deploymentCompose(knownGoodApi, "down", "--remove-orphans").catch(() => undefined);
  if (databaseSchemaCreated) {
    await baseCompose(
      "exec", "-T", "postgres", "psql", "-U", "aftertick", "-d", "aftertick",
      "-v", "ON_ERROR_STOP=1", "-c", `DROP SCHEMA IF EXISTS "${databaseSchema}" CASCADE`
    ).catch(() => undefined);
  }
}
