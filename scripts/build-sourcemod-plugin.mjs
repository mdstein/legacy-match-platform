import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "infra/game-server/plugins/aftertick_match.sp");
const scripting = resolve(root, ".tools/plugin-toolchain/sourcemod/addons/sourcemod/scripting");
const compiler = resolve(scripting, process.platform === "win32" ? "spcomp.exe" : "spcomp");
const outputDirectory = resolve(root, ".artifacts/sourcemod");
const output = resolve(outputDirectory, "aftertick_match.smx");

await mkdir(outputDirectory, { recursive: true });

const child = spawn(compiler, [
  source,
  `-i${resolve(scripting, "include")}`,
  `-o${output}`
], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true
});

child.once("error", (error) => {
  console.error(`SourceMod compiler could not start: ${error.message}`);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
