import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const windowsDocker = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const executable = process.platform === "win32" && existsSync(windowsDocker) ? windowsDocker : "bash";
const argumentsList = process.platform === "win32"
  ? [
      "run", "--rm", "--user", "0:0",
      "--volume", `${workspace}:/workspace`,
      "--workdir", "/workspace",
      "aftertick-api:local",
      "bash", "scripts/test-linux-host-release.sh"
    ]
  : [resolve(workspace, "scripts", "test-linux-host-release.sh")];
const child = spawn(executable, argumentsList, {
  cwd: workspace,
  env: process.env,
  stdio: "inherit",
  windowsHide: true
});
child.once("error", (error) => {
  console.error(`Could not start ${executable}:`, error.message);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
