import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { Sql } from "@aftertick/db";
import {
  MatchIngestionError,
  type MatchIngestionService
} from "./match-ingestion-service.js";

export interface DemoUploadSubmission {
  demoVersion: 1;
  leaseId: string;
  fencingToken: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
}

export interface DemoObjectStore {
  put(input: {
    key: string;
    body: Readable;
    contentLength: number;
    sha256: string;
    matchId: string;
    leaseId: string;
  }): Promise<void>;
  delete(key: string): Promise<void>;
  uri(key: string): string;
  ready?(): Promise<void>;
  close?(): void;
  get?(key: string): Promise<{
    body: Readable;
    contentLength: number;
    contentType: string;
  }>;
}

export class S3DemoObjectStore implements DemoObjectStore {
  private readonly client: S3Client;

  constructor(private readonly config: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  }) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey
      }
    });
  }

  async put(input: {
    key: string;
    body: Readable;
    contentLength: number;
    sha256: string;
    matchId: string;
    leaseId: string;
  }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.contentLength,
      ContentType: "application/octet-stream",
      Metadata: {
        sha256: input.sha256,
        match_id: input.matchId,
        lease_id: input.leaseId
      }
    }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async get(key: string): Promise<{
    body: Readable;
    contentLength: number;
    contentType: string;
  }> {
    const object = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key
    }));
    if (!(object.Body instanceof Readable) || !object.ContentLength) {
      throw new Error("Object storage returned an unreadable demo artifact.");
    }
    return {
      body: object.Body,
      contentLength: Number(object.ContentLength),
      contentType: object.ContentType ?? "application/octet-stream"
    };
  }

  uri(key: string): string {
    return `s3://${this.config.bucket}/${key}`;
  }

  async ready(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
  }

  close(): void {
    this.client.destroy();
  }
}

export class DemoIngestionService {
  constructor(
    private readonly sql: Sql,
    private readonly matches: MatchIngestionService,
    private readonly objects: DemoObjectStore
  ) {}

  async upload(
    nodeToken: string,
    matchId: string,
    submission: DemoUploadSubmission,
    signature: string,
    body: Readable
  ): Promise<{ duplicate: boolean; objectKey: string; sha256: string; sizeBytes: number }> {
    const manifest = await this.matches.authorizeSubmission(
      nodeToken,
      matchId,
      submission.leaseId,
      submission.fencingToken,
      submission,
      signature
    );
    if (manifest["demoObjectKey"] !== submission.objectKey) {
      body.resume();
      throw new MatchIngestionError(409, "The demo object key does not match the signed manifest.");
    }

    const [existing] = await this.sql<{
      sha256: string;
      size_bytes: number;
      object_key: string;
    }[]>`
      select sha256, size_bytes::int, object_key
      from match_demo_artifacts where match_id = ${matchId}
    `;
    if (existing) {
      body.resume();
      if (
        existing.sha256 === submission.sha256
        && existing.size_bytes === submission.sizeBytes
        && existing.object_key === submission.objectKey
      ) {
        return { duplicate: true, ...submission };
      }
      await this.recordConflict(matchId, submission, null, "canonical_conflict");
      throw new MatchIngestionError(409, "A different canonical demo is already attached.");
    }

    const hash = createHash("sha256");
    let observedBytes = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        observedBytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    body.pipe(verifier);
    try {
      await this.objects.put({
        key: submission.objectKey,
        body: verifier,
        contentLength: submission.sizeBytes,
        sha256: submission.sha256,
        matchId,
        leaseId: submission.leaseId
      });
    } catch (error) {
      body.unpipe(verifier);
      verifier.destroy();
      throw error;
    }
    const observedSha256 = hash.digest("hex");
    if (observedBytes !== submission.sizeBytes || observedSha256 !== submission.sha256) {
      await this.objects.delete(submission.objectKey).catch(() => undefined);
      await this.recordConflict(matchId, submission, observedSha256, "checksum_mismatch");
      throw new MatchIngestionError(409, "The uploaded demo failed independent checksum validation.");
    }

    const outcome = await this.sql.begin(async (transaction) => {
      const [match] = await transaction<{ demo_checksum: string | null }[]>`
        select demo_checksum from matches where id = ${matchId} for update
      `;
      if (!match) throw new MatchIngestionError(404, "The match does not exist.");
      const [canonical] = await transaction<{ sha256: string; size_bytes: number; object_key: string }[]>`
        select sha256, size_bytes::int, object_key
        from match_demo_artifacts where match_id = ${matchId}
      `;
      if (canonical) {
        return canonical.sha256 === submission.sha256
          && canonical.size_bytes === submission.sizeBytes
          && canonical.object_key === submission.objectKey
          ? "duplicate" as const
          : "conflict" as const;
      }
      await transaction`
        insert into match_demo_artifacts (
          match_id, lease_id, object_key, sha256, size_bytes
        ) values (
          ${matchId}, ${submission.leaseId}, ${submission.objectKey},
          ${submission.sha256}, ${submission.sizeBytes}
        )
      `;
      await transaction`
        update matches
        set demo_url = ${this.objects.uri(submission.objectKey)},
            demo_checksum = ${submission.sha256}
        where id = ${matchId}
      `;
      return "created" as const;
    });
    if (outcome === "conflict") {
      await this.recordConflict(matchId, submission, observedSha256, "canonical_conflict");
      throw new MatchIngestionError(409, "A concurrent demo upload conflicted with the canonical artifact.");
    }
    return {
      duplicate: outcome === "duplicate",
      objectKey: submission.objectKey,
      sha256: submission.sha256,
      sizeBytes: submission.sizeBytes
    };
  }

  async openDemo(matchId: string): Promise<{
    body: Readable;
    contentLength: number;
    contentType: string;
    filename: string;
  }> {
    if (!this.objects.get) {
      throw new MatchIngestionError(503, "Demo downloads are unavailable.");
    }
    const [artifact] = await this.sql<{
      object_key: string;
      size_bytes: number;
      status: string;
    }[]>`
      select object_key, size_bytes::int, status
      from match_demo_artifacts
      where match_id = ${matchId}
    `;
    if (!artifact) throw new MatchIngestionError(404, "This match has no downloadable demo.");
    if (artifact.status === "deleted") {
      throw new MatchIngestionError(410, "This demo was removed under the published retention policy.");
    }
    if (!["uploaded", "analyzed"].includes(artifact.status)) {
      throw new MatchIngestionError(409, "This demo is not currently downloadable.");
    }
    const object = await this.objects.get(artifact.object_key);
    if (object.contentLength !== artifact.size_bytes) {
      object.body.destroy();
      throw new MatchIngestionError(409, "The stored demo size no longer matches its metadata.");
    }
    return { ...object, filename: `aftertick-${matchId}.dem` };
  }

  private async recordConflict(
    matchId: string,
    submission: DemoUploadSubmission,
    observedSha256: string | null,
    reason: "canonical_conflict" | "checksum_mismatch"
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        insert into match_demo_conflicts (
          match_id, lease_id, object_key, claimed_sha256,
          observed_sha256, size_bytes, reason
        ) values (
          ${matchId}, ${submission.leaseId}, ${submission.objectKey},
          ${submission.sha256}, ${observedSha256}, ${submission.sizeBytes}, ${reason}
        )
      `;
      await transaction`
        update matches set status = 'disputed'
        where id = ${matchId} and status <> 'cancelled'
      `;
    });
  }
}
