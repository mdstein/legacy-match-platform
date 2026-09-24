import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMatchManifest } from "../src/manifest.js";
import { ownershipGenerationPolicy, writeOwnershipGenerations } from "../src/ownership-generations.js";

const manifest = {
  matchId: "12345678-1234-4234-8234-123456789012", leaseId: "12345678-1234-4234-8234-123456789013",
  fencingToken: "42", expiresAt: "2026-09-08T12:00:00.000Z",
  roster: [{ playerId: "player", steamId: "76561198000000001", team: "ffa" }],
  cosmetics: [{ playerId: "player", steamId: "76561198000000001", items: [
    { assetId: "8000000000000000001", source: "b2g", itemKind: "cosmetic", quality: 9,
      killEaterScoreType: 0, killEaterValue: 4, ownershipGeneration: "0" }
  ] }]
} as AgentMatchManifest;

describe("capture-time ownership projection", () => {
  it("changes its watermark on rapid ownership transfers but never on counter, name or equip updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "b2g-ownership-test-"));
    try {
      const path = join(root, "csgo/addons/sourcemod/configs/aftertick-owned-generations.txt");
      await writeOwnershipGenerations(root, manifest);
      const original = await readFile(path, "utf8");
      const before = await stat(path);
      const next = structuredClone(manifest);
      const item = next.cosmetics![0]!.items[0]!;
      item.killEaterValue = 100; item.equipped = true; item.customName = "renamed";
      next.manifestRevision = 12;
      await writeOwnershipGenerations(root, next);
      expect(await readFile(path, "utf8")).toBe(original);
      expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
      item.ownershipGeneration = "2";
      await writeOwnershipGenerations(root, next);
      const returned = await readFile(path, "utf8");
      expect(returned.split("\n")[0]).not.toBe(original.split("\n")[0]);
      expect(returned).toContain('"76561198000000001:8000000000000000001" "2"');
      next.cosmetics![0]!.items = [];
      expect(ownershipGenerationPolicy(next)).not.toContain("8000000000000000001");
    } finally {
      if (resolve(root).startsWith(resolve(tmpdir()) + "\\") || resolve(root).startsWith(resolve(tmpdir()) + "/"))
        await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid epochs and unknown owners before writing the trusted file", () => {
    for (const generation of ["-1", "02", "9223372036854775808", '2"']) {
      const next = structuredClone(manifest);
      next.cosmetics![0]!.items[0]!.ownershipGeneration = generation;
      expect(() => ownershipGenerationPolicy(next)).toThrow("invalid item");
    }
    expect(() => ownershipGenerationPolicy({ ...manifest, roster: [] })).toThrow("unknown player");
  });
});
