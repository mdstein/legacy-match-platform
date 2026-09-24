import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/config.js";
import { MatchDemoUploader } from "../src/demo-uploader.js";
import { signIngestion } from "../src/ingestion-signature.js";
import type { AgentMatchManifest } from "../src/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("GOTV demo uploader", () => {
  it("streams the finalized bytes with signed checksum metadata", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "aftertick-demo-upload-"));
    temporaryDirectories.push(serverRoot);
    await mkdir(join(serverRoot, "csgo"), { recursive: true });
    const matchId = randomUUID();
    const bytes = Buffer.from("HL2DEMO\0aftertick-integration-demo");
    await writeFile(join(serverRoot, "csgo", `aftertick-${matchId}.dem`), bytes);
    const config: AgentConfig = {
      apiUrl: "http://127.0.0.1:8787",
      nodeToken: "aftertick-demo-uploader-node-token-long-enough",
      manifestSigningSecret: "aftertick-demo-uploader-manifest-secret",
      serverRoot,
      launcherScript: join(serverRoot, "start.ps1"),
      instanceKey: "csgo-01",
      serverAddress: "127.0.0.1:27115",
      host: "127.0.0.1",
      gamePort: 27115,
      gotvPort: 27120,
      latencyProbePort: 0,
      lanMode: true,
      rconPassword: "aftertick-demo-rcon",
      idlePassword: "aftertick-demo-idle",
      heartbeatMs: 1_000,
      serverBuildId: "12426148",
      pluginVersion: "0.1.0"
    };
    const manifest: AgentMatchManifest = {
      manifestVersion: 1,
      matchId,
      leaseId: randomUUID(),
      fencingToken: "42",
      nodeId: randomUUID(),
      serverInstanceId: randomUUID(),
      serverAddress: config.serverAddress,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      roster: [],
      map: "Mirage",
      rulesetVersion: "1.0",
      pluginVersion: "0.1.0",
      serverConfigVersion: "1.0",
      demoObjectKey: `matches/${matchId}/gotv.dem`,
      eventIngestSecret: "aftertick-demo-uploader-ingestion-secret-long-enough",
      serverPassword: "aftertickDemoUploaderPassword123",
      integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
    };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const uploaded = Buffer.from(await new Response(init?.body).arrayBuffer());
      expect(uploaded).toEqual(bytes);
      const headers = new Headers(init?.headers);
      const metadata = {
        demoVersion: 1,
        leaseId: manifest.leaseId,
        fencingToken: manifest.fencingToken,
        objectKey: manifest.demoObjectKey,
        sizeBytes: bytes.length,
        sha256
      };
      expect(headers.get("X-Aftertick-Signature")).toBe(
        signIngestion(metadata, manifest.eventIngestSecret)
      );
      expect(headers.get("Content-Length")).toBe(String(bytes.length));
      return Response.json({ duplicate: false }, { status: 201 });
    }) as unknown as typeof fetch;

    await expect(new MatchDemoUploader(config, request).upload(manifest)).resolves.toEqual({
      objectKey: manifest.demoObjectKey,
      sizeBytes: bytes.length,
      sha256,
      duplicate: false
    });
  });
});
