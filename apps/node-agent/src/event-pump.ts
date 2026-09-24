import { createHash } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";
import { signIngestion } from "./ingestion-signature.js";
import type { AgentMatchManifest } from "./manifest.js";
import { acceptCounterReceipt, writeCommittedCounters, type CommittedCounterState } from "./counter-receipt.js";

interface PluginEvent {
  version: 1;
  timestamp: number;
  matchId: string;
  type: string;
  payload: Record<string, unknown>;
}

interface PendingResult {
  resultVersion: 1;
  resultId: string;
  idempotencyKey: string;
  leaseId: string;
  fencingToken: string;
  alphaRounds: number;
  bravoRounds: number;
  reason: "completed" | "surrender" | "forfeit";
  completedAt: string;
  stats: Array<{
    steamId: string;
    kills: number;
    deaths: number;
    assists: number;
    adr: number;
    kast: number;
    openingKills: number;
    openingDeaths: number;
    trades: number;
    clutches: number;
    flashAssists: number;
    utilityDamage: number;
    roundsPlayed: number;
  }>;
}

export interface ProgressionReceipt {
  steamId: string;
  earnedXp: number;
  previousLevel: number;
  previousXp: number;
  nextLevel: number;
  nextXp: number;
  xpCategory: 1 | 2;
  serviceDrop: {
    id: string;
    serviceLevel: number;
    rewardType: "b2g_service_drop";
  } | null;
}

interface PumpState {
  version: 1;
  manifest: AgentMatchManifest;
  cursor: number;
  nextSequence: number;
  pendingResult: PendingResult | null;
  pendingProgression?: ProgressionReceipt[];
  fileIdentity?: string;
  committedCounters?: CommittedCounterState;
}

const compactStatKeys = [
  "kills",
  "deaths",
  "assists",
  "damage",
  "roundsPlayed",
  "kastRounds",
  "openingKills",
  "openingDeaths",
  "trades",
  "clutches",
  "flashAssists",
  "utilityDamage"
] as const;

function deterministicUuid(value: string): string {
  const characters = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  characters[12] = "5";
  characters[16] = ["8", "9", "a", "b"][parseInt(characters[16]!, 16) % 4]!;
  const hex = characters.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface EventPump {
  begin(manifest: AgentMatchManifest): Promise<void>;
  updateManifest(manifest: AgentMatchManifest): Promise<void>;
  flush(): Promise<string[]>;
  manifest(): Promise<AgentMatchManifest | null>;
  clear(): Promise<void>;
  hasPendingTerminal?(): Promise<boolean>;
  pendingProgression?(): Promise<ProgressionReceipt[]>;
  acknowledgeProgression?(): Promise<void>;
  run?(signal: AbortSignal): Promise<void>;
  observedSequence?(eventType: string): number;
  metrics?(): EventPumpMetrics | null;
}

export interface EventPumpMetrics {
  observedAt: string;
  events: number;
  bytesRead: number;
  uploadMs: number;
  flushMs: number;
}

const MAX_EVENT_READ_BYTES = 1024 * 1024;
const OBSERVED_EVENTS = new Set(["match.warmup", "roster.synced", "match.aborted"]);

export class MatchEventPump implements EventPump {
  private readonly eventPath: string;
  private readonly statePath: string;
  private state: PumpState | null = null;
  private loaded = false;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly observed = new Map<string, number>();
  private lastMetrics: EventPumpMetrics | null = null;

  // Background ingestion and lifecycle commands share a single state owner.
  // A rejected operation must not poison the queue or allow concurrent commits.
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => undefined);
    return next;
  }

  begin(manifest: AgentMatchManifest): Promise<void> {
    return this.serialize(() => this.beginExclusive(manifest));
  }
  updateManifest(manifest: AgentMatchManifest): Promise<void> {
    return this.serialize(() => this.updateManifestExclusive(manifest));
  }
  flush(): Promise<string[]> { return this.serialize(() => this.flushExclusive()); }
  clear(): Promise<void> { return this.serialize(() => this.clearExclusive()); }
  manifest(): Promise<AgentMatchManifest | null> { return this.serialize(() => this.manifestExclusive()); }
  hasPendingTerminal(): Promise<boolean> { return this.serialize(() => this.hasPendingTerminalExclusive()); }
  pendingProgression(): Promise<ProgressionReceipt[]> { return this.serialize(() => this.pendingProgressionExclusive()); }
  acknowledgeProgression(): Promise<void> { return this.serialize(() => this.acknowledgeProgressionExclusive()); }
  observedSequence(eventType: string): number { return this.observed.get(eventType) ?? 0; }
  metrics(): EventPumpMetrics | null { return this.lastMetrics ? { ...this.lastMetrics } : null; }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let waitMs = this.config.eventFlushMs ?? 100;
      try {
        await this.flush();
      } catch (error) {
        waitMs = Math.max(waitMs, 2_000);
        console.error("Node-agent event upload error:", error instanceof Error ? error.message : error);
      }
      try { await delay(waitMs, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }

  constructor(
    private readonly config: AgentConfig,
    private readonly request: typeof fetch = fetch
  ) {
    this.eventPath = join(
      config.serverRoot,
      "csgo",
      "addons",
      "sourcemod",
      "logs",
      "aftertick-events.jsonl"
    );
    this.statePath = join(config.serverRoot, ".aftertick-node-state.json");
  }

  private async beginExclusive(manifest: AgentMatchManifest): Promise<void> {
    if (typeof manifest.eventIngestSecret !== "string" || manifest.eventIngestSecret.length < 32) {
      throw new Error("Manifest has no valid event-ingestion secret.");
    }
    const file = await stat(this.eventPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    this.state = {
      version: 1,
      manifest,
      cursor: file?.size ?? 0,
      ...(file ? { fileIdentity: `${file.dev}:${file.ino}` } : {}),
      nextSequence: 1,
      pendingResult: null,
      pendingProgression: []
    };
    this.loaded = true;
    await this.persist();
  }

  private async updateManifestExclusive(manifest: AgentMatchManifest): Promise<void> {
    await this.load();
    if (!this.state) throw new Error("No active match manifest can be updated.");
    if (this.state.pendingResult) {
      throw new Error("A terminal result is already pending for this match.");
    }
    if (
      manifest.matchId !== this.state.manifest.matchId
      || manifest.leaseId !== this.state.manifest.leaseId
      || manifest.fencingToken !== this.state.manifest.fencingToken
    ) {
      throw new Error("A roster update cannot replace the active fenced match authority.");
    }
    this.state.manifest = manifest;
    await this.persist();
  }

  private async flushExclusive(): Promise<string[]> {
    const started = performance.now();
    await this.load();
    if (!this.state) return [];
    if (this.state.pendingResult) {
      await this.submitResult();
      if (this.state.pendingResult) return [];
    }

    const file = await open(this.eventPath, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!file) return [];
    let chunk: Buffer;
    try {
      const info = await file.stat();
      const identity = `${info.dev}:${info.ino}`;
      if (info.size < this.state.cursor
        || (this.state.fileIdentity !== undefined && this.state.fileIdentity !== identity)) {
        this.state.cursor = 0;
      }
      this.state.fileIdentity = identity;
      const buffer = Buffer.alloc(Math.min(MAX_EVENT_READ_BYTES, Math.max(0, info.size - this.state.cursor)));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.state.cursor);
      chunk = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    if (chunk.length === MAX_EVENT_READ_BYTES && !chunk.includes(0x0a)) {
      throw new Error("SourceMod event line exceeds the bounded 1 MiB reader.");
    }
    let position = 0;
    let consumed = 0;
    let nextSequence = this.state.nextSequence;
    const events: Array<{
      eventId: string;
      sequence: number;
      occurredAt: string;
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    let terminalResult: PendingResult | null = null;

    while (events.length < 100) {
      const newline = chunk.indexOf(0x0a, position);
      if (newline < 0) break;
      const absoluteOffset = this.state.cursor + position;
      const raw = chunk.subarray(position, newline).toString("utf8").trim();
      position = newline + 1;
      consumed = position;
      if (!raw) continue;
      let pluginEvent: PluginEvent;
      try {
        pluginEvent = JSON.parse(raw) as PluginEvent;
      } catch {
        console.error(`Node agent skipped malformed SourceMod event at byte ${absoluteOffset}.`);
        continue;
      }
      if (
        pluginEvent.version !== 1
        || pluginEvent.matchId !== this.state.manifest.matchId
        || typeof pluginEvent.timestamp !== "number"
        || typeof pluginEvent.type !== "string"
        || !pluginEvent.payload
      ) {
        continue;
      }
      const sequence = nextSequence++;
      events.push({
        eventId: deterministicUuid(`${this.state.manifest.leaseId}:${absoluteOffset}:${raw}`),
        sequence,
        occurredAt: new Date(pluginEvent.timestamp * 1000).toISOString(),
        type: pluginEvent.type,
        payload: pluginEvent.payload
      });
      if (
        pluginEvent.type === "match.ended"
        || pluginEvent.type === "match.surrendered"
        || pluginEvent.type === "match.forfeited"
      ) {
        terminalResult = this.buildResult(pluginEvent);
      }
    }

    const uploadStarted = performance.now();
    let uploadMs = 0;
    if (events.length > 0) {
      const body = {
        leaseId: this.state.manifest.leaseId,
        fencingToken: this.state.manifest.fencingToken,
        events
      };
      const response = await this.post("events", body);
      uploadMs = Math.round(performance.now() - uploadStarted);
      const outcome = await response.json() as Record<string, unknown>;
      const counters = acceptCounterReceipt(outcome, body, this.state.manifest, this.state.committedCounters);
      if (counters) {
        await writeCommittedCounters(this.config.serverRoot, this.state.manifest, counters);
        this.state.committedCounters = counters;
      }
    }
    if (consumed > 0) {
      const previous = this.state;
      this.state = { ...previous, cursor: previous.cursor + consumed, nextSequence,
        pendingResult: terminalResult ?? previous.pendingResult };
      try { await this.persist(); }
      catch (error) { this.state = previous; throw error; }
      for (const event of events) {
        if (OBSERVED_EVENTS.has(event.type))
          this.observed.set(event.type, this.observedSequence(event.type) + 1);
      }
    }
    if (this.state.pendingResult) await this.submitResult();
    if (events.length > 0) {
      this.lastMetrics = {
        observedAt: new Date().toISOString(), events: events.length, bytesRead: chunk.length,
        uploadMs,
        flushMs: Math.round(performance.now() - started)
      };
    }
    return events.map((event) => event.type);
  }

  private async clearExclusive(): Promise<void> {
    await this.load();
    this.state = null;
    this.loaded = true;
    await this.persist();
  }

  private async manifestExclusive(): Promise<AgentMatchManifest | null> {
    await this.load();
    return this.state?.manifest ?? null;
  }

  private async hasPendingTerminalExclusive(): Promise<boolean> {
    await this.load();
    return Boolean(this.state?.pendingResult);
  }

  private async pendingProgressionExclusive(): Promise<ProgressionReceipt[]> {
    await this.load();
    return [...(this.state?.pendingProgression ?? [])];
  }

  private async acknowledgeProgressionExclusive(): Promise<void> {
    await this.load();
    if (!this.state || (this.state.pendingProgression ?? []).length === 0) return;
    this.state.pendingProgression = [];
    await this.persist();
  }

  private buildResult(event: PluginEvent): PendingResult {
    const manifest = this.state!.manifest;
    const alphaRounds = Number(event.payload["tScore"]);
    const bravoRounds = Number(event.payload["ctScore"]);
    if (!Number.isInteger(alphaRounds) || !Number.isInteger(bravoRounds)) {
      throw new Error("SourceMod terminal event has an invalid score.");
    }
    const roundsPlayed = Math.max(1, alphaRounds + bravoRounds);
    const pluginStats = (Array.isArray(event.payload["stats"])
      ? event.payload["stats"]
      : []).flatMap((line): Array<Record<string, unknown>> => {
        if (Array.isArray(line) && typeof line[0] === "string") {
          return [{
            steamId: line[0],
            ...Object.fromEntries(compactStatKeys.map((key, index) => [key, line[index + 1]]))
          }];
        }
        return line && typeof line === "object" ? [line as Record<string, unknown>] : [];
      });
    const statsBySteamId = new Map(pluginStats.flatMap((line) =>
      typeof line["steamId"] === "string" ? [[line["steamId"], line] as const] : []
    ));
    const resultId = deterministicUuid(`${manifest.leaseId}:canonical-result`);
    return {
      resultVersion: 1,
      resultId,
      idempotencyKey: resultId,
      leaseId: manifest.leaseId,
      fencingToken: manifest.fencingToken,
      alphaRounds,
      bravoRounds,
      reason: event.type === "match.surrendered"
        ? "surrender"
        : event.type === "match.forfeited"
          ? "forfeit"
          : "completed",
      completedAt: new Date(event.timestamp * 1000).toISOString(),
      stats: manifest.roster.map((player) => {
        const line = statsBySteamId.get(player.steamId);
        const played = Math.max(1, this.integerStat(line, "roundsPlayed", roundsPlayed));
        const damage = this.integerStat(line, "damage", 0);
        const kastRounds = this.integerStat(line, "kastRounds", 0);
        return {
          steamId: player.steamId,
          kills: this.integerStat(line, "kills", 0),
          deaths: this.integerStat(line, "deaths", 0),
          assists: this.integerStat(line, "assists", 0),
          adr: Math.round((damage / played) * 10) / 10,
          kast: Math.round((kastRounds / played) * 1000) / 10,
          openingKills: this.integerStat(line, "openingKills", 0),
          openingDeaths: this.integerStat(line, "openingDeaths", 0),
          trades: this.integerStat(line, "trades", 0),
          clutches: this.integerStat(line, "clutches", 0),
          flashAssists: this.integerStat(line, "flashAssists", 0),
          utilityDamage: this.integerStat(line, "utilityDamage", 0),
          roundsPlayed: played
        };
      })
    };
  }

  private integerStat(
    line: Record<string, unknown> | undefined,
    key: string,
    fallback: number
  ): number {
    const value = Number(line?.[key]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async submitResult(): Promise<void> {
    const result = this.state!.pendingResult!;
    const response = await this.post("result", result);
    const outcome = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!outcome || (outcome["status"] !== "pending" && outcome["status"] !== "settled")) {
      throw new Error("Match result ingestion returned an invalid settlement state.");
    }
    if (outcome["status"] === "pending") return;
    this.state!.pendingProgression = this.validatedProgression(outcome["progression"]);
    this.state!.pendingResult = null;
    await this.persist();
  }

  private async post(kind: "events" | "result", body: unknown): Promise<Response> {
    const manifest = this.state!.manifest;
    const response = await this.request(
      `${this.config.apiUrl}/api/node/v1/matches/${encodeURIComponent(manifest.matchId)}/${kind}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.nodeToken}`,
          "Content-Type": "application/json",
          "X-Aftertick-Signature": signIngestion(body, manifest.eventIngestSecret),
          ...(kind === "events" ? { "X-Aftertick-Counter-Receipt": "1" } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!response.ok) {
      throw new Error(`Match ${kind} ingestion failed with ${response.status}.`);
    }
    return response;
  }

  private validatedProgression(value: unknown): ProgressionReceipt[] {
    if (!Array.isArray(value) || value.length > this.state!.manifest.roster.length) {
      throw new Error("Match settlement returned invalid progression data.");
    }
    const roster = new Set(this.state!.manifest.roster.map((entry) => entry.steamId));
    const expectedCategory = this.state!.manifest.mode === "deathmatch"
      || this.state!.manifest.roster.every((entry) => entry.team === "ffa")
      ? 1
      : 2;
    const seen = new Set<string>();
    return value.map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        throw new Error("Match settlement returned invalid progression data.");
      }
      const entry = candidate as Record<string, unknown>;
      const steamId = entry["steamId"];
      const earnedXp = Number(entry["earnedXp"]);
      const previousLevel = Number(entry["previousLevel"]);
      const previousXp = Number(entry["previousXp"]);
      const nextLevel = Number(entry["nextLevel"]);
      const nextXp = Number(entry["nextXp"]);
      const xpCategory = Number(entry["xpCategory"]);
      const serviceDropValue = entry["serviceDrop"];
      if (
        typeof steamId !== "string"
        || !/^\d{17}$/.test(steamId)
        || !roster.has(steamId)
        || seen.has(steamId)
        || !Number.isInteger(earnedXp)
        || earnedXp < 1
        || earnedXp > 1_000
        || !Number.isInteger(previousLevel)
        || previousLevel < 1
        || previousLevel > 40
        || !Number.isInteger(previousXp)
        || previousXp < 0
        || previousXp >= 1_000
        || !Number.isInteger(nextLevel)
        || nextLevel < 1
        || nextLevel > 40
        || !Number.isInteger(nextXp)
        || nextXp < 0
        || nextXp >= 1_000
        || xpCategory !== expectedCategory
      ) {
        throw new Error("Match settlement returned invalid progression data.");
      }
      let computedLevel = previousLevel;
      let computedXp = previousXp + earnedXp;
      while (computedLevel < 40 && computedXp >= 1_000) {
        computedLevel += 1;
        computedXp -= 1_000;
      }
      if (computedLevel === 40) computedXp = Math.min(computedXp, 999);
      if (nextLevel !== computedLevel || nextXp !== computedXp) {
        throw new Error("Match settlement returned inconsistent progression data.");
      }
      let serviceDrop: ProgressionReceipt["serviceDrop"] = null;
      if (serviceDropValue != null) {
        if (!serviceDropValue || typeof serviceDropValue !== "object") {
          throw new Error("Match settlement returned invalid service-drop data.");
        }
        const reward = serviceDropValue as Record<string, unknown>;
        if (
          typeof reward["id"] !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reward["id"])
          || reward["serviceLevel"] !== nextLevel
          || reward["rewardType"] !== "b2g_service_drop"
          || nextLevel !== previousLevel + 1
        ) {
          throw new Error("Match settlement returned invalid service-drop data.");
        }
        serviceDrop = {
          id: reward["id"],
          serviceLevel: nextLevel,
          rewardType: "b2g_service_drop"
        };
      } else if (nextLevel > previousLevel) {
        throw new Error("Match settlement omitted the earned service drop.");
      }
      seen.add(steamId);
      return {
        steamId,
        earnedXp,
        previousLevel,
        previousXp,
        nextLevel,
        nextXp,
        xpCategory: xpCategory as 1 | 2,
        serviceDrop
      };
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PumpState | null;
      if (parsed?.version === 1 && parsed.manifest?.manifestVersion === 1) {
        parsed.pendingProgression ??= [];
        this.state = parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Node agent ignored an unreadable event cursor.");
      }
    }
  }

  private async persist(): Promise<void> {
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}
