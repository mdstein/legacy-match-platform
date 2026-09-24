import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const root = new URL("../", import.meta.url);
const traceId = randomBytes(16).toString("hex");
const spanId = randomBytes(8).toString("hex");
const output = [];

const api = spawn(process.execPath, ["scripts/start-observed-api.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    HOST: process.env.AFTERTICK_OBSERVABILITY_API_HOST
      ?? (process.platform === "linux" ? "0.0.0.0" : "127.0.0.1"),
    PORT: "8787",
    DATABASE_URL: process.env.DATABASE_URL
      ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick",
    REDIS_URL: process.env.REDIS_URL
      ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0",
    SESSION_SECRET: process.env.SESSION_SECRET
      ?? "aftertick-observability-smoke-session-secret",
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    S3_BUCKET: process.env.S3_BUCKET ?? "aftertick-demos",
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "aftertick-local",
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "aftertick-local-minio-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ?? "http://127.0.0.1:4318",
    OTEL_SERVICE_NAME: "aftertick-api",
    OTEL_TRACES_SAMPLER: "always_on"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
api.stdout.on("data", (chunk) => output.push(chunk.toString()));
api.stderr.on("data", (chunk) => output.push(chunk.toString()));

async function retry(label, operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : "."}`);
}

async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  return response.json();
}

try {
  await retry("Instrumented API", async () => {
    const response = await fetch("http://127.0.0.1:8787/health", {
      headers: { traceparent: `00-${traceId}-${spanId}-01` }
    });
    return response.ok;
  });

  const trace = await retry("Tempo trace", async () => {
    const response = await fetch(`http://127.0.0.1:3200/api/traces/${traceId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Tempo returned ${response.status}.`);
    return response.json();
  });
  const spans = trace.batches.flatMap((batch) =>
    batch.scopeSpans.flatMap((scope) => scope.spans ?? [])
  );
  if (spans.length < 2 || !spans.some((span) => span.name === "GET")) {
    throw new Error("Tempo did not store the expected HTTP trace tree.");
  }

  const targets = await retry("Prometheus telemetry targets", async () => {
    const value = await json("http://127.0.0.1:9090/api/v1/targets");
    const relevant = value.data.activeTargets.filter((target) =>
      ["aftertick-api", "aftertick-telemetry"].includes(target.labels.job)
    );
    if (relevant.length === 3 && relevant.every((target) => target.health === "up")) {
      return relevant;
    }
    throw new Error(JSON.stringify(relevant.map((target) => ({
      instance: target.labels.instance,
      health: target.health,
      lastError: target.lastError
    }))));
  }, 45_000);

  const credentials = Buffer.from(
    `${process.env.GRAFANA_ADMIN_USER ?? "aftertick"}:${process.env.GRAFANA_ADMIN_PASSWORD ?? "aftertick-local-grafana"}`
  ).toString("base64");
  const grafanaHeaders = { Authorization: `Basic ${credentials}` };
  const dataSources = await json("http://127.0.0.1:3000/api/datasources", { headers: grafanaHeaders });
  if (!dataSources.some((source) => source.uid === "tempo" && source.type === "tempo")) {
    throw new Error("Grafana has no provisioned Tempo datasource.");
  }
  const tempoHealth = await json("http://127.0.0.1:3000/api/datasources/uid/tempo/health", {
    headers: grafanaHeaders
  });
  if (tempoHealth.status !== "OK") throw new Error("Grafana cannot query Tempo.");

  console.log(JSON.stringify({
    traceId,
    storedSpans: spans.length,
    prometheusTargets: targets.map((target) => target.labels.instance).sort(),
    grafanaTempo: tempoHealth.status
  }, null, 2));
} catch (error) {
  process.stderr.write(output.join(""));
  throw error;
} finally {
  api.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => api.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (api.exitCode === null) api.kill();
}
