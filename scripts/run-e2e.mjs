import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const node = process.execPath;
const children = [];
let stopping = false;

function portIsOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once("error", () => resolveOpen(false));
  });
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process may still be binding its listener.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function start(name, args) {
  const child = spawn(node, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: "inherit",
    windowsHide: true
  });
  child.aftertickName = name;
  children.push(child);
  return child;
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

async function stopChildren() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.race([
    Promise.all(children.map(waitForExit)),
    delay(5_000)
  ]);
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stopChildren();
    process.exit(130);
  });
}

let exitCode = 1;
try {
  for (const port of [4174, 8788]) {
    if (await portIsOpen(port)) {
      throw new Error(`E2E port ${port} is already in use.`);
    }
  }

  start("api", ["apps/api/e2e.mjs"]);
  await waitFor("http://127.0.0.1:8788/health");

  start("web", [
    "node_modules/vite/bin/vite.js",
    "preview",
    "apps/web",
    "--host",
    "127.0.0.1",
    "--config",
    "apps/web/vite.e2e.config.mjs",
    "--configLoader",
    "native"
  ]);
  await waitFor("http://127.0.0.1:4174");

  const playwrightArgs = [
    "node_modules/@playwright/test/cli.js",
    "test",
    ...process.argv.slice(2)
  ];
  const runner = start("playwright", playwrightArgs);
  exitCode = await waitForExit(runner);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  await stopChildren();
}

process.exit(exitCode);
