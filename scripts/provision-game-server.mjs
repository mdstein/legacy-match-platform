import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return resolve(index >= 0 ? (process.argv[index + 1] ?? "") : fallback);
}

function credential(name, fallback, minimum) {
  const value = process.env[name] ?? fallback;
  const pattern = new RegExp(`^[a-zA-Z0-9_-]{${minimum},128}$`);
  if (!pattern.test(value)) {
    throw new Error(`${name} must contain ${minimum}-128 safe alphanumeric, underscore, or dash characters.`);
  }
  return value;
}

const server = argument("server-root", resolve(root, ".tools/csgo-server"));
const game = resolve(server, "csgo");
const metamod = argument("metamod-root", resolve(root, ".tools/plugin-toolchain/metamod"));
const sourcemod = argument("sourcemod-root", resolve(root, ".tools/plugin-toolchain/sourcemod"));
const plugin = argument("plugin", resolve(root, ".artifacts/sourcemod/aftertick_match.smx"));
const config = argument("config", resolve(root, "infra/game-server/cfg/server.cfg"));
const smac = argument("smac-root", resolve(root, ".artifacts/sourcemod/smac"));
const smacConfig = argument("smac-config", resolve(root, "infra/game-server/cfg/smac.cfg"));
const noLobbyPlugin = argument(
  "lobby-plugin",
  resolve(root, ".tools/plugin-toolchain/nolobbyreservation/nolobbyreservation.smx")
);
const noLobbyGameData = argument(
  "lobby-gamedata",
  resolve(root, ".tools/plugin-toolchain/nolobbyreservation/nolobbyreservation.games.txt")
);
const steamFixExtension = argument(
  "steamfix-extension",
  resolve(root, ".tools/plugin-toolchain/csgo-steamfix/csgo_steamfix.ext.dll")
);
const steamFixAutoload = argument(
  "steamfix-autoload",
  resolve(root, ".tools/plugin-toolchain/csgo-steamfix/csgo_steamfix.autoload")
);
const rconPassword = credential("AFTERTICK_SRCDS_RCON", "aftertick-local-rcon-test", 12);
const idlePassword = credential("AFTERTICK_SRCDS_IDLE_PASSWORD", "aftertick-local-server", 16);

for (const required of [
  resolve(server, process.platform === "win32" ? "srcds.exe" : "srcds_run"),
  resolve(metamod, "addons"),
  resolve(sourcemod, "addons"),
  plugin,
  config,
  smacConfig,
  noLobbyPlugin,
  noLobbyGameData,
  steamFixExtension,
  steamFixAutoload,
  ...[
    "smac",
    "smac_aimbot",
    "smac_autotrigger",
    "smac_eyetest",
    "smac_speedhack",
    "smac_spinhack"
  ].map((name) => resolve(smac, "plugins", `${name}.smx`)),
  resolve(smac, "translations/smac.phrases.txt")
]) {
  await access(required);
}

await cp(metamod, game, { recursive: true, force: true });
await cp(sourcemod, game, { recursive: true, force: true });
await mkdir(resolve(game, "addons/sourcemod/plugins"), { recursive: true });
await cp(plugin, resolve(game, "addons/sourcemod/plugins/aftertick_match.smx"), { force: true });
await cp(noLobbyPlugin, resolve(game, "addons/sourcemod/plugins/nolobbyreservation.smx"), { force: true });
await mkdir(resolve(game, "addons/sourcemod/gamedata"), { recursive: true });
await cp(
  noLobbyGameData,
  resolve(game, "addons/sourcemod/gamedata/nolobbyreservation.games.txt"),
  { force: true }
);
await mkdir(resolve(game, "addons/sourcemod/extensions"), { recursive: true });
await cp(
  steamFixExtension,
  resolve(game, "addons/sourcemod/extensions/csgo_steamfix.ext.dll"),
  { force: true }
);
await cp(
  steamFixAutoload,
  resolve(game, "addons/sourcemod/extensions/csgo_steamfix.autoload"),
  { force: true }
);
await cp(resolve(smac, "plugins"), resolve(game, "addons/sourcemod/plugins"), { recursive: true, force: true });
await mkdir(resolve(game, "addons/sourcemod/translations"), { recursive: true });
await cp(resolve(smac, "translations/smac.phrases.txt"), resolve(game, "addons/sourcemod/translations/smac.phrases.txt"), { force: true });
// Older plugin builds recorded ephemeral match/roster ConVars here and reset
// active manifests after each map load. The current DONTRECORD declarations
// regenerate a safe file containing only operator-tunable defaults.
await rm(resolve(game, "cfg/sourcemod/aftertick_match.cfg"), { force: true });
await mkdir(resolve(game, "cfg"), { recursive: true });
await mkdir(resolve(game, "cfg/sourcemod"), { recursive: true });
await cp(config, resolve(game, "cfg/aftertick-server.cfg"), { force: true });
await cp(smacConfig, resolve(game, "cfg/sourcemod/smac.cfg"), { force: true });
await writeFile(
  resolve(game, "cfg/aftertick-secrets.cfg"),
  `rcon_password "${rconPassword}"\nsv_password "${idlePassword}"\n`,
  { encoding: "utf8", mode: 0o600 }
);

// SteamCMD App 740 remains the distribution channel for the final CS:GO
// Source 1 dedicated-server payload. The 2026 standalone client authenticates
// as App 4465480, so both server identity files must be reapplied after every
// SteamCMD validation before SRCDS starts.
const standaloneAppId = "4465480";
const steamInfoPath = resolve(game, "steam.inf");
const steamInfo = await readFile(steamInfoPath, "utf8");
if (!/^appID=\d+[^\S\r\n]*$/m.test(steamInfo)) {
  throw new Error("The dedicated server steam.inf has no patchable appID entry.");
}
await writeFile(
  steamInfoPath,
  steamInfo.replace(/^appID=\d+[^\S\r\n]*$/m, `appID=${standaloneAppId}`),
  "utf8"
);
await writeFile(resolve(server, "steam_appid.txt"), standaloneAppId, "utf8");

console.log("Provisioned AppID 4465480, archived-client Steam ticket patch, direct-connect lobby patch, MetaMod, SourceMod, B2G match control, evidence-only SMAC, and credential-backed server config.");
