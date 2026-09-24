import { spawn, type ChildProcess } from "node:child_process";
import { isOwnershipGeneration } from "@aftertick/contracts";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentConfig } from "./config.js";
import { MatchDemoUploader, type DemoUploader } from "./demo-uploader.js";
import {
  MatchEventPump,
  type EventPump,
  type ProgressionReceipt
} from "./event-pump.js";
import { canonicalJson, verifyManifestSignature, type AgentMatchManifest } from "./manifest.js";
import { UdpLatencyProbeServer, type LatencyProbeServer } from "./latency-probe-server.js";
import { sendRcon } from "./rcon.js";
import { NODE_VERSION } from "./version.js";
import { writeOwnershipGenerations } from "./ownership-generations.js";

export interface AgentCommand {
  id: string;
  commandType: "start" | "stop" | "prepare" | "sync-roster" | "sync-inventory" | "announce-drop" | "drain" | "quarantine" | "unquarantine";
  payload: Record<string, unknown>;
  claimToken: string;
}

export interface AgentDependencies {
  fetch: typeof fetch;
  rcon: typeof sendRcon;
  spawnServer: (executable: string, args: string[], cwd: string) => ChildProcess;
  eventPump?: EventPump | undefined;
  demoUploader?: DemoUploader | undefined;
  latencyProbeServer?: LatencyProbeServer | undefined;
}

const MAPS: Record<string, string> = {
  Mirage: "de_mirage",
  Inferno: "de_inferno",
  Nuke: "de_nuke",
  Overpass: "de_overpass",
  Vertigo: "de_vertigo",
  Ancient: "de_ancient",
  Anubis: "de_anubis",
  "Dust II": "de_dust2"
};

const MAX_OWNED_ITEMS_PER_PLAYER = 512;

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}

function signedSteamAccountId(steamId: string): number {
  const accountId = Number(BigInt(steamId) & 0xffff_ffffn);
  return accountId > 0x7fff_ffff ? accountId - 0x1_0000_0000 : accountId;
}

function validCosmetics(manifest: AgentMatchManifest): boolean {
  const rosterByPlayer = new Map(manifest.roster.map((member) => [member.playerId, member.steamId]));
  return (manifest.cosmetics ?? []).length <= manifest.roster.length
    && new Set((manifest.cosmetics ?? []).map((loadout) => loadout.playerId)).size === (manifest.cosmetics ?? []).length
    && new Set((manifest.cosmetics ?? []).map((loadout) => loadout.steamId)).size === (manifest.cosmetics ?? []).length
    && (manifest.cosmetics ?? []).every((loadout) =>
      rosterByPlayer.get(loadout.playerId) === loadout.steamId
      && /^\d{17}$/.test(loadout.steamId)
      && loadout.items.length <= MAX_OWNED_ITEMS_PER_PLAYER
      && new Set(loadout.items.map((item) => item.assetId)).size === loadout.items.length
      && loadout.items.every((item) =>
        /^\d{1,20}$/.test(item.assetId)
        && isOwnershipGeneration(item.ownershipGeneration ?? "0")
        && (item.source === "steam" || item.source === "b2g")
        && (item.itemKind === "cosmetic" || item.itemKind === "case" || item.itemKind === "key")
        && (item.source !== "steam" || item.itemKind === "cosmetic")
        && Number.isInteger(item.definitionIndex)
        && item.definitionIndex >= 1
        && item.definitionIndex <= 65_535
        && /^[a-z0-9_]{2,32}$/.test(item.weaponKey)
        && isUint32(item.inventoryPosition)
        && (item.paintIndex === null || isUint32(item.paintIndex))
        && (item.paintWear === null
          || (Number.isFinite(item.paintWear) && item.paintWear >= 0 && item.paintWear <= 1))
        && (item.paintSeed === null || isUint32(item.paintSeed))
        && isUint32(item.quality)
        && isUint32(item.rarity)
        && isUint32(item.origin)
        && (item.killEaterScoreType === null || isUint32(item.killEaterScoreType))
        && (item.killEaterValue === null || isUint32(item.killEaterValue))
        && (item.customName === null
          || (item.customName.length >= 1
            && item.customName.length <= 100
            && !/[\u0000-\u001f\u007f]/.test(item.customName)))
        && (item.sprayKitId == null || isUint32(item.sprayKitId))
        && (item.sprayTintId == null || (Number.isInteger(item.sprayTintId)
          && item.sprayTintId >= 1 && item.sprayTintId <= 19))
        && (item.spraysRemaining == null || (Number.isInteger(item.spraysRemaining)
          && item.spraysRemaining >= 1 && item.spraysRemaining <= 50))
        && Number.isInteger(item.loadoutSlot)
        && item.loadoutSlot >= 0
        && item.loadoutSlot <= 63
        && typeof item.equipped === "boolean"
        && (!item.equipped || item.itemKind === "cosmetic")
        && Array.isArray(item.stickers)
        && item.stickers.length <= 6
        && new Set(item.stickers.map((sticker) => sticker.slot)).size === item.stickers.length
        && item.stickers.every((sticker) =>
          Number.isInteger(sticker.slot)
          && sticker.slot >= 0
          && sticker.slot <= 5
          && isUint32(sticker.stickerId)
          && (sticker.wear === null
            || (Number.isFinite(sticker.wear) && sticker.wear >= 0 && sticker.wear <= 1))
          && (sticker.scale === null && sticker.rotation === null
            || (sticker.scale === null || (Number.isFinite(sticker.scale) && sticker.scale >= 0 && sticker.scale <= 100))
              && (sticker.rotation === null || (Number.isFinite(sticker.rotation)
                && sticker.rotation >= -360 && sticker.rotation <= 360)))
        )
      )
    );
}

function kv(value: string | number | boolean): string {
  const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function itemAttributes(item: NonNullable<AgentMatchManifest["cosmetics"]>[number]["items"][number]): Array<[number, number]> {
  const attributes: Array<[number, number]> = [
    ...(item.paintIndex === null ? [] : [[6, item.paintIndex] as [number, number]]),
    ...(item.paintSeed === null ? [] : [[7, item.paintSeed] as [number, number]]),
    ...(item.paintWear === null ? [] : [[8, item.paintWear] as [number, number]]),
    ...(item.killEaterValue === null ? [] : [[80, item.killEaterValue] as [number, number]]),
    ...(item.killEaterScoreType === null ? [] : [[81, item.killEaterScoreType] as [number, number]]),
    ...(item.sprayKitId == null ? [] : [[113, item.sprayKitId] as [number, number]]),
    ...(item.spraysRemaining == null ? [] : [[232, item.spraysRemaining] as [number, number]]),
    ...(item.sprayTintId == null ? [] : [[233, item.sprayTintId] as [number, number]])
  ];
  for (const sticker of item.stickers) {
    const base = 113 + sticker.slot * 4;
    attributes.push([base, sticker.stickerId]);
    if (sticker.wear !== null) attributes.push([base + 1, sticker.wear]);
    if (sticker.scale !== null) attributes.push([base + 2, sticker.scale]);
    if (sticker.rotation !== null) attributes.push([base + 3, sticker.rotation]);
  }
  return attributes.sort((left, right) => left[0] - right[0]);
}

export function ownedInventoryPolicy(manifest: AgentMatchManifest): string {
  if (!validCosmetics(manifest)) throw new Error("Manifest cosmetics are not exact ownership-bound roster data.");
  const lines = [
    `${kv("format_version")} ${kv(1)}`,
    `${kv("match_id")} ${kv(manifest.matchId)}`,
    `${kv("lease_id")} ${kv(manifest.leaseId)}`,
    `${kv("fencing_token")} ${kv(manifest.fencingToken)}`,
    `${kv("manifest_revision")} ${kv(manifest.manifestRevision ?? 0)}`,
    `${kv("manifest_sha256")} ${kv(createHash("sha256").update(canonicalJson(manifest)).digest("hex"))}`,
    `${kv("expires_at")} ${kv(manifest.expiresAt)}`,
    kv("players"), "{"
  ];
  for (const player of manifest.cosmetics ?? []) {
    lines.push(`  ${kv(player.steamId)}`, "  {", `    ${kv("items")}`, "    {");
    for (const item of player.items) {
      lines.push(
        `      ${kv(item.assetId)}`, "      {",
        `        ${kv("inventory")} ${kv(item.inventoryPosition)}`,
        `        ${kv("def_index")} ${kv(item.definitionIndex)}`,
        `        ${kv("source")} ${kv(item.source)}`,
        `        ${kv("ownership_generation")} ${kv(item.ownershipGeneration ?? "0")}`,
        `        ${kv("item_kind")} ${kv(item.itemKind)}`,
        `        ${kv("level")} ${kv(1)}`,
        `        ${kv("quality")} ${kv(item.quality)}`,
        `        ${kv("flags")} ${kv(0)}`,
        `        ${kv("origin")} ${kv(item.origin)}`,
        `        ${kv("custom_name")} ${kv(item.customName ?? "")}`,
        `        ${kv("in_use")} ${kv(0)}`,
        `        ${kv("rarity")} ${kv(item.rarity)}`,
        `        ${kv("loadout_slot")} ${kv(item.loadoutSlot)}`,
        `        ${kv("attributes")}`, "        {"
      );
      for (const [definitionIndex, value] of itemAttributes(item)) {
        lines.push(`          ${kv(definitionIndex)} ${kv(value)}`);
      }
      lines.push("        }", `        ${kv("equipped_state")}`, "        {");
      if (item.equipped) {
        if (item.loadoutSlot === 55) {
          lines.push(`          ${kv(0)} ${kv(55)}`);
        } else {
          lines.push(`          ${kv(2)} ${kv(item.loadoutSlot)}`, `          ${kv(3)} ${kv(item.loadoutSlot)}`);
        }
      }
      lines.push("        }", "      }");
    }
    lines.push("    }", "  }");
  }
  lines.push("}", "");
  return lines.join("\n");
}

async function writeOwnedInventoryPolicy(serverRoot: string, manifest: AgentMatchManifest): Promise<void> {
  if (manifest.cosmetics === undefined) return;
  const directory = join(serverRoot, "csgo_gc");
  const target = join(directory, "b2g_owned_manifest.txt");
  const staged = `${target}.staged`;
  await mkdir(directory, { recursive: true });
  await writeFile(staged, ownedInventoryPolicy(manifest), { encoding: "utf8", mode: 0o600 });
  await rename(staged, target);
  await writeOwnershipGenerations(serverRoot, manifest);
}

async function writtenInventoryAuthority(serverRoot: string, active: AgentMatchManifest): Promise<{
  revision: number; digest: string;
} | null> {
  const policy = await readFile(join(serverRoot, "csgo_gc", "b2g_owned_manifest.txt"), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (policy === null) return null;
  const header = (name: string) => policy.match(new RegExp(`^"${name}" "([^"\\r\\n]*)"$`, "m"))?.[1];
  if (header("match_id") !== active.matchId || header("lease_id") !== active.leaseId
    || header("fencing_token") !== active.fencingToken) return null;
  const revision = Number(header("manifest_revision"));
  const digest = header("manifest_sha256");
  if (!Number.isSafeInteger(revision) || revision < 0 || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Persisted inventory authority metadata is invalid.");
  }
  return { revision, digest };
}

function safeValue(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`Manifest ${label} is invalid.`);
  return value;
}

interface ServerMatchConfiguration {
  fence: bigint;
  matchId: string;
  demoName: string;
  command: string;
  runtimeCommand: string;
}

function serverMatchConfiguration(
  manifest: AgentMatchManifest,
  serverAddress: string
): ServerMatchConfiguration {
  if (manifest.manifestVersion !== 1 || new Date(manifest.expiresAt).getTime() <= Date.now()) {
    throw new Error("Match manifest is expired or unsupported.");
  }
  if (manifest.serverAddress !== serverAddress) {
    throw new Error("Manifest targets a different server instance.");
  }
  if (
    manifest.integrityPolicy?.protocolVersion !== 1
    || manifest.integrityPolicy.provider !== "none"
    || manifest.integrityPolicy.enforcement !== "disabled"
  ) {
    throw new Error("Manifest integrity policy is unsupported.");
  }
  const mode = manifest.mode ?? "competitive";
  const alpha = manifest.roster.filter((member) => member.team === "alpha");
  const bravo = manifest.roster.filter((member) => member.team === "bravo");
  const ffa = manifest.roster.filter((member) => member.team === "ffa");
  if (!validCosmetics(manifest)) {
    throw new Error("Manifest cosmetics are not ownership-bound roster data.");
  }
  if (mode === "competitive") {
    if (manifest.roster.length !== 10 || alpha.length !== 5 || bravo.length !== 5 || ffa.length !== 0) {
      throw new Error("Competitive manifests must contain two teams of five players.");
    }
  } else if (
    manifest.roster.length < 1
    || manifest.roster.length > 14
    || ffa.length !== manifest.roster.length
    || alpha.length !== 0
    || bravo.length !== 0
    || manifest.fragLimit !== 40
    || manifest.timeLimitSeconds !== 600
  ) {
    throw new Error("Deathmatch manifests must contain 1-14 FFA players with a 40-frag, 600-second ruleset.");
  }
  const steamPattern = /^\d{17}$/;
  const alphaSteam = alpha.map((member) => safeValue(member.steamId, steamPattern, "Steam ID"));
  const bravoSteam = bravo.map((member) => safeValue(member.steamId, steamPattern, "Steam ID"));
  const ffaSteam = ffa.map((member) => safeValue(member.steamId, steamPattern, "Steam ID"));
  const matchId = safeValue(manifest.matchId, /^[a-f0-9-]{36}$/i, "match ID");
  const serverPassword = safeValue(
    manifest.serverPassword,
    /^[a-zA-Z0-9_-]{16,128}$/,
    "server password"
  );
  const map = MAPS[manifest.map];
  if (!map) throw new Error("Manifest map is not supported.");
  const demoName = safeValue(`aftertick-${matchId}`, /^[a-zA-Z0-9-]+$/, "demo name");
  return {
    fence: BigInt(manifest.fencingToken),
    matchId,
    demoName,
    command: [
      `aftertick_match_id ${matchId}`,
      `aftertick_mode ${mode}`,
      `aftertick_roster_t ${alphaSteam.join(",")}`,
      `aftertick_roster_ct ${bravoSteam.join(",")}`,
      `aftertick_roster_ffa ${ffaSteam.join(",")}`,
      `game_type ${mode === "deathmatch" ? 1 : 0}`,
      `game_mode ${mode === "deathmatch" ? 2 : 1}`,
      `sv_password ${serverPassword}`,
      `changelevel ${map}`
    ].join("; "),
    runtimeCommand: mode === "deathmatch"
      ? "bot_quota 14; bot_quota_mode fill; bot_auto_vacate 1; "
        + "bot_join_after_player 0; mp_limitteams 0; mp_autoteambalance 0"
      : "bot_quota 0; bot_quota_mode normal; bot_auto_vacate 0; "
        + "bot_join_after_player 0; bot_kick"
  };
}

export class GameNodeAgent {
  private state: "starting" | "ready" | "draining" | "offline" = "offline";
  // The control plane owns process demand. A service restart must not revive an
  // idle or released match merely because the agent itself came back online.
  private desiredRunning = false;
  private quarantined = false;
  private child: ChildProcess | null = null;
  private serverPid: number | null = null;
  private highestFencingToken = 0n;
  private consecutiveRconFailures = 0;
  private lastRconSuccessAt: string | null = null;
  private lastRconFailureAt: string | null = null;
  private recoveryChecked = false;
  private readonly eventPump: EventPump;
  private readonly demoUploader: DemoUploader;
  private readonly latencyProbeServer: LatencyProbeServer;

  constructor(
    private readonly config: AgentConfig,
    private readonly dependencies: AgentDependencies = {
      fetch,
      rcon: sendRcon,
      spawnServer(executable, args, cwd) {
        return spawn(executable, args, {
          cwd,
          windowsHide: true,
          detached: false,
          // SRCDS treats a closed console stdin as a clean quit; keep the hidden
          // pipe open while the agent owns the process.
          stdio: ["pipe", "pipe", "pipe"]
        });
      }
    }
  ) {
    this.eventPump = dependencies.eventPump ?? new MatchEventPump(config, dependencies.fetch);
    this.demoUploader = dependencies.demoUploader ?? new MatchDemoUploader(config, dependencies.fetch);
    this.latencyProbeServer = dependencies.latencyProbeServer
      ?? new UdpLatencyProbeServer(config.host, config.latencyProbePort);
  }

  async heartbeat(): Promise<void> {
    await this.refreshState();
    try {
      await this.eventPump.flush();
    } catch (error) {
      console.error("Node-agent event upload error:", error instanceof Error ? error.message : error);
    }
    let deferTerminalDrain = await this.eventPump.hasPendingTerminal?.() ?? false;
    if (deferTerminalDrain) {
      // A terminal result may have reached the API even when its response was
      // lost. Keep heartbeating for recovery work, but ask the control plane not
      // to claim a resulting drain until the retry returns its XP receipt.
    } else {
      try {
        await this.presentPendingProgression();
      } catch (error) {
        deferTerminalDrain = true;
        console.error(
          "Node-agent progression presentation error:",
          error instanceof Error ? error.message : error
        );
      }
    }
    const activeManifest = await this.eventPump.manifest();
    const response = await this.dependencies.fetch(`${this.config.apiUrl}/api/node/v1/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.nodeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        agentVersion: NODE_VERSION,
        capacityTotal: 1,
        deferTerminalDrain,
        metadata: {
          inventorySyncVersion: 1,
          platform: process.platform,
          architecture: process.arch,
          latencyProbePort: this.config.latencyProbePort,
          eventIngestion: this.eventPump.metrics?.() ?? null
        },
        instances: [{
          instanceKey: this.config.instanceKey,
          state: this.quarantined ? "offline" : this.state,
          address: this.config.serverAddress,
          gamePort: this.config.gamePort,
          gotvPort: this.config.gotvPort,
          processId: this.serverPid ?? this.child?.pid,
          serverBuildId: this.config.serverBuildId,
          pluginVersion: this.config.pluginVersion,
          metadata: {
            srcdsHealth: {
              protocolVersion: 1,
              rconReachable: this.consecutiveRconFailures === 0,
              consecutiveRconFailures: this.consecutiveRconFailures,
              activeLeaseId: activeManifest?.leaseId ?? null,
              activeMatchId: activeManifest?.matchId ?? null,
              lastRconSuccessAt: this.lastRconSuccessAt,
              lastRconFailureAt: this.lastRconFailureAt,
              observedAt: new Date().toISOString()
            }
          }
        }]
      })
    });
    if (!response.ok) throw new Error(`Control-plane heartbeat failed with ${response.status}.`);
    const body = await response.json() as {
      commands: AgentCommand[];
      activeLeaseIds?: unknown;
    };
    await this.reconcilePersistedAuthority(
      body.activeLeaseIds,
      body.commands,
      deferTerminalDrain
    );
    for (const command of body.commands) {
      // A current control plane honors deferTerminalDrain before claiming. Keep
      // this guard for rolling deployment or a stale peer and leave the claim
      // unacknowledged so it can be recovered instead of destroying the server.
      if (deferTerminalDrain && command.commandType === "drain") continue;
      if (command.commandType === "drain") {
        // Independent ingestion may settle a result while the heartbeat HTTP
        // request is in flight. Recheck the serialized pump before a drain can
        // clear its newly arrived XP receipt.
        await this.eventPump.flush();
        if (await this.eventPump.hasPendingTerminal?.()) continue;
        try { await this.presentPendingProgression(); }
        catch (error) {
          console.error("Deferring drain until progression is presented:", error instanceof Error ? error.message : error);
          continue;
        }
      }
      await this.executeAndAcknowledge(command);
    }
    try {
      await this.eventPump.flush();
    } catch (error) {
      console.error("Node-agent event upload error:", error instanceof Error ? error.message : error);
    }
  }

  async execute(command: AgentCommand): Promise<Record<string, unknown>> {
    switch (command.commandType) {
      case "start":
        this.desiredRunning = true;
        await this.startServer();
        return { state: this.state, processId: this.serverPid ?? this.child?.pid ?? null };
      case "stop":
        this.desiredRunning = false;
        await this.tryRcon("quit");
        await this.waitForOwnedServerExit();
        await this.eventPump.flush();
        await this.eventPump.clear();
        this.recoveryChecked = true;
        this.state = "offline";
        return { state: this.state };
      case "prepare":
        return this.prepare(command.payload);
      case "sync-roster":
        return this.syncRoster(command.payload);
      case "sync-inventory":
        return this.syncRoster(command.payload, true);
      case "announce-drop":
        return this.announceDrop(command.payload);
      case "drain":
        if (this.state === "offline" && !this.child && !this.serverPid) {
          await this.eventPump.clear();
          this.recoveryChecked = true;
          return { state: "offline", abortEventObserved: false, alreadyStopped: true };
        }
        this.state = "draining";
        const terminalMatch = command.payload["reason"] === "match_completed"
          || command.payload["reason"] === "server_abort";
        let abortEventObserved = false;
        if (terminalMatch) {
          // The control plane emits terminal drains after either accepting a
          // settled result or durably ingesting a plugin-originated abort. Flush
          // once more before clearing local state, but do not ask an already-ended
          // or already-aborted plugin to emit an impossible second abort event.
          await this.eventPump.flush();
        } else {
          // RCON plugin commands may execute after later convar commands from the
          // same packet. Keep the signed match ID intact until the abort event is
          // durably uploaded.
          const observed = this.eventPump.observedSequence?.("match.aborted") ?? 0;
          await this.tryRcon("sm_aftertick_abort");
          abortEventObserved = await this.waitForPluginEvent("match.aborted", 2_000, observed);
        }
        await this.tryRcon("tv_stoprecord");
        const manifest = await this.eventPump.manifest();
        let demo = null;
        let demoUploadFailed = false;
        if (manifest) {
          try {
            demo = await this.demoUploader.upload(manifest);
          } catch (error) {
            if (!terminalMatch) throw error;
            // A terminal match must release its process and capacity even when
            // evidence storage is temporarily unavailable. The finalized demo
            // remains on disk for operator recovery, while the failed upload is
            // surfaced in the command result and node logs.
            demoUploadFailed = true;
            console.error(
              "Terminal GOTV demo upload failed; stopping SRCDS anyway:",
              error instanceof Error ? error.message : error
            );
          }
        }
        if (terminalMatch) {
          this.desiredRunning = false;
          await this.tryRcon("quit");
          await this.waitForOwnedServerExit();
          await this.eventPump.clear();
          this.recoveryChecked = true;
          this.state = "offline";
          return {
            state: this.state,
            abortEventObserved,
            terminalMatch,
            demo,
            ...(demoUploadFailed ? { demoUploadFailed: true } : {})
          };
        }
        await this.tryRcon(
          "aftertick_match_id \"\"; aftertick_mode competitive; aftertick_roster_t \"\"; "
          + "aftertick_roster_ct \"\"; aftertick_roster_ffa \"\"; "
          + `bot_quota 0; bot_kick; sv_password ${this.config.idlePassword}; mp_restartgame 1`
        );
        await this.eventPump.clear();
        this.recoveryChecked = true;
        this.state = "ready";
        return { state: this.state, abortEventObserved, terminalMatch, demo };
      case "quarantine":
        this.quarantined = true;
        await this.tryRcon(`sm_aftertick_abort; sv_password ${this.config.idlePassword}`);
        return { state: "quarantined" };
      case "unquarantine":
        this.quarantined = false;
        await this.tryRcon(`sv_password ${this.config.idlePassword}`);
        await this.refreshState();
        return { state: this.state };
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.latencyProbeServer.start();
    const stopIngestion = new AbortController();
    const ingestion = this.eventPump.run?.(AbortSignal.any([signal, stopIngestion.signal]));
    try {
      while (!signal.aborted) {
        try {
          if (this.desiredRunning && this.state === "offline" && !this.child) {
            await this.startServer();
          }
          await this.heartbeat();
        } catch (error) {
          console.error("Node-agent heartbeat error:", error instanceof Error ? error.message : error);
        }
        try { await delay(this.config.heartbeatMs, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    } finally {
      stopIngestion.abort();
      await ingestion;
      await this.latencyProbeServer.stop();
    }
  }

  private async prepare(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const manifest = payload["manifest"] as AgentMatchManifest | undefined;
    const signature = payload["signature"];
    if (!manifest || typeof signature !== "string") throw new Error("Prepare command has no signed manifest.");
    if (!verifyManifestSignature(manifest, signature, this.config.manifestSigningSecret)) {
      throw new Error("Match manifest signature is invalid.");
    }
    const configuration = serverMatchConfiguration(manifest, this.config.serverAddress);
    if (configuration.fence <= this.highestFencingToken) {
      throw new Error("Stale lease fencing token rejected.");
    }

    await writeOwnedInventoryPolicy(this.config.serverRoot, manifest);
    await this.eventPump.begin(manifest);

    const observed = this.eventPump.observedSequence?.("match.warmup") ?? 0;
    await this.dependencies.rcon({
      host: this.config.host,
      port: this.config.gamePort,
      password: this.config.rconPassword,
      command: configuration.command
    });
    await this.waitForPluginEvent("match.warmup", 15_000, observed);
    await this.dependencies.rcon({
      host: this.config.host,
      port: this.config.gamePort,
      password: this.config.rconPassword,
      command: configuration.runtimeCommand
    });
    const recording = await this.dependencies.rcon({
      host: this.config.host,
      port: this.config.gamePort,
      password: this.config.rconPassword,
      command: `tv_record ${configuration.demoName}`
    });
    if (/already recording|not active|failed|error/i.test(recording)) {
      throw new Error(`GOTV recording could not start: ${recording.trim()}`);
    }
    this.highestFencingToken = configuration.fence;
    this.recoveryChecked = true;
    this.state = "ready";
    return {
      prepared: true,
      matchId: configuration.matchId,
      fencingToken: String(configuration.fence)
    };
  }

  private async syncRoster(payload: Record<string, unknown>, inventorySync = false): Promise<Record<string, unknown>> {
    const manifest = payload["manifest"] as AgentMatchManifest | undefined;
    const signature = payload["signature"];
    if (!manifest || typeof signature !== "string") {
      throw new Error("Roster synchronization has no signed manifest.");
    }
    if (!verifyManifestSignature(manifest, signature, this.config.manifestSigningSecret)) {
      throw new Error("Roster synchronization signature is invalid.");
    }
    const active = await this.eventPump.manifest();
    if (!active) throw new Error("Roster synchronization has no active match.");
    if (
      manifest.manifestVersion !== 1
      || !Number.isFinite(Date.parse(manifest.expiresAt))
      || new Date(manifest.expiresAt).getTime() <= Date.now()
      || (!inventorySync && manifest.mode !== "deathmatch")
      || manifest.matchId !== active.matchId
      || manifest.leaseId !== active.leaseId
      || manifest.fencingToken !== active.fencingToken
      || manifest.serverInstanceId !== active.serverInstanceId
      || manifest.serverAddress !== this.config.serverAddress
    ) {
      throw new Error("Roster synchronization does not match the active fenced match lease.");
    }
    const immutable = (value: AgentMatchManifest) => {
      const { cosmetics, roster, issuedAt, manifestRevision, ...rest } = value;
      return canonicalJson(rest);
    };
    if (immutable(manifest) !== immutable(active) || !validCosmetics(manifest)) {
      throw new Error("Synchronization cannot replace match configuration or supply invalid inventory.");
    }
    // The policy rename may have succeeded before a roster RCON call or state
    // persistence failed. Its atomic revision/hash headers are a durable
    // high-water mark too; retries must not roll that file back after a restart.
    const written = await writtenInventoryAuthority(this.config.serverRoot, active);
    if (inventorySync || manifest.manifestRevision !== undefined || active.manifestRevision !== undefined
      || (written?.revision ?? 0) > 0) {
      const revision = manifest.manifestRevision;
      const activeRevision = active.manifestRevision ?? 0;
      if (!Number.isSafeInteger(revision) || Number(revision) < 1
        || !Number.isSafeInteger(activeRevision) || activeRevision < 0) {
        throw new Error("Synchronization requires a positive monotonic manifest revision.");
      }
      const highestRevision = Math.max(activeRevision, written?.revision ?? 0);
      if (Number(revision) < highestRevision) {
        return { synchronized: true, superseded: true, manifestRevision: highestRevision };
      }
      if (written && revision === written.revision
        && createHash("sha256").update(canonicalJson(manifest)).digest("hex") !== written.digest) {
        throw new Error("Synchronization revision conflicts with the written inventory policy.");
      }
      if (revision === activeRevision) {
        if (canonicalJson(manifest) !== canonicalJson(active)) {
          throw new Error("Synchronization revision conflicts with the active manifest.");
        }
        // Reassert the trusted file on retry/recovery without replaying roster
        // commands or resetting the event cursor.
        await writeOwnedInventoryPolicy(this.config.serverRoot, manifest);
        return { synchronized: true, alreadyApplied: true, manifestRevision: revision };
      }
    }
    const rosterChanged = canonicalJson(manifest.roster) !== canonicalJson(active.roster);
    if (
      (rosterChanged || !inventorySync) && (manifest.mode !== "deathmatch"
      || manifest.roster.length < 1 || manifest.roster.length > 14
      || new Set(manifest.roster.map((member) => member.playerId)).size !== manifest.roster.length
      || new Set(manifest.roster.map((member) => member.steamId)).size !== manifest.roster.length
      || manifest.roster.some((member) => member.team !== "ffa" || !/^\d{17}$/.test(member.steamId))
      || active.roster.some((member, index) => {
        const next = manifest.roster[index];
        return next?.playerId !== member.playerId || next.steamId !== member.steamId || next.team !== member.team;
      }))
    ) {
      throw new Error("Deathmatch roster synchronization must be an append-only 1-14 player roster.");
    }

    const ffaSteam = manifest.roster.map((member) => member.steamId);
    await writeOwnedInventoryPolicy(this.config.serverRoot, manifest);
    if (rosterChanged || !inventorySync) {
      const observed = this.eventPump.observedSequence?.("roster.synced") ?? 0;
      await this.dependencies.rcon({
        host: this.config.host,
        port: this.config.gamePort,
        password: this.config.rconPassword,
        command: `aftertick_roster_ffa ${ffaSteam.join(",")}; sm_aftertick_sync_roster`
      });
      await this.waitForPluginEvent("roster.synced", 2_000, observed);
    }
    await this.eventPump.updateManifest(manifest);
    return {
      synchronized: true,
      ...(inventorySync ? { inventorySynchronized: true } : {}),
      ...(manifest.manifestRevision === undefined ? {} : { manifestRevision: manifest.manifestRevision }),
      matchId: manifest.matchId,
      fencingToken: manifest.fencingToken,
      humanPlayers: manifest.roster.length
    };
  }

  private async announceDrop(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const matchId = payload["matchId"];
    const steamId = payload["steamId"];
    const itemName = payload["itemName"];
    const rarity = payload["rarity"];
    const quality = payload["quality"];
    if (typeof matchId !== "string" || !/^[a-f0-9-]{36}$/i.test(matchId)
      || typeof steamId !== "string" || !/^\d{17}$/.test(steamId)
      || typeof itemName !== "string" || !/^[A-Za-z0-9 |'().:+_\-]{1,160}$/.test(itemName)
      || !Number.isInteger(rarity) || Number(rarity) < 1 || Number(rarity) > 7
      || !Number.isInteger(quality) || Number(quality) < 0 || Number(quality) > 12) {
      throw new Error("Drop announcement payload is invalid.");
    }
    const active = await this.eventPump.manifest();
    if (!active || active.matchId !== matchId
      || !active.roster.some((member) => member.steamId === steamId)) {
      throw new Error("Drop announcement does not belong to the active rostered match.");
    }
    const response = await this.dependencies.rcon({
      host: this.config.host,
      port: this.config.gamePort,
      password: this.config.rconPassword,
      command: `sm_aftertick_announce_drop ${steamId} ${rarity} ${quality} "${itemName}"`
    });
    if (!response.split(/\r?\n/).some((line) => line.trim() === "[B2G] Drop result announced.")) {
      throw new Error("The game server did not confirm the drop announcement (the recipient may have disconnected).");
    }
    return { announced: true, matchId, steamId };
  }

  private async startServer(): Promise<void> {
    try {
      await this.dependencies.rcon({
        host: this.config.host,
        port: this.config.gamePort,
        password: this.config.rconPassword,
        command: "status",
        timeoutMs: 1_000
      });
      this.state = "ready";
      await this.tryRestorePersistedMatch();
      return;
    } catch {
      // Start a missing process below.
    }
    const executable = join(this.config.serverRoot, "srcds.exe");
    await access(executable);
    this.state = "starting";
    const directArguments = [
      "-console", "-usercon", "-condebug", "-conclearlog", "-game", "csgo",
      "-ip", this.config.host,
      "-port", String(this.config.gamePort),
      "-maxplayers_override", "16",
      "-tickrate", "128",
      "+sv_lan", this.config.lanMode ? "1" : "0",
      "+exec", "aftertick-server.cfg",
      "+map", "de_dust2"
    ];
    if (this.config.lanMode) directArguments.push("-insecure");
    if (this.config.gsltToken) {
      directArguments.push("+sv_setsteamaccount", this.config.gsltToken);
    }
    const launchedChild = process.platform === "win32"
      ? this.dependencies.spawnServer("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-File", this.config.launcherScript,
          "-Executable", executable,
          "-WorkingDirectory", this.config.serverRoot,
          "-HostAddress", this.config.host,
          "-GamePort", String(this.config.gamePort),
          "-LanMode", this.config.lanMode ? "1" : "0",
          ...(this.config.gsltToken
            ? ["-SteamAccountToken", this.config.gsltToken]
            : [])
        ], this.config.serverRoot)
      : this.dependencies.spawnServer(executable, directArguments, this.config.serverRoot);
    this.child = launchedChild;
    if (process.platform !== "win32") this.serverPid = launchedChild.pid ?? null;
    let launchOutput = "";
    const capture = (chunk: Buffer | string) => {
      launchOutput = (launchOutput + chunk.toString()).slice(-32_768);
      const match = launchOutput.match(/AFTERTICK_PID=(\d+)/);
      if (this.child === launchedChild && match?.[1]) this.serverPid = Number(match[1]);
    };
    launchedChild.stdout?.on("data", capture);
    launchedChild.stderr?.on("data", capture);
    launchedChild.once("exit", (code, signal) => {
      if (launchOutput) {
        console.error(`SRCDS exited (${code ?? signal}):\n${launchOutput}`);
      }
      // A previous PowerShell wrapper can finish after a replacement SRCDS has
      // already started. Only the wrapper that is still owned by this agent may
      // clear current process identity or move the instance back to offline.
      if (this.child !== launchedChild) return;
      this.child = null;
      this.serverPid = null;
      this.recoveryChecked = false;
      this.state = "offline";
    });
  }

  private async waitForOwnedServerExit(timeoutMs = 15_000): Promise<void> {
    const ownedChild = this.child;
    if (!ownedChild || ownedChild.exitCode !== null || ownedChild.signalCode !== null) return;
    const exited = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ownedChild.off("exit", onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      ownedChild.once("exit", onExit);
      if (ownedChild.exitCode !== null || ownedChild.signalCode !== null) finish(true);
    });
    if (!exited && this.child === ownedChild) {
      throw new Error("SRCDS did not exit after the control plane requested shutdown.");
    }
  }

  private async refreshState(): Promise<void> {
    if (this.quarantined || this.state === "draining") return;
    try {
      await this.dependencies.rcon({
        host: this.config.host,
        port: this.config.gamePort,
        password: this.config.rconPassword,
        command: "status",
        timeoutMs: 750
      });
      this.consecutiveRconFailures = 0;
      this.lastRconSuccessAt = new Date().toISOString();
      this.state = "ready";
    } catch {
      this.consecutiveRconFailures += 1;
      this.lastRconFailureAt = new Date().toISOString();
      this.state = this.child ? "starting" : "offline";
    }
  }

  private async reconcilePersistedAuthority(
    activeLeaseIds: unknown,
    commands: AgentCommand[],
    deferTerminalDrain: boolean
  ): Promise<void> {
    // Compatibility with an older control plane during a rolling deployment:
    // do not alter local authority until the server explicitly supplies the
    // active-lease set.
    if (!Array.isArray(activeLeaseIds)) return;
    const manifest = await this.eventPump.manifest();
    if (!manifest) return;

    const active = activeLeaseIds.some((leaseId) => leaseId === manifest.leaseId);
    if (active) {
      this.desiredRunning = true;
      if (this.state === "ready") await this.tryRestorePersistedMatch();
      return;
    }

    // A settled result releases the control-plane lease before its drain is
    // delivered. Preserve the manifest until any pending XP receipt is shown
    // in game and the matching drain command can upload the demo and terminate
    // SRCDS itself. Treating the released lease as abandoned here races that
    // ordered shutdown and loses both evidence and its acknowledgement.
    const matchingDrain = commands.some((command) =>
      command.commandType === "drain"
      && command.payload["leaseId"] === manifest.leaseId
    );
    if (deferTerminalDrain || matchingDrain) return;

    this.desiredRunning = false;
    if (this.state === "ready") {
      await this.tryRcon("quit");
      await this.waitForOwnedServerExit();
    }
    await this.eventPump.clear();
    this.recoveryChecked = true;
    this.state = "offline";
    console.error("Node agent discarded a persisted match whose control-plane lease is no longer active.");
  }

  private async tryRestorePersistedMatch(): Promise<void> {
    try {
      await this.restorePersistedMatch();
    } catch (error) {
      console.error(
        "Node agent could not restore the persisted match yet:",
        error instanceof Error ? error.message : error
      );
    }
  }

  private async restorePersistedMatch(): Promise<void> {
    if (this.recoveryChecked) return;
    const manifest = await this.eventPump.manifest();
    if (!manifest) {
      this.recoveryChecked = true;
      return;
    }

    let configuration: ServerMatchConfiguration;
    try {
      configuration = serverMatchConfiguration(manifest, this.config.serverAddress);
    } catch (error) {
      this.recoveryChecked = true;
      await this.tryRcon(
        "aftertick_match_id \"\"; aftertick_mode competitive; aftertick_roster_t \"\"; "
        + "aftertick_roster_ct \"\"; aftertick_roster_ffa \"\"; "
        + `bot_quota 0; bot_kick; sv_password ${this.config.idlePassword}`
      );
      await this.eventPump.clear();
      console.error(
        "Node agent discarded an invalid persisted match:",
        error instanceof Error ? error.message : error
      );
      return;
    }

    const observedMatch = await this.dependencies.rcon({
      host: this.config.host,
      port: this.config.gamePort,
      password: this.config.rconPassword,
      command: "aftertick_match_id"
    });
    this.highestFencingToken = configuration.fence;
    if (observedMatch.includes(configuration.matchId)) {
      this.recoveryChecked = true;
      return;
    }

    const observedWarmup = this.eventPump.observedSequence?.("match.warmup") ?? 0;
    await this.dependencies.rcon({
      host: this.config.host,
      port: this.config.gamePort,
      password: this.config.rconPassword,
      command: configuration.command
    });
    this.recoveryChecked = true;
    this.state = "ready";
    try {
      await this.waitForPluginEvent("match.warmup", 15_000, observedWarmup);
      await this.dependencies.rcon({
        host: this.config.host,
        port: this.config.gamePort,
        password: this.config.rconPassword,
        command: configuration.runtimeCommand
      });
      const recording = await this.dependencies.rcon({
        host: this.config.host,
        port: this.config.gamePort,
        password: this.config.rconPassword,
        command: `tv_record ${configuration.demoName}`
      });
      if (/already recording|not active|failed|error/i.test(recording)) {
        console.error(`GOTV recovery recording did not start: ${recording.trim()}`);
      }
    } catch (error) {
      console.error(
        "Node agent restored the active server credential but could not confirm all match services:",
        error instanceof Error ? error.message : error
      );
    }
  }

  private async tryRcon(command: string): Promise<void> {
    try {
      await this.dependencies.rcon({
        host: this.config.host,
        port: this.config.gamePort,
        password: this.config.rconPassword,
        command
      });
    } catch (error) {
      if (this.state !== "offline") throw error;
    }
  }

  private async presentPendingProgression(): Promise<void> {
    const progression = await this.eventPump.pendingProgression?.() ?? [];
    if (progression.length === 0) return;
    for (const entry of progression) {
      const output = await this.dependencies.rcon({
        host: this.config.host,
        port: this.config.gamePort,
        password: this.config.rconPassword,
        command: this.progressionCommand(entry)
      });
      if (!output.includes("[B2G_XP_OK]") && !output.includes("[B2G_XP_ABSENT]")) {
        throw new Error(`The game server did not acknowledge XP for ${entry.steamId}.`);
      }
    }
    await this.eventPump.acknowledgeProgression?.();
  }

  private progressionCommand(entry: ProgressionReceipt): string {
    return [
      "sm_aftertick_present_xp",
      kv(entry.steamId),
      kv(signedSteamAccountId(entry.steamId)),
      kv(entry.previousLevel),
      kv(entry.previousXp),
      kv(entry.earnedXp),
      kv(entry.xpCategory),
      kv(entry.nextLevel),
      kv(entry.nextXp),
      kv(entry.serviceDrop ? 1 : 0),
      kv(entry.serviceDrop?.serviceLevel ?? 0)
    ].join(" ");
  }

  private async waitForPluginEvent(eventType: string, timeoutMs = 2_000, observed = 0): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const uploaded = await this.eventPump.flush();
      if (uploaded.includes(eventType)
        || (this.eventPump.observedSequence?.(eventType) ?? 0) > observed) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for SourceMod event ${eventType}.`);
  }

  private async executeAndAcknowledge(command: AgentCommand): Promise<void> {
    let succeeded = false;
    let result: Record<string, unknown>;
    try {
      result = await this.execute(command);
      succeeded = true;
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    const response = await this.dependencies.fetch(
      `${this.config.apiUrl}/api/node/v1/commands/${encodeURIComponent(command.id)}/ack`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.nodeToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ claimToken: command.claimToken, succeeded, result })
      }
    );
    if (!response.ok) throw new Error(`Command acknowledgement failed with ${response.status}.`);
  }
}
