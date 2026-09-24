import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type {
  LatencyProbeChallenge,
  LatencyProbeEndpoint,
  LatencyProbeMeasurement,
  LatencyProbeStatus,
  LatencyProbeSubmission
} from "@aftertick/contracts";
import type { Sql } from "@aftertick/db";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

export class LatencyProbeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ChallengeRow {
  id: string;
  player_id: string;
  token_sha256: string;
  endpoints: unknown;
  status: "pending" | "completed" | "expired";
  expires_at: Date;
}

interface MeasurementRow {
  region: string;
  endpoint: string;
  requested_samples: number;
  successful_samples: number;
  median_ms: number | null;
  p95_ms: number | null;
  packet_loss_percent: number;
  measured_at: Date;
  valid_until: Date;
}

export interface LatencyProbeServiceOptions {
  publicUrl: string;
  endpoints: Record<string, string>;
  challengeSeconds?: number | undefined;
  measurementSeconds?: number | undefined;
  samples?: number | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  if (!SIGNATURE_PATTERN.test(left) || !SIGNATURE_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function decimal(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

export function canonicalLatencySubmission(submission: LatencyProbeSubmission): string {
  return [
    String(submission.version),
    submission.challengeId,
    ...submission.measurements.flatMap((measurement) => [
      measurement.region,
      measurement.server,
      String(measurement.requestedSamples),
      String(measurement.successfulSamples),
      decimal(measurement.medianMs),
      decimal(measurement.p95Ms),
      measurement.packetLossPercent.toFixed(1)
    ])
  ].join("\n");
}

function endpoints(value: unknown): LatencyProbeEndpoint[] {
  if (!Array.isArray(value)) throw new LatencyProbeError(409, "Latency challenge data is invalid.");
  return value.map((candidate) => {
    if (
      typeof candidate !== "object"
      || candidate === null
      || typeof (candidate as { region?: unknown }).region !== "string"
      || typeof (candidate as { server?: unknown }).server !== "string"
      || typeof (candidate as { samples?: unknown }).samples !== "number"
      || !(candidate as { region: string }).region
      || (candidate as { region: string }).region.length > 64
      || (candidate as { server: string }).server.length > 256
      || !Number.isInteger((candidate as { samples: number }).samples)
      || (candidate as { samples: number }).samples < 1
      || (candidate as { samples: number }).samples > 10
    ) {
      throw new LatencyProbeError(409, "Latency challenge data is invalid.");
    }
    return candidate as LatencyProbeEndpoint;
  });
}

function validateMeasurement(
  measurement: LatencyProbeMeasurement,
  expected: LatencyProbeEndpoint
): void {
  if (measurement.region !== expected.region || measurement.server !== expected.server) {
    throw new LatencyProbeError(400, "Latency report does not match its issued endpoints.");
  }
  if (
    measurement.requestedSamples !== expected.samples
    || !Number.isInteger(measurement.successfulSamples)
    || measurement.successfulSamples < 0
    || measurement.successfulSamples > measurement.requestedSamples
  ) {
    throw new LatencyProbeError(400, "Latency report has invalid sample counts.");
  }
  const hasLatency = measurement.medianMs !== null || measurement.p95Ms !== null;
  if (
    measurement.successfulSamples === 0
      ? hasLatency
      : measurement.medianMs === null
        || measurement.p95Ms === null
        || !Number.isFinite(measurement.medianMs)
        || !Number.isFinite(measurement.p95Ms)
        || measurement.medianMs < 0
        || measurement.p95Ms < measurement.medianMs
        || measurement.p95Ms > 5_000
  ) {
    throw new LatencyProbeError(400, "Latency report has invalid timing values.");
  }
  const expectedLoss = Math.round(
    ((measurement.requestedSamples - measurement.successfulSamples)
      / measurement.requestedSamples) * 1_000
  ) / 10;
  if (
    !Number.isFinite(measurement.packetLossPercent)
    || Math.abs(measurement.packetLossPercent - expectedLoss) > 0.05
  ) {
    throw new LatencyProbeError(400, "Latency report packet loss is inconsistent.");
  }
}

export class LatencyProbeService {
  private readonly challengeSeconds: number;
  private readonly measurementSeconds: number;
  private readonly samples: number;
  private readonly configuredEndpoints: Record<string, string>;
  private readonly submitUrl: string;

  constructor(
    private readonly sql: Sql,
    options: LatencyProbeServiceOptions
  ) {
    this.challengeSeconds = options.challengeSeconds ?? 120;
    this.measurementSeconds = options.measurementSeconds ?? 900;
    this.samples = options.samples ?? 5;
    this.configuredEndpoints = { ...options.endpoints };
    this.submitUrl = new URL("/api/latency/v1/reports", options.publicUrl).toString();
  }

  regions(): string[] {
    return Object.keys(this.configuredEndpoints);
  }

  async issue(playerId: string, requestedRegions: string[]): Promise<LatencyProbeChallenge> {
    const regions = [...new Set(requestedRegions)];
    if (regions.length === 0 || regions.length > 8) {
      throw new LatencyProbeError(400, "Choose between one and eight latency regions.");
    }
    const probeEndpoints = regions.map((region): LatencyProbeEndpoint => {
      const server = this.configuredEndpoints[region];
      if (!server) throw new LatencyProbeError(400, `No latency endpoint is configured for ${region}.`);
      return { region, server, samples: this.samples };
    });
    const challengeId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + this.challengeSeconds * 1_000);
    await this.sql.begin(async (transaction) => {
      const [player] = await transaction<{ id: string }[]>`
        select id from players where id = ${playerId} for update
      `;
      if (!player) throw new LatencyProbeError(404, "Player does not exist.");
      await transaction`
        update latency_probe_challenges
        set status = 'expired'
        where player_id = ${playerId} and status = 'pending'
      `;
      await transaction`
        insert into latency_probe_challenges (
          id, player_id, token_sha256, endpoints, expires_at
        ) values (
          ${challengeId}, ${playerId}, ${sha256(token)},
          ${transaction.json(probeEndpoints as never)}, ${expiresAt}
        )
      `;
    });
    const payload = Buffer.from(JSON.stringify(probeEndpoints), "utf8").toString("base64url");
    const launcher = new URL("b2g://probe");
    launcher.searchParams.set("challenge", challengeId);
    launcher.searchParams.set("token", token);
    launcher.searchParams.set("submit", this.submitUrl);
    launcher.searchParams.set("targets", payload);
    return {
      version: 1,
      challengeId,
      expiresAt: expiresAt.toISOString(),
      endpoints: probeEndpoints,
      launcherUrl: launcher.toString()
    };
  }

  async submit(
    token: string,
    signature: string,
    submission: LatencyProbeSubmission
  ): Promise<LatencyProbeStatus> {
    if (!TOKEN_PATTERN.test(token)) throw new LatencyProbeError(401, "Invalid latency challenge.");
    const canonical = canonicalLatencySubmission(submission);
    const expectedSignature = createHmac("sha256", token).update(canonical).digest("hex");
    if (!safeHexEqual(signature.toLowerCase(), expectedSignature)) {
      throw new LatencyProbeError(401, "Invalid latency report signature.");
    }

    const outcome = await this.sql.begin(async (transaction) => {
      const [challenge] = await transaction<ChallengeRow[]>`
        select id, player_id, token_sha256, endpoints, status, expires_at
        from latency_probe_challenges
        where id = ${submission.challengeId}
        for update
      `;
      if (!challenge || !safeHexEqual(challenge.token_sha256, sha256(token))) {
        throw new LatencyProbeError(401, "Invalid latency challenge.");
      }
      if (challenge.status !== "pending") {
        throw new LatencyProbeError(409, "Latency challenge was already consumed.");
      }
      if (challenge.expires_at.getTime() <= Date.now()) {
        await transaction`
          update latency_probe_challenges set status = 'expired' where id = ${challenge.id}
        `;
        return { expired: true as const };
      }
      const expectedEndpoints = endpoints(challenge.endpoints);
      if (submission.version !== 1 || submission.measurements.length !== expectedEndpoints.length) {
        throw new LatencyProbeError(400, "Latency report is incomplete.");
      }
      for (let index = 0; index < expectedEndpoints.length; index += 1) {
        validateMeasurement(submission.measurements[index]!, expectedEndpoints[index]!);
      }
      const measuredAt = new Date();
      const validUntil = new Date(measuredAt.getTime() + this.measurementSeconds * 1_000);
      for (const measurement of submission.measurements) {
        await transaction`
          insert into player_latency_measurements (
            challenge_id, player_id, region, endpoint,
            requested_samples, successful_samples, median_ms, p95_ms,
            packet_loss_percent, measured_at, valid_until
          ) values (
            ${challenge.id}, ${challenge.player_id}, ${measurement.region}, ${measurement.server},
            ${measurement.requestedSamples}, ${measurement.successfulSamples},
            ${measurement.medianMs}, ${measurement.p95Ms},
            ${measurement.packetLossPercent}, ${measuredAt}, ${validUntil}
          )
        `;
      }
      await transaction`
        update latency_probe_challenges
        set status = 'completed', consumed_at = ${measuredAt}
        where id = ${challenge.id}
      `;
      return { expired: false as const, playerId: challenge.player_id };
    });
    if (outcome.expired) throw new LatencyProbeError(410, "Latency challenge expired.");
    return this.status(outcome.playerId);
  }

  async status(playerId: string): Promise<LatencyProbeStatus> {
    const rows = await this.sql<MeasurementRow[]>`
      select region, endpoint, requested_samples, successful_samples,
        median_ms, p95_ms, packet_loss_percent, measured_at, valid_until
      from player_latency_measurements
      where player_id = ${playerId} and valid_until > now()
      order by region, measured_at desc
    `;
    const seen = new Set<string>();
    return {
      enabled: true,
      regions: this.regions(),
      measurements: rows
        .filter((row) => {
          if (this.configuredEndpoints[row.region] !== row.endpoint || seen.has(row.region)) {
            return false;
          }
          seen.add(row.region);
          return true;
        })
        .map((row) => ({
        region: row.region,
        server: row.endpoint,
        requestedSamples: row.requested_samples,
        successfulSamples: row.successful_samples,
        medianMs: row.median_ms,
        p95Ms: row.p95_ms,
        packetLossPercent: row.packet_loss_percent,
        measuredAt: row.measured_at.toISOString(),
        validUntil: row.valid_until.toISOString()
      }))
    };
  }

  async assertFresh(playerIds: string[], regions: string[]): Promise<void> {
    const uniquePlayers = [...new Set(playerIds)];
    const uniqueRegions = [...new Set(regions)];
    const rows = await this.sql<{ player_id: string; region: string; endpoint: string }[]>`
      select distinct player_id::text, region, endpoint
      from player_latency_measurements
      where player_id::text in (
        select jsonb_array_elements_text(${this.sql.json(uniquePlayers)})
      )
        and region in (
          select jsonb_array_elements_text(${this.sql.json(uniqueRegions)})
        )
        and valid_until > now()
        and successful_samples >= 3
        and packet_loss_percent <= 40
    `;
    const available = new Set(rows
      .filter((row) => this.configuredEndpoints[row.region] === row.endpoint)
      .map((row) => `${row.player_id}\0${row.region}`));
    const missingRegions = uniqueRegions.filter((region) =>
      uniquePlayers.some((playerId) => !available.has(`${playerId}\0${region}`))
    );
    if (missingRegions.length > 0) {
      throw new LatencyProbeError(
        409,
        `Every party member needs a fresh launcher route measurement for: ${missingRegions.join(", ")}.`
      );
    }
  }

  async pingsForPlayers(playerIds: string[]): Promise<Map<string, Record<string, number>>> {
    if (playerIds.length === 0) return new Map();
    const rows = await this.sql<{
      player_id: string;
      region: string;
      endpoint: string;
      p95_ms: number;
      packet_loss_percent: number;
    }[]>`
      select player_id::text, region, endpoint, p95_ms, packet_loss_percent
      from player_latency_measurements
      where player_id::text in (
        select jsonb_array_elements_text(${this.sql.json([...new Set(playerIds)])})
      )
        and valid_until > now()
        and successful_samples >= 3
        and p95_ms is not null
        and packet_loss_percent <= 40
      order by player_id, region, measured_at desc
    `;
    const result = new Map<string, Record<string, number>>();
    for (const row of rows) {
      if (this.configuredEndpoints[row.region] !== row.endpoint) continue;
      const player = result.get(row.player_id) ?? {};
      if (player[row.region] !== undefined) continue;
      player[row.region] = Math.round((row.p95_ms + row.packet_loss_percent) * 10) / 10;
      result.set(row.player_id, player);
    }
    return result;
  }
}
