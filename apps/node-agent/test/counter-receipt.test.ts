import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptCounterReceipt } from "../src/counter-receipt.js";
import { signIngestion } from "../src/ingestion-signature.js";
import { canonicalJson, type AgentMatchManifest } from "../src/manifest.js";

const steamId = "76561198000000001";
const assetId = "8000000000000000001";
const manifest = {
  matchId: "12345678-1234-4234-8234-123456789012", leaseId: "12345678-1234-4234-8234-123456789013",
  fencingToken: "42", eventIngestSecret: "counter-receipt-test-secret-at-least-32",
  roster: [{ playerId: "player", steamId, team: "ffa" }],
  cosmetics: [{ playerId: "player", steamId, items: [{ assetId, source: "b2g", itemKind: "cosmetic",
    quality: 9, killEaterScoreType: 0, killEaterValue: 4 }] }]
} as AgentMatchManifest;
const batch = { leaseId: manifest.leaseId, fencingToken: "42", events: [{ sequence: 7 }] };

function envelope(overrides: Record<string, unknown> = {}) {
  const receipt = { kind: "stattrak.committed", version: 1,
    matchId: manifest.matchId, leaseId: manifest.leaseId, fencingToken: "42", sequence: 7,
    batchChecksum: createHash("sha256").update(canonicalJson(batch)).digest("hex"),
    counts: [{ steamId, assetId, count: 5 }], ...overrides };
  return { counterReceipt: { receipt, signature: signIngestion(receipt, manifest.eventIngestSecret) } };
}

describe("committed counter receipts", () => {
  it("fences cached and delayed counters when the same asset returns to its old owner", () => {
    const returned = structuredClone(manifest);
    returned.cosmetics![0]!.items[0]!.ownershipGeneration = "2";
    returned.cosmetics![0]!.items[0]!.killEaterValue = 0;
    const old = acceptCounterReceipt(envelope({ counts: [{ steamId, assetId, count: 700 }] }), batch, manifest)!;
    expect(acceptCounterReceipt(envelope(), batch, returned, old)!.counts).toEqual([]);
    const current = acceptCounterReceipt(envelope({ counts: [{ steamId, assetId, count: 1, ownershipGeneration: "2" }] }),
      batch, returned, old)!;
    expect(current.counts).toEqual([{ steamId, assetId, count: 1, ownershipGeneration: "2" }]);
    expect(acceptCounterReceipt(envelope({ counts: [{ steamId, assetId, count: 800, ownershipGeneration: "1" }] }),
      batch, returned, current)).toEqual(current);
    expect(acceptCounterReceipt(envelope({ counts: [{ steamId, assetId, count: 2, ownershipGeneration: "2" }] }),
      batch, returned, current)!.counts[0]!.count).toBe(2);
    for (const ownershipGeneration of ["-1", "02", "9223372036854775808", 2]) {
      expect(() => acceptCounterReceipt(envelope({ counts: [{ steamId, assetId, count: 2, ownershipGeneration }] }),
        batch, returned)).toThrow("invalid ownership");
    }
  });
  it("accepts only absolute committed values and deduplicates retries", () => {
    const first = acceptCounterReceipt(envelope(), batch, manifest)!;
    expect(first).toEqual({ sequence: 7, counts: [{ steamId, assetId, count: 5 }] });
    expect(acceptCounterReceipt(envelope(), batch, manifest, first)).toEqual(first);
    expect(acceptCounterReceipt(envelope({ counts: [{ steamId, assetId, count: 4 }] }), batch, manifest, first)).toEqual(first);
    expect(acceptCounterReceipt({}, batch, manifest)).toBeNull();
  });
  it.each([
    { leaseId: "12345678-1234-4234-8234-123456789099" },
    { matchId: "12345678-1234-4234-8234-123456789099" },
    { fencingToken: "43" }, { sequence: 8 }, { kind: "stattrak.predicted" },
    { batchChecksum: "0".repeat(64) },
    { counts: [{ steamId, assetId, count: -1 }] },
    { counts: [{ steamId, assetId, count: 4294967296 }] },
    { counts: [{ steamId, assetId, count: 1.5 }] },
    { counts: [{ steamId: "76561198000000002", assetId, count: 5 }] },
    { counts: [{ steamId, assetId: "18446744073709551616", count: 5 }] },
    { counts: [{ steamId, assetId, count: 5 }, { steamId, assetId, count: 6 }] }
  ])("rejects wrong scope or invalid signed counts: %o", (overrides) => {
    expect(() => acceptCounterReceipt(envelope(overrides), batch, manifest)).toThrow();
  });
  it("rejects tampering and invalid signatures", () => {
    const tampered = envelope();
    tampered.counterReceipt.receipt.counts[0]!.count = 999;
    expect(() => acceptCounterReceipt(tampered, batch, manifest)).toThrow("signature");
    for (const signature of ["", "x".repeat(43), "é".repeat(43)]) {
      const value = envelope(); value.counterReceipt.signature = signature;
      expect(() => acceptCounterReceipt(value, batch, manifest)).toThrow("signature");
    }
  });
  it("does not revive removed or non-StatTrak assets and accepts uint32 max", () => {
    expect(acceptCounterReceipt(envelope(), batch, { ...manifest, cosmetics: [] }, {
      sequence: 6, counts: [{ steamId, assetId, count: 4 }]
    })!.counts).toEqual([]);
    expect(acceptCounterReceipt(envelope({ counts: [{ steamId, assetId, count: 4294967295 }] }),
      batch, manifest)!.counts[0]!.count).toBe(4294967295);
  });
});
