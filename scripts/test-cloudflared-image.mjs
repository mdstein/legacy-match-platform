import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import process from "node:process";

const workspace = resolve(import.meta.dirname, "..");
const windowsDocker = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const docker = process.env.AFTERTICK_DOCKER_BIN
  ?? (process.platform === "win32" && existsSync(windowsDocker) ? windowsDocker : "docker");
const dockerEnvironment = { ...process.env };
if (process.platform === "win32" && docker === windowsDocker) {
  dockerEnvironment.PATH = `${resolve(windowsDocker, "..")}${delimiter}${dockerEnvironment.PATH ?? ""}`;
}
const releaseEnvironment = readFileSync(resolve(workspace, "deploy", "release.env.example"), "utf8");
const image = releaseEnvironment
  .split(/\r?\n/u)
  .find((line) => line.startsWith("AFTERTICK_CLOUDFLARED_IMAGE="))
  ?.slice("AFTERTICK_CLOUDFLARED_IMAGE=".length);

if (!image || !/^cloudflare\/cloudflared@sha256:[a-f0-9]{64}$/u.test(image)) {
  throw new Error("deploy/release.env.example must pin cloudflare/cloudflared by immutable SHA-256 digest.");
}

function runCloudflared(argumentsList) {
  const result = spawnSync(docker, [
    "run",
    "--rm",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp:size=16m,mode=1777",
    image,
    ...argumentsList
  ], {
    cwd: workspace,
    env: dockerEnvironment,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true
  });

  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`Pinned cloudflared container exited ${result.status}:\n${output}`);
  }
  return output;
}

const version = runCloudflared(["version"]);
if (!/cloudflared version 2026\.8\.2\b/u.test(version)) {
  throw new Error(`Pinned connector did not report cloudflared 2026.8.2:\n${version}`);
}

const help = runCloudflared(["tunnel", "run", "--help"]);
if (!help.includes("--token-file")) {
  throw new Error("Pinned connector does not expose the required --token-file option.");
}

const readyHelp = runCloudflared(["tunnel", "ready", "--help"]);
if (!readyHelp.includes("--metrics")) {
  throw new Error("Pinned connector does not expose metrics-backed tunnel readiness.");
}

console.log(`Pinned cloudflared 2026.8.2 runtime passed under read-only/no-capability restrictions (${image}).`);
