import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Sql } from "@aftertick/db";
import { z } from "zod";

const analysisSchema = z.object({
  schemaVersion: z.literal(1),
  analyzer: z.literal("aftertick-demoinfocs-csgo"),
  analyzerVersion: z.string().min(1).max(128),
  source: z.object({
    path: z.string(),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  header: z.object({
    filestamp: z.literal("HL2DEMO"),
    mapName: z.string().min(1),
    gameDirectory: z.literal("csgo")
  }).passthrough(),
  players: z.array(z.object({ steamId: z.string().regex(/^\d{17}$/) }).passthrough()),
  rounds: z.array(z.unknown()),
  quality: z.object({
    parseComplete: z.boolean(),
    warnings: z.array(z.string()),
    rounds: z.number().int().nonnegative(),
    players: z.number().int().nonnegative()
  }).passthrough()
}).passthrough();

export interface DemoAnalysisWorkerConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  analyzerPath: string;
}

interface ArtifactRow {
  match_id: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  map: string;
  roster: string[];
}

const mapNames: Record<string, string> = {
  Mirage: "de_mirage",
  Inferno: "de_inferno",
  Nuke: "de_nuke",
  Overpass: "de_overpass",
  Vertigo: "de_vertigo",
  Ancient: "de_ancient",
  Anubis: "de_anubis",
  "Dust II": "de_dust2"
};

export async function analyzeDemoArtifact(
  sql: Sql,
  config: DemoAnalysisWorkerConfig,
  matchId: string
): Promise<{
  matchId: string;
  analyzerVersion: string;
  analysisSha256: string;
  warnings: string[];
}> {
  const [artifact] = await sql<ArtifactRow[]>`
    select artifact.match_id, artifact.object_key, artifact.sha256,
           artifact.size_bytes::int, match.map,
           array_agg(player.steam_id order by player.steam_id) as roster
    from match_demo_artifacts artifact
    join matches match on match.id = artifact.match_id
    join rosters roster on roster.match_id = match.id
    join players player on player.id = roster.player_id
    where artifact.match_id = ${matchId}
      and artifact.status in ('uploaded', 'analyzed')
    group by artifact.match_id, artifact.object_key, artifact.sha256,
             artifact.size_bytes, match.map
  `;
  if (!artifact) throw new Error(`No uploaded demo artifact exists for match ${matchId}.`);

  const directory = await mkdtemp(join(tmpdir(), "aftertick-demo-analysis-"));
  const demoPath = join(directory, basename(artifact.object_key));
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }
  });
  try {
    const object = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: artifact.object_key
    }));
    if (!object.Body || typeof (object.Body as NodeJS.ReadableStream).pipe !== "function") {
      throw new Error("Object storage did not return a readable demo stream.");
    }
    await pipeline(
      object.Body as NodeJS.ReadableStream,
      createWriteStream(demoPath, { flags: "wx" })
    );
    const observed = await checksum(demoPath);
    if (observed.sizeBytes !== artifact.size_bytes || observed.sha256 !== artifact.sha256) {
      throw new Error("Downloaded object bytes do not match the canonical artifact metadata.");
    }
    const raw = await runAnalyzer(config.analyzerPath, demoPath);
    const analysis = analysisSchema.parse(JSON.parse(raw));
    if (analysis.source.sizeBytes !== artifact.size_bytes || analysis.source.sha256 !== artifact.sha256) {
      throw new Error("Analyzer source evidence does not match the canonical artifact.");
    }
    if (analysis.header.mapName !== mapNames[artifact.map]) {
      throw new Error(`Demo map ${analysis.header.mapName} does not match match map ${artifact.map}.`);
    }
    const roster = new Set(artifact.roster);
    if (analysis.players.some((player) => !roster.has(player.steamId))) {
      throw new Error("The demo contains a player outside the canonical roster.");
    }
    const canonical = JSON.stringify(analysis);
    const analysisSha256 = createHash("sha256").update(canonical).digest("hex");
    await sql`
      update match_demo_artifacts
      set status = 'analyzed', analyzer_version = ${analysis.analyzerVersion},
          analysis_sha256 = ${analysisSha256}, analysis = ${sql.json(analysis)},
          analyzed_at = now(), analysis_attempts = analysis_attempts + 1,
          analysis_error = null
      where match_id = ${matchId} and sha256 = ${artifact.sha256}
    `;
    return {
      matchId,
      analyzerVersion: analysis.analyzerVersion,
      analysisSha256,
      warnings: analysis.quality.warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql.begin(async (transaction) => {
      await transaction`
        update match_demo_artifacts
        set status = 'invalid', analyzed_at = now(),
            analysis_attempts = analysis_attempts + 1,
            analysis_error = ${message.slice(0, 2_000)}
        where match_id = ${matchId}
      `;
      await transaction`
        update matches set status = 'disputed'
        where id = ${matchId} and status <> 'cancelled'
      `;
    });
    throw error;
  } finally {
    client.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

async function checksum(path: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk);
    sizeBytes += bytes.length;
    hash.update(bytes);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function runAnalyzer(binary: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-input", input], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 16 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-32_768); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Demo analyzer failed with ${code ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}
