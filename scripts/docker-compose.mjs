import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const windowsDocker = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const docker = process.env.AFTERTICK_DOCKER_BIN
  ?? (process.platform === "win32" && existsSync(windowsDocker) ? windowsDocker : "docker");

const childEnv = { ...process.env };
if (process.platform === "win32" && docker === windowsDocker) {
  const dockerBinDirectory = windowsDocker.slice(0, windowsDocker.lastIndexOf("\\"));
  childEnv.PATH = `${dockerBinDirectory};${childEnv.PATH ?? ""}`;
}

const child = spawn(docker, ["compose", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: "inherit",
  windowsHide: true
});

child.once("error", (error) => {
  console.error(`Could not start Docker Compose with ${docker}:`, error.message);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
