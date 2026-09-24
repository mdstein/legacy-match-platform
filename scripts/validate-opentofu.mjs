import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const workspace = resolve(import.meta.dirname, "..");
const stack = join(workspace, "infra", "opentofu", "private-alpha-edge");

function resolveOpenTofu() {
  if (process.env.OPENTOFU_BIN) {
    return process.env.OPENTOFU_BIN;
  }

  if (process.platform !== "win32") {
    return "tofu";
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return "tofu.exe";
  }

  const link = join(localAppData, "Microsoft", "WinGet", "Links", "tofu.exe");
  if (existsSync(link)) {
    return link;
  }

  const packages = join(localAppData, "Microsoft", "WinGet", "Packages");
  if (existsSync(packages)) {
    const install = readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenTofu.Tofu_"))
      .map((entry) => join(packages, entry.name, "tofu.exe"))
      .find(existsSync);
    if (install) {
      return install;
    }
  }

  return "tofu.exe";
}

const tofu = resolveOpenTofu();

function run(args) {
  const result = spawnSync(tofu, args, {
    cwd: workspace,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["fmt", "-check", "-recursive", join(workspace, "infra", "opentofu")]);
run([`-chdir=${stack}`, "init", "-backend=false", "-input=false"]);
run([`-chdir=${stack}`, "validate"]);
run([`-chdir=${stack}`, "test"]);
