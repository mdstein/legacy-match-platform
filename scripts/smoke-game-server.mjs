import dgram from "node:dgram";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const host = process.env.AFTERTICK_SRCDS_HOST ?? "127.0.0.1";
const port = Number(process.env.AFTERTICK_SRCDS_PORT ?? 27115);
const password = process.env.AFTERTICK_SRCDS_RCON ?? "aftertick-local-rcon-test";

function readString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw new Error("Malformed A2S string.");
  return { value: buffer.toString("utf8", offset, end), offset: end + 1 };
}

function parseInfo(buffer) {
  if (buffer.readInt32LE(0) !== -1 || buffer[4] !== 0x49) {
    throw new Error(`Unexpected A2S_INFO response type ${buffer[4]}.`);
  }
  let offset = 6;
  const name = readString(buffer, offset); offset = name.offset;
  const map = readString(buffer, offset); offset = map.offset;
  const folder = readString(buffer, offset); offset = folder.offset;
  const game = readString(buffer, offset); offset = game.offset;
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

async function queryInfo() {
  const socket = dgram.createSocket("udp4");
  const base = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
    Buffer.from("Source Engine Query\0")
  ]);

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("A2S_INFO timed out.")), 5_000);
      socket.on("error", reject);
      socket.on("message", (message) => {
        if (message[4] === 0x41 && message.length >= 9) {
          socket.send(Buffer.concat([base, message.subarray(5, 9)]), port, host);
          return;
        }
        clearTimeout(timer);
        resolve(parseInfo(message));
      });
      socket.send(base, port, host);
    });
  } finally {
    socket.close();
  }
}

function packet(id, type, body) {
  const bodyBuffer = Buffer.from(body, "utf8");
  const result = Buffer.alloc(14 + bodyBuffer.length);
  result.writeInt32LE(10 + bodyBuffer.length, 0);
  result.writeInt32LE(id, 4);
  result.writeInt32LE(type, 8);
  bodyBuffer.copy(result, 12);
  result.writeInt16LE(0, 12 + bodyBuffer.length);
  return result;
}

async function rcon(command) {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(5_000);
  let pending = Buffer.alloc(0);
  const frames = [];

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readInt32LE(0);
      if (pending.length < length + 4) break;
      frames.push({
        id: pending.readInt32LE(4),
        type: pending.readInt32LE(8),
        body: pending.toString("utf8", 12, length + 2)
      });
      pending = pending.subarray(length + 4);
    }
  });

  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("RCON connection timed out.")));
    });
    socket.write(packet(1, 3, password));
    const authDeadline = Date.now() + 5_000;
    while (!frames.some((frame) => frame.type === 2)) {
      if (Date.now() >= authDeadline) throw new Error("RCON authentication timed out.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const auth = frames.find((frame) => frame.type === 2);
    if (auth.id === -1) throw new Error("RCON authentication failed.");

    frames.length = 0;
    socket.write(packet(2, 2, command));
    const responseDeadline = Date.now() + 2_000;
    while (frames.length === 0 && Date.now() < responseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return frames.filter((frame) => frame.id === 2).map((frame) => frame.body).join("");
  } finally {
    socket.end();
  }
}

const output = await rcon("status; meta version; sm version; sm plugins list");
for (const marker of [
  "Metamod:Source version",
  "SourceMod Version Information",
  "Aftertick Match",
  "SourceMod Anti-Cheat",
  "SMAC Aimbot Detector",
  "SMAC AutoTrigger Detector",
  "SMAC Eye Angle Test",
  "SMAC Anti-Speedhack",
  "SMAC Spinhack Detector"
]) {
  if (!output.includes(marker)) {
    throw new Error(`RCON output did not include ${marker}:\n${output}`);
  }
}

const matchId = "00000000-0000-4000-8000-000000000001";
const rosterT = ["76561198000000001", "76561198000000002", "76561198000000003", "76561198000000004", "76561198000000005"];
const rosterCt = ["76561198000000006", "76561198000000007", "76561198000000008", "76561198000000009", "76561198000000010"];
const lifecycleOutput = await rcon([
  `aftertick_match_id ${matchId}`,
  `aftertick_roster_t ${rosterT.join(",")}`,
  `aftertick_roster_ct ${rosterCt.join(",")}`,
  "sm_aftertick_prepare",
  "sm_aftertick_begin"
].join("; "));
if (!lifecycleOutput.includes("Match is live")) {
  throw new Error(`Plugin did not enter live state:\n${lifecycleOutput}`);
}
await rcon("sm_aftertick_abort");

const eventPath = resolve(import.meta.dirname, "../.tools/csgo-server/csgo/addons/sourcemod/logs/aftertick-events.jsonl");
const events = (await readFile(eventPath, "utf8"))
  .trim()
  .split(/\r?\n/)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      // Production ingestion also skips malformed historical lines while
      // preserving its byte cursor. A stale pre-fix fixture must not hide
      // valid events emitted by the current plugin build.
      return [];
    }
  })
  .filter((event) => event.matchId === matchId);
for (const eventType of ["match.live", "match.aborted"]) {
  if (!events.some((event) => event.type === eventType)) {
    throw new Error(`Plugin event log is missing ${eventType}.`);
  }
}

let info = null;
try {
  info = await queryInfo();
} catch (error) {
  if (process.env.AFTERTICK_REQUIRE_A2S === "1") throw error;
  console.error(`A2S_INFO unavailable on this loopback server: ${error.message}`);
}
if (info && (info.folder !== "csgo" || info.map !== "de_dust2" || info.maxPlayers < 10)) {
  throw new Error(`Unexpected server identity: ${JSON.stringify(info)}`);
}

console.log(JSON.stringify({
  info,
  verified: [
    "RCON",
    "MetaMod",
    "SourceMod",
    "Aftertick Match",
    "SMAC evidence modules",
    "match.live",
    "match.aborted"
  ]
}, null, 2));

if (process.env.AFTERTICK_STOP_AFTER_SMOKE === "1") {
  await rcon("quit");
  console.log("Requested a clean SRCDS shutdown through RCON.");
}
