import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const evidence = resolve(workspace, ".artifacts", "hosted-preflight", "fixture.json");
const token = "aftertick-hosted-preflight-test-token";

function a2sInfo() {
  const strings = ["Aftertick Fixture", "de_mirage", "csgo", "Counter-Strike: Global Offensive"];
  const body = Buffer.concat(strings.map((value) => Buffer.from(`${value}\0`)));
  const fixed = Buffer.alloc(2 + 7);
  fixed.writeUInt16LE(730, 0);
  fixed[2] = 0;
  fixed[3] = 10;
  fixed[4] = 0;
  fixed[5] = "d".charCodeAt(0);
  fixed[6] = "w".charCodeAt(0);
  fixed[7] = 1;
  fixed[8] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x11]), body, fixed]);
}

function listenUdp() {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (_message, remote) => {
    socket.send(a2sInfo(), remote.port, remote.address);
  });
  return new Promise((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolvePromise(socket));
  });
}

const securityHeaders = {
  "content-security-policy": "default-src 'self'",
  "permissions-policy": "camera=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff"
};
const server = http.createServer((request, response) => {
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
  if (request.url === "/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
  } else if (request.url === "/ready") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ready", ready: true, checks: { fixture: { status: "ok" } } }));
  } else if (request.url === "/metrics") {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end("unauthorized");
    } else {
      response.end("aftertick_fixture 1\n");
    }
  } else {
    response.end("<!doctype html><title>Aftertick fixture</title>");
  }
});

const listenHttp = new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});

const [game, gotv] = await Promise.all([listenUdp(), listenUdp(), listenHttp]).then((values) => values);
try {
  const httpPort = server.address().port;
  const gamePort = game.address().port;
  const gotvPort = gotv.address().port;
  const child = spawn(process.execPath, [
    resolve(workspace, "scripts", "verify-hosted-platform.mjs"),
    "--public-url", `http://127.0.0.1:${httpPort}`,
    "--allow-http",
    "--game-host", "127.0.0.1",
    "--game-port", String(gamePort),
    "--gotv-port", String(gotvPort),
    "--samples", "3",
    "--require-game",
    "--output", evidence
  ], {
    cwd: workspace,
    env: { ...process.env, METRICS_BEARER_TOKEN: token },
    stdio: "inherit",
    windowsHide: true
  });
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Hosted preflight fixture failed with ${exitCode}.`);
  const report = JSON.parse(await readFile(evidence, "utf8"));
  if (!report.passed || report.checks.some((check) => check.status !== "passed")) {
    throw new Error("Hosted preflight fixture did not record passing evidence.");
  }
  console.log(`Hosted preflight fixture passed with ${report.checks.length} checks.`);
} finally {
  game.close();
  gotv.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
