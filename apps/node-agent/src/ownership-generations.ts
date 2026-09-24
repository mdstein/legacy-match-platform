import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isOwnershipGeneration } from "@aftertick/contracts";
import type { AgentMatchManifest } from "./manifest.js";

// Small, signature-verified projection for SourceMod's capture-time lookup.
// Counts, acknowledgements and equipment do not change this file. The first
// line is a content watermark; second-resolution file mtimes lose rapid swaps.
export function ownershipGenerationPolicy(manifest: AgentMatchManifest): string {
  const owners = new Map(manifest.roster.map((player) => [player.steamId, player.playerId]));
  const entries = (manifest.cosmetics ?? []).flatMap((player) => {
    if (!/^\d{17}$/.test(player.steamId) || owners.get(player.steamId) !== player.playerId)
      throw new Error("Ownership generation policy contains an unknown player.");
    return player.items.filter((item) => item.source === "b2g" && item.itemKind === "cosmetic"
      && item.killEaterScoreType === 0 && item.killEaterValue !== null).map((item) => {
      const generation = item.ownershipGeneration ?? "0";
      if (!/^[1-9]\d{0,19}$/.test(item.assetId) || !isOwnershipGeneration(generation))
        throw new Error("Ownership generation policy contains an invalid item.");
      return `    "${player.steamId}:${item.assetId}" "${generation}"`;
    });
  }).sort();
  const expiry = Math.floor(Date.parse(manifest.expiresAt) / 1000);
  if (!/^[a-f0-9-]{36}$/.test(manifest.matchId) || !/^[a-f0-9-]{36}$/.test(manifest.leaseId)
    || !/^\d+$/.test(manifest.fencingToken) || !Number.isSafeInteger(expiry))
    throw new Error("Ownership generation policy contains invalid lease data.");
  const body = ['"ownership"', '{', `  "match_id" "${manifest.matchId}"`,
    `  "lease_id" "${manifest.leaseId}"`, `  "fencing_token" "${manifest.fencingToken}"`,
    `  "expires_at" "${expiry}"`, '  "items"', '  {', ...entries, '  }', '}', ''].join("\n");
  return `// ${createHash("sha256").update(body).digest("hex")}\n${body}`;
}

export async function writeOwnershipGenerations(root: string, manifest: AgentMatchManifest): Promise<void> {
  const path = join(root, "csgo", "addons", "sourcemod", "configs", "aftertick-owned-generations.txt");
  const content = ownershipGenerationPolicy(manifest);
  const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous === content) return;
  await mkdir(join(root, "csgo", "addons", "sourcemod", "configs"), { recursive: true });
  await writeFile(`${path}.staged`, content, { encoding: "utf8", mode: 0o600 });
  await rename(`${path}.staged`, path);
}
