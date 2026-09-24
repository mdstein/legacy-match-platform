import dgram from "node:dgram";
import dns from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import tls from "node:tls";

const workspace = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(workspace, ".artifacts", "hosted-preflight");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? "") : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function numberArgument(name, fallback, minimum, maximum) {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function readCString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw new Error("Malformed A2S_INFO string.");
  return { value: buffer.toString("utf8", offset, end), offset: end + 1 };
}

function parseA2sInfo(buffer) {
  if (buffer.length < 20 || buffer.readInt32LE(0) !== -1 || buffer[4] !== 0x49) {
    throw new Error("Unexpected A2S_INFO response.");
  }
  let offset = 6;
  const name = readCString(buffer, offset); offset = name.offset;
  const map = readCString(buffer, offset); offset = map.offset;
  const folder = readCString(buffer, offset); offset = folder.offset;
  const game = readCString(buffer, offset); offset = game.offset;
  const appId = buffer.readUInt16LE(offset); offset += 2;
  const players = buffer[offset++];
  const maxPlayers = buffer[offset++];
  const bots = buffer[offset++];
  const serverType = String.fromCharCode(buffer[offset++]);
  const environment = String.fromCharCode(buffer[offset++]);
  const visibility = buffer[offset++];
  const vac = buffer[offset++];
  return {
    name: name.value,
    map: map.value,
    folder: folder.value,
    game: game.value,
    appId,
    players,
    maxPlayers,
    bots,
    serverType,
    environment,
    passwordProtected: visibility === 1,
    vacSecured: vac === 1
  };
}

async function queryA2s(host, port, timeoutMs) {
  const socket = dgram.createSocket("udp4");
  const request = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
    Buffer.from("Source Engine Query\0")
  ]);
  const startedAt = performance.now();
  try {
    return await new Promise((resolvePromise, reject) => {
      let challenged = false;
      const timer = setTimeout(() => reject(new Error("A2S_INFO timed out.")), timeoutMs);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", fail);
      socket.on("message", (message) => {
        try {
          if (message[4] === 0x41 && message.length >= 9 && !challenged) {
            challenged = true;
            socket.send(Buffer.concat([request, message.subarray(5, 9)]), port, host);
            return;
          }
          const info = parseA2sInfo(message);
          clearTimeout(timer);
          resolvePromise({ latencyMs: performance.now() - startedAt, info });
        } catch (error) {
          fail(error);
        }
      });
      socket.send(request, port, host);
    });
  } finally {
    socket.close();
  }
}

async function sampleA2s(host, port, samples, timeoutMs) {
  const successes = [];
  const failures = [];
  for (let index = 0; index < samples; index += 1) {
    try {
      successes.push(await queryA2s(host, port, timeoutMs));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const latencies = successes.map((sample) => sample.latencyMs);
  return {
    host,
    port,
    samples,
    successfulSamples: successes.length,
    packetLossPercent: ((samples - successes.length) / samples) * 100,
    medianMs: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    info: successes[0]?.info ?? null,
    failures
  };
}

async function inspectTls(url) {
  const port = Number(url.port || 443);
  return new Promise((resolvePromise, reject) => {
    const socket = tls.connect({
      host: url.hostname,
      port,
      servername: url.hostname,
      rejectUnauthorized: true,
      timeout: 5_000
    });
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const validTo = new Date(certificate.valid_to);
      const remainingDays = (validTo.getTime() - Date.now()) / 86_400_000;
      const result = {
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
        subjectAltNamePresent: Boolean(certificate.subjectaltname),
        fingerprint256: certificate.fingerprint256,
        validTo: validTo.toISOString(),
        remainingDays
      };
      socket.end();
      resolvePromise(result);
    });
    socket.once("timeout", () => socket.destroy(new Error("TLS handshake timed out.")));
    socket.once("error", reject);
  });
}

async function fetchTimed(url, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    ...options
  });
  return { response, latencyMs: performance.now() - startedAt };
}

async function main() {
  const publicUrl = new URL(argument("public-url", process.env.AFTERTICK_PUBLIC_URL ?? ""));
  const allowHttp = flag("allow-http");
  if (!allowHttp && publicUrl.protocol !== "https:") {
    throw new Error("Hosted verification requires an HTTPS public URL.");
  }
  if (allowHttp && !["http:", "https:"].includes(publicUrl.protocol)) {
    throw new Error("Public URL must use HTTP or HTTPS.");
  }
  publicUrl.pathname = "/";
  publicUrl.search = "";
  publicUrl.hash = "";

  const gameHost = argument("game-host", "");
  const gamePort = numberArgument("game-port", 27115, 1, 65_535);
  const gotvPort = numberArgument("gotv-port", 27120, 1, 65_535);
  const samples = numberArgument("samples", 5, 1, 20);
  const timeoutMs = numberArgument("a2s-timeout-ms", 2_000, 100, 10_000);
  const maxGameP95Ms = numberArgument("max-game-p95-ms", 120, 1, 5_000);
  const maxLossPercent = numberArgument("max-loss-percent", 0, 0, 100);
  const requireGame = flag("require-game");
  if (requireGame && !gameHost) throw new Error("--require-game requires --game-host.");

  const output = resolve(argument("output", resolve(evidenceRoot, "latest.json")));
  const outputRelative = relative(evidenceRoot, output);
  if (isAbsolute(outputRelative) || outputRelative.startsWith("..")) {
    throw new Error(`Hosted evidence must remain below ${evidenceRoot}`);
  }

  const report = {
    checkedAt: new Date().toISOString(),
    publicUrl: publicUrl.origin,
    gameEndpoint: gameHost ? `${gameHost}:${gamePort}` : null,
    checks: [],
    passed: false
  };

  async function check(name, operation) {
    try {
      const evidence = await operation();
      report.checks.push({ name, status: "passed", evidence });
    } catch (error) {
      report.checks.push({
        name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await check("dns", async () => ({
    web: await dns.lookup(publicUrl.hostname, { all: true }),
    game: gameHost ? await dns.lookup(gameHost, { all: true }) : null
  }));

  if (publicUrl.protocol === "https:") {
    await check("tls", async () => {
      const evidence = await inspectTls(publicUrl);
      if (!evidence.authorized) throw new Error("TLS certificate is not authorized.");
      if (evidence.remainingDays < 14) throw new Error("TLS certificate expires in fewer than 14 days.");
      return evidence;
    });
  }

  await check("http", async () => {
    const healthSamples = [];
    let healthBody;
    let healthResponse;
    for (let index = 0; index < samples; index += 1) {
      const result = await fetchTimed(new URL("/health", publicUrl));
      if (result.response.status !== 200) throw new Error(`/health returned ${result.response.status}.`);
      healthSamples.push(result.latencyMs);
      healthResponse = result.response;
      healthBody = await result.response.json();
    }
    if (healthBody?.status !== "ok") throw new Error("/health body did not report ok.");

    const ready = await fetchTimed(new URL("/ready", publicUrl));
    const readyBody = await ready.response.json();
    if (ready.response.status !== 200 || readyBody?.status !== "ready" || readyBody?.ready !== true) {
      throw new Error(`/ready did not report ready (${ready.response.status}).`);
    }
    for (const [name, dependency] of Object.entries(readyBody.checks ?? {})) {
      if (dependency?.status !== "ok") throw new Error(`Readiness dependency ${name} is not ok.`);
    }

    const root = await fetchTimed(publicUrl);
    if (root.response.status !== 200) throw new Error(`/ returned ${root.response.status}.`);
    const requiredHeaders = [
      "content-security-policy",
      "permissions-policy",
      "referrer-policy",
      "x-content-type-options"
    ];
    if (publicUrl.protocol === "https:") requiredHeaders.push("strict-transport-security");
    for (const header of requiredHeaders) {
      if (!root.response.headers.get(header)) throw new Error(`Response is missing ${header}.`);
    }

    const metricsUnauthorized = await fetchTimed(new URL("/metrics", publicUrl));
    if (metricsUnauthorized.response.status !== 401) {
      throw new Error(`Unauthenticated /metrics returned ${metricsUnauthorized.response.status}.`);
    }
    let metricsAuthorized = null;
    if (process.env.METRICS_BEARER_TOKEN) {
      const metrics = await fetchTimed(new URL("/metrics", publicUrl), {
        headers: { Authorization: `Bearer ${process.env.METRICS_BEARER_TOKEN}` }
      });
      if (metrics.response.status !== 200) {
        throw new Error(`Authenticated /metrics returned ${metrics.response.status}.`);
      }
      metricsAuthorized = true;
    }

    return {
      health: healthBody,
      ready: readyBody,
      medianMs: percentile(healthSamples, 0.5),
      p95Ms: percentile(healthSamples, 0.95),
      securityHeaders: requiredHeaders,
      metricsUnauthorized: true,
      metricsAuthorized,
      serverHeader: healthResponse.headers.get("server") ?? null
    };
  });

  if (gameHost) {
    await check("game-a2s", async () => {
      const evidence = await sampleA2s(gameHost, gamePort, samples, timeoutMs);
      if (evidence.successfulSamples === 0) throw new Error("No A2S game query succeeded.");
      if (evidence.packetLossPercent > maxLossPercent) {
        throw new Error(`A2S game packet loss ${evidence.packetLossPercent}% exceeded ${maxLossPercent}%.`);
      }
      if (evidence.p95Ms > maxGameP95Ms) {
        throw new Error(`A2S game p95 ${evidence.p95Ms}ms exceeded ${maxGameP95Ms}ms.`);
      }
      if (evidence.info?.folder !== "csgo" || evidence.info?.maxPlayers < 10) {
        throw new Error("A2S game identity is not the expected CS:GO server.");
      }
      if (!evidence.info.passwordProtected) throw new Error("Idle game server is not password protected.");
      return evidence;
    });
    await check("gotv-a2s", async () => {
      const evidence = await sampleA2s(gameHost, gotvPort, samples, timeoutMs);
      if (evidence.successfulSamples === 0) throw new Error("No A2S GOTV query succeeded.");
      if (evidence.packetLossPercent > maxLossPercent) {
        throw new Error(`A2S GOTV packet loss ${evidence.packetLossPercent}% exceeded ${maxLossPercent}%.`);
      }
      return evidence;
    });
  } else if (requireGame) {
    report.checks.push({ name: "game-a2s", status: "failed", error: "Game endpoint is required." });
  }

  report.passed = report.checks.every((item) => item.status === "passed");
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, evidence: output, checks: report.checks }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
