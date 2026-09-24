import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

const root = resolve(import.meta.dirname, "..");
const credentialsPath = resolve(root, ".artifacts", "nodes", "local.env");
const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgres://aftertick:aftertick-local-postgres@127.0.0.1:5432/aftertick";
const redisUrl = process.env.TEST_REDIS_URL
  ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0";
const port = 8792;
const origin = `http://127.0.0.1:${port}`;

function parseEnvironment(content) {
  return Object.fromEntries(content
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Malformed node credential file.");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

function launch(command, args, environment) {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.aftertickOutput = () => output;
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

async function waitFor(label, check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${label} timed out.${lastError ? ` ${lastError.message}` : ""}`);
}

const credentials = parseEnvironment(await readFile(credentialsPath, "utf8"));
const sql = postgres(databaseUrl, { max: 3, connect_timeout: 10 });
let api;
let agent;
let lastServerPid = null;
try {
  api = launch(process.execPath, ["apps/api/dist/server.js"], {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    AFTERTICK_PUBLIC_URL: origin,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SESSION_SECRET: "aftertick-node-agent-integration-session-secret",
    MANIFEST_SIGNING_SECRET: credentials.MANIFEST_SIGNING_SECRET,
    API_RATE_LIMIT: "2000",
    AUTH_RATE_LIMIT: "2000"
  });
  await waitFor("API readiness", async () => {
    if (api.exitCode !== null) throw new Error(api.aftertickOutput());
    const response = await fetch(`${origin}/ready`);
    return response.ok;
  }, 20_000);

  agent = launch(process.execPath, ["apps/node-agent/dist/main.js"], {
    ...process.env,
    ...credentials,
    AFTERTICK_API_URL: origin,
    AFTERTICK_NODE_HEARTBEAT_MS: "500"
  });

  const [node] = await sql`
    select id from game_nodes where name = 'local-windows-01'
  `;
  if (!node) throw new Error("The registered local node does not exist.");
  await waitFor("initial node heartbeat", async () => {
    if (agent.exitCode !== null) throw new Error(agent.aftertickOutput());
    const [instance] = await sql`
      select state, last_heartbeat_at
      from server_instances
      where node_id = ${node.id} and instance_key = 'csgo-01'
    `;
    return instance?.last_heartbeat_at ? instance : null;
  });

  await sql`
    insert into node_commands (node_id, command_type, payload)
    values (${node.id}, 'start', ${sql.json({ instanceKey: "csgo-01" })})
  `;
  let ready;
  try {
    ready = await waitFor("real SRCDS warm-pool startup", async () => {
      const [instance] = await sql`
        select state, process_id
        from server_instances
        where node_id = ${node.id} and instance_key = 'csgo-01'
      `;
      if (instance?.process_id) lastServerPid = Number(instance.process_id);
      return instance?.state === "ready" ? instance : null;
    }, 60_000);
  } catch (error) {
    throw new Error(`${error.message}\nNode-agent output:\n${agent.aftertickOutput()}`);
  }

  await sql`
    insert into node_commands (node_id, command_type, payload)
    values (${node.id}, 'stop', ${sql.json({ instanceKey: "csgo-01" })})
  `;
  await waitFor("real SRCDS controlled shutdown", async () => {
    const [instance] = await sql`
      select state
      from server_instances
      where node_id = ${node.id} and instance_key = 'csgo-01'
    `;
    return instance?.state === "offline" ? instance : null;
  }, 30_000);

  const [counts] = await sql`
    select
      count(*) filter (where command_type = 'start' and status = 'completed')::int as starts,
      count(*) filter (where command_type = 'stop' and status = 'completed')::int as stops
    from node_commands
    where node_id = ${node.id}
  `;
  if (Number(counts.starts) < 1 || Number(counts.stops) < 1) {
    throw new Error("The node agent did not acknowledge both lifecycle commands.");
  }
  console.log(JSON.stringify({
    nodeId: node.id,
    instanceState: "offline",
    observedReadyState: ready.state,
    verified: ["authenticated heartbeat", "start command", "real SRCDS ready", "stop command", "acknowledgements"]
  }, null, 2));
} finally {
  await stop(agent);
  await stop(api);
  await sql.end({ timeout: 5 });
  if (lastServerPid) {
    try {
      process.kill(lastServerPid, 0);
      process.kill(lastServerPid, "SIGTERM");
    } catch {
      // The controlled stop normally removes the process before this fallback.
    }
  }
}
