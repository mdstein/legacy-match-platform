import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const windowsDocker = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const docker = process.env.AFTERTICK_DOCKER_BIN
  ?? (process.platform === "win32" && existsSync(windowsDocker) ? windowsDocker : "docker");
const childEnv = {
  ...process.env,
  AFTERTICK_API_IMAGE: `ghcr.io/fixture/api@sha256:${"a".repeat(64)}`,
  AFTERTICK_WEB_IMAGE: `ghcr.io/fixture/web@sha256:${"b".repeat(64)}`,
  AFTERTICK_CLOUDFLARED_IMAGE: `cloudflare/cloudflared@sha256:${"c".repeat(64)}`,
  AFTERTICK_DEPLOY_ENV_FILE: resolve(workspace, "deploy", ".env.production.example"),
  AFTERTICK_MIGRATION_ENV_FILE: resolve(workspace, "deploy", ".env.migration.example"),
  AFTERTICK_TUNNEL_TOKEN_FILE: resolve(workspace, ".artifacts", "fixtures", "cloudflared.token"),
  POSTGRES_DB: "aftertick",
  POSTGRES_USER: "aftertick",
  POSTGRES_PASSWORD: "fixture-postgres-password",
  REDIS_PASSWORD: "fixture-redis-password"
};
if (process.platform === "win32" && docker === windowsDocker) {
  childEnv.PATH = `${resolve(windowsDocker, "..")};${childEnv.PATH ?? ""}`;
}

const result = spawnSync(docker, [
  "compose",
  "--env-file", resolve(workspace, "deploy", "release.env.example"),
  "-f", resolve(workspace, "deploy", "compose.hosted.yml"),
  "config", "--format", "json"
], {
  cwd: workspace,
  env: childEnv,
  encoding: "utf8",
  windowsHide: true
});

if (result.error) {
  console.error(`Could not start Docker Compose with ${docker}:`, result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}

let config;
try {
  config = JSON.parse(result.stdout);
} catch (error) {
  console.error("Docker Compose did not return valid JSON:", error.message);
  process.stderr.write(result.stderr ?? "");
  process.exit(1);
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Hosted Compose contract failed: ${message}`);
  }
}

const web = config.services?.web;
const tunnel = config.services?.cloudflared;
const postgres = config.services?.postgres;
const redis = config.services?.redis;
invariant(web, "web service is missing");
invariant(tunnel, "cloudflared service is missing");
invariant(postgres, "postgres service is missing");
invariant(redis, "redis service is missing");
invariant(!postgres.ports?.length, "postgres must not publish a host port");
invariant(!redis.ports?.length, "redis must not publish a host port");
invariant(postgres.volumes?.some((volume) => volume.target === "/var/lib/postgresql/data"), "postgres data must be persistent");
invariant(redis.volumes?.some((volume) => volume.target === "/data"), "redis data must be persistent");
invariant(config.services?.api?.depends_on?.postgres?.condition === "service_healthy", "api must wait for postgres readiness");
invariant(config.services?.api?.depends_on?.redis?.condition === "service_healthy", "api must wait for redis readiness");

const publicPort = web.ports?.find((port) => Number(port.target) === 8080);
invariant(publicPort?.host_ip === "127.0.0.1", "web port 8080 must remain bound to host loopback");
const tunnelMetricsPort = tunnel.ports?.find((port) => Number(port.target) === 20241);
invariant(tunnelMetricsPort?.host_ip === "127.0.0.1", "cloudflared metrics/readiness must bind only to host loopback");
invariant(tunnel.ports?.length === 1, "cloudflared must publish only its loopback metrics/readiness port");
invariant(tunnel.image === childEnv.AFTERTICK_CLOUDFLARED_IMAGE, "cloudflared must use the immutable configured image digest");
invariant(tunnel.read_only === true, "cloudflared root filesystem must be read-only");
invariant(tunnel.user === "0:0", "cloudflared may read the protected bind mount only as container root");
invariant(tunnel.cap_drop?.includes("ALL"), "cloudflared must drop every Linux capability");
invariant(tunnel.security_opt?.includes("no-new-privileges:true"), "cloudflared must forbid privilege escalation");
invariant(tunnel.depends_on?.web?.condition === "service_started", "cloudflared must wait for the private web service");

const expectedCommand = [
  "tunnel",
  "--metrics",
  "0.0.0.0:20241",
  "--no-autoupdate",
  "run",
  "--token-file",
  "/run/secrets/cloudflared-token"
];
invariant(JSON.stringify(tunnel.command) === JSON.stringify(expectedCommand), "tunnel token must be read from a file rather than a command argument");
const expectedHealthcheck = ["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:20241", "ready"];
invariant(JSON.stringify(tunnel.healthcheck?.test) === JSON.stringify(expectedHealthcheck), "Docker health must require active Cloudflare edge connections");

const tokenMount = tunnel.volumes?.find((volume) => volume.target === "/run/secrets/cloudflared-token");
invariant(tokenMount?.type === "bind" && tokenMount.read_only === true, "tunnel token must be a read-only bind mount");
invariant(tokenMount?.source?.toLowerCase().endsWith("cloudflared.token"), "tunnel token source must be the dedicated secret file");

const nginx = readFileSync(resolve(workspace, "deploy", "nginx.conf"), "utf8");
invariant(nginx.includes("map $http_cf_connecting_ip $aftertick_client_ip"), "Nginx must restore Cloudflare's original visitor IP");
invariant(nginx.includes("map $http_x_forwarded_proto $aftertick_forwarded_proto"), "Nginx must preserve the public HTTPS scheme with a local fallback");
invariant(!nginx.includes("$proxy_add_x_forwarded_for"), "Nginx must discard client-supplied forwarded chains at the tunnel boundary");
invariant((nginx.match(/proxy_set_header X-Forwarded-For \$aftertick_client_ip;/gu) ?? []).length === 3, "all API proxy paths must pass exactly one trusted client-IP hop");
invariant(nginx.includes("client_max_body_size 100m;"), "GOTV demo uploads must allow normal match artifacts larger than Nginx's 1 MiB default");
invariant(nginx.includes("proxy_request_buffering off;"), "GOTV demo uploads must stream through Nginx without full request buffering");

console.log("Hosted Compose contract passed: loopback web/metrics, trusted client IP, and healthy outbound-only immutable token-file cloudflared.");
