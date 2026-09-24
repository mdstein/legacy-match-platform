import { createHmac, timingSafeEqual } from "node:crypto";
import type { GameMode } from "@aftertick/contracts";

export interface AgentMatchManifest {
  manifestVersion: 1;
  manifestRevision?: number;
  matchId: string;
  leaseId: string;
  fencingToken: string;
  nodeId: string;
  serverInstanceId: string;
  serverAddress: string;
  issuedAt: string;
  expiresAt: string;
  mode?: GameMode;
  roster: Array<{ playerId: string; steamId: string; team: "alpha" | "bravo" | "ffa" }>;
  cosmetics?: Array<{
    playerId: string;
    steamId: string;
    items: Array<{
      assetId: string;
      ownershipGeneration?: string;
      source: "steam" | "b2g";
      itemKind: "cosmetic" | "case" | "key";
      definitionIndex: number;
      weaponKey: string;
      inventoryPosition: number;
      paintIndex: number | null;
      paintWear: number | null;
      paintSeed: number | null;
      quality: number;
      rarity: number;
      origin: number;
      killEaterScoreType: number | null;
      killEaterValue: number | null;
      customName: string | null;
      sprayKitId?: number | null;
      sprayTintId?: number | null;
      spraysRemaining?: number | null;
      stickers: Array<{
        slot: number;
        stickerId: number;
        wear: number | null;
        scale: number | null;
        rotation: number | null;
      }>;
      loadoutSlot: number;
      equipped: boolean;
    }>;
  }>;
  map: string;
  rulesetVersion: string;
  fragLimit?: number | null;
  timeLimitSeconds?: number | null;
  pluginVersion: string;
  serverConfigVersion: string;
  demoObjectKey: string;
  eventIngestSecret: string;
  serverPassword: string;
  integrityPolicy: {
    protocolVersion: 1;
    provider: "none";
    enforcement: "disabled";
  };
  [key: string]: unknown;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function manifestSignature(manifest: AgentMatchManifest, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(manifest)).digest("base64url");
}

export function verifyManifestSignature(
  manifest: AgentMatchManifest,
  signature: string,
  secret: string
): boolean {
  const expected = Buffer.from(manifestSignature(manifest, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
