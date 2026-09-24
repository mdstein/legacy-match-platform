import { createHash, timingSafeEqual } from "node:crypto";
import { isOwnershipGeneration } from "@aftertick/contracts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signIngestion } from "./ingestion-signature.js";
import { canonicalJson, type AgentMatchManifest } from "./manifest.js";

export interface CommittedCounterState {
  sequence: number;
  counts: Array<{ steamId: string; assetId: string; count: number; ownershipGeneration?: string }>;
}

export function acceptCounterReceipt(
  outcome: Record<string, unknown>, batch: { events: Array<{ sequence: number }> },
  manifest: AgentMatchManifest, previous?: CommittedCounterState
): CommittedCounterState | null {
  if (outcome["counterReceipt"] === undefined) return null; // older API
  const envelope = outcome["counterReceipt"] as Record<string, unknown> | null;
  const receipt = envelope?.["receipt"] as Record<string, unknown> | null;
  const signature = envelope?.["signature"];
  if (!receipt || typeof receipt !== "object" || typeof signature !== "string")
    throw new Error("Invalid committed counter receipt.");
  const expected = signIngestion(receipt, manifest.eventIngestSecret);
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature) || signature.length !== expected.length
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
    throw new Error("Committed counter receipt signature is invalid.");
  const sequence = Math.max(...batch.events.map((event) => event.sequence));
  if (receipt["kind"] !== "stattrak.committed" || receipt["version"] !== 1
    || receipt["matchId"] !== manifest.matchId || receipt["leaseId"] !== manifest.leaseId
    || receipt["fencingToken"] !== manifest.fencingToken || receipt["sequence"] !== sequence
    || receipt["batchChecksum"] !== createHash("sha256").update(canonicalJson(batch)).digest("hex")
    || !Array.isArray(receipt["counts"]) || receipt["counts"].length > 100)
    throw new Error("Committed counter receipt does not match this fenced event batch.");

  const owners = new Map(manifest.roster.map((player) => [player.steamId, player.playerId]));
  const allowed = new Map<string, string>((manifest.cosmetics ?? []).flatMap((player) =>
    owners.get(player.steamId) !== player.playerId ? [] : player.items
      .filter((item) => item.source === "b2g" && item.itemKind === "cosmetic"
        && item.quality === 9 && item.killEaterScoreType === 0 && item.killEaterValue !== null)
      .map((item) => [`${player.steamId}:${item.assetId}`, item.ownershipGeneration ?? "0"] as const)));
  const merged = new Map((previous?.counts ?? []).filter((entry) =>
    allowed.get(`${entry.steamId}:${entry.assetId}`) === (entry.ownershipGeneration ?? "0"))
    .map((entry) => [`${entry.steamId}:${entry.assetId}`, entry]));
  const seen = new Set<string>();
  for (const value of receipt["counts"] as unknown[]) {
    const entry = value as Record<string, unknown> | null;
    if (!entry || typeof entry["steamId"] !== "string" || !/^\d{17}$/.test(entry["steamId"])
      || !owners.has(entry["steamId"]) || typeof entry["assetId"] !== "string"
      || !/^[1-9]\d{0,19}$/.test(entry["assetId"]) || BigInt(entry["assetId"]) > 0xffff_ffff_ffff_ffffn
      || !isOwnershipGeneration(entry["ownershipGeneration"] ?? "0")
      || !Number.isInteger(entry["count"]) || Number(entry["count"]) < 0 || Number(entry["count"]) > 0xffff_ffff)
      throw new Error("Committed counter receipt contains invalid ownership/count data.");
    const key = `${entry["steamId"]}:${entry["assetId"]}`;
    if (seen.has(key)) throw new Error("Committed counter receipt contains duplicate items.");
    seen.add(key);
    // The API may already have a newer inventory revision. Its regular signed
    // policy update remains the fallback for items not yet known to this node.
    const ownershipGeneration = entry["ownershipGeneration"] ?? "0";
    if (allowed.get(key) !== ownershipGeneration) continue;
    merged.set(key, { steamId: entry["steamId"], assetId: entry["assetId"],
      ...(ownershipGeneration === "0" ? {} : { ownershipGeneration: ownershipGeneration as string }),
      count: Math.max(Number(entry["count"]), merged.get(key)?.count ?? 0) });
  }
  return { sequence: Math.max(sequence, previous?.sequence ?? 0), counts: [...merged.values()] };
}

export async function writeCommittedCounters(root: string, manifest: AgentMatchManifest, state: CommittedCounterState): Promise<void> {
  const directory = join(root, "csgo_gc");
  const path = join(directory, "b2g_committed_counters.txt");
  const lines = [
    '"format_version" "1"', `"match_id" "${manifest.matchId}"`,
    `"lease_id" "${manifest.leaseId}"`, `"fencing_token" "${manifest.fencingToken}"`,
    `"sequence" "${state.sequence}"`, '"counts"', '{',
    ...state.counts.map((entry) => `  "${entry.steamId}:${entry.assetId}" "${entry.count}"`), '}',
    '"ownership_generations"', '{',
    ...state.counts.map((entry) => `  "${entry.steamId}:${entry.assetId}" "${entry.ownershipGeneration ?? "0"}"`), '}', ''
  ];
  await mkdir(directory, { recursive: true });
  await writeFile(`${path}.staged`, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  await rename(`${path}.staged`, path);
}
