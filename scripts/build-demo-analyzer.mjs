import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const service = resolve(root, "services", "demo-analyzer");
const outputDirectory = resolve(root, ".artifacts", "bin");
const go = process.env.GO_EXE
  ?? (process.platform === "win32" ? "C:\\Program Files\\Go\\bin\\go.exe" : "go");
const output = resolve(
  outputDirectory,
  process.platform === "win32" ? "aftertick-demo-analyzer.exe" : "aftertick-demo-analyzer"
);

await mkdir(outputDirectory, { recursive: true });

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(go, args, {
      cwd: service,
      env: { ...process.env, GOCACHE: resolve(root, ".cache", "go-build") },
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Go ${args[0]} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

await run(["test", "./..."]);
await run(["build", "-trimpath", "-o", output, "./cmd/aftertick-demo-analyzer"]);
console.log(`Built ${output}`);
