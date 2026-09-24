import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentConfig } from "./config.js";
import { signIngestion } from "./ingestion-signature.js";
import type { AgentMatchManifest } from "./manifest.js";

export interface DemoUploader {
  upload(manifest: AgentMatchManifest): Promise<{
    objectKey: string;
    sha256: string;
    sizeBytes: number;
    duplicate: boolean;
  }>;
}

export class MatchDemoUploader implements DemoUploader {
  constructor(
    private readonly config: AgentConfig,
    private readonly request: typeof fetch = fetch
  ) {}

  async upload(manifest: AgentMatchManifest): Promise<{
    objectKey: string;
    sha256: string;
    sizeBytes: number;
    duplicate: boolean;
  }> {
    const path = join(this.config.serverRoot, "csgo", `aftertick-${manifest.matchId}.dem`);
    const sizeBytes = await this.waitForFinalizedFile(path);
    const sha256 = await this.checksum(path);
    const metadata = {
      demoVersion: 1 as const,
      leaseId: manifest.leaseId,
      fencingToken: manifest.fencingToken,
      objectKey: manifest.demoObjectKey,
      sizeBytes,
      sha256
    };
    const body = Readable.toWeb(createReadStream(path)) as unknown as BodyInit;
    const response = await this.request(
      `${this.config.apiUrl}/api/node/v1/matches/${encodeURIComponent(manifest.matchId)}/demo`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.config.nodeToken}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(sizeBytes),
          "X-Aftertick-Demo-Version": "1",
          "X-Aftertick-Lease-Id": manifest.leaseId,
          "X-Aftertick-Fencing-Token": manifest.fencingToken,
          "X-Aftertick-Demo-Key": manifest.demoObjectKey,
          "X-Aftertick-Demo-Sha256": sha256,
          "X-Aftertick-Signature": signIngestion(metadata, manifest.eventIngestSecret)
        },
        body,
        duplex: "half"
      } as RequestInit & { duplex: "half" }
    );
    if (!response.ok) throw new Error(`Demo ingestion failed with ${response.status}.`);
    const result = await response.json() as { duplicate?: boolean };
    return {
      objectKey: manifest.demoObjectKey,
      sha256,
      sizeBytes,
      duplicate: result.duplicate === true
    };
  }

  private async waitForFinalizedFile(path: string): Promise<number> {
    const deadline = Date.now() + 15_000;
    let previousSize = -1;
    let stableObservations = 0;
    while (Date.now() < deadline) {
      const current = await stat(path).catch(() => null);
      if (current && current.size > 0) {
        stableObservations = current.size === previousSize ? stableObservations + 1 : 0;
        previousSize = current.size;
        if (stableObservations >= 2) return current.size;
      }
      await delay(200);
    }
    throw new Error("The GOTV demo did not finalize before upload.");
  }

  private async checksum(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }
}
