import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Sql } from "@aftertick/db";

const DEVICE_CODE_PATTERN = /^[a-f0-9]{64}$/i;
const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface LauncherDeviceAuthorization {
  version: 1;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface LauncherDeviceApproval {
  version: 1;
  status: "approved";
  userCode: string;
  expiresAt: string;
}

export type LauncherTokenExchange = {
  version: 1;
  status: "pending";
  retryAfterSeconds: number;
} | {
  version: 1;
  status: "authorized";
  accessToken: string;
  expiresAt: string;
};

export interface LauncherIdentity {
  credentialId: string;
  playerId: string;
  expiresAt: string;
}

export interface LauncherDeviceServiceLike {
  issue(): Promise<LauncherDeviceAuthorization>;
  approve(playerId: string, userCode: string): Promise<LauncherDeviceApproval>;
  exchange(deviceCode: string, deviceName?: string): Promise<LauncherTokenExchange>;
  authenticate(accessToken: string): Promise<LauncherIdentity>;
  revoke(accessToken: string): Promise<void>;
}

export class LauncherDeviceError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface LauncherDeviceServiceOptions {
  publicUrl: string;
  allowInsecureLoopback?: boolean;
  authorizationSeconds?: number;
  credentialDays?: number;
  pollIntervalSeconds?: number;
}

interface AuthorizationRow {
  id: string;
  player_id: string | null;
  status: "pending" | "approved" | "consumed" | "expired";
  expires_at: Date;
  approved_at: Date | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function userCode(): string {
  let value = "";
  for (let index = 0; index < 8; index += 1) {
    value += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return value;
}

function displayUserCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizeUserCode(value: string): string {
  return value.replaceAll("-", "").trim().toUpperCase();
}

function normalizeDeviceName(value: string | undefined): string {
  const name = value?.trim() || "B2G Launcher";
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new LauncherDeviceError(400, "Launcher device name is invalid.");
  }
  return name;
}

export class LauncherDeviceService implements LauncherDeviceServiceLike {
  private readonly origin: string;
  private readonly authorizationSeconds: number;
  private readonly credentialDays: number;
  private readonly pollIntervalSeconds: number;

  constructor(private readonly sql: Sql, options: LauncherDeviceServiceOptions) {
    const publicUrl = new URL(options.publicUrl);
    const insecureLoopback = options.allowInsecureLoopback === true
      && publicUrl.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
    if (
      (publicUrl.protocol !== "https:" && !insecureLoopback)
      || publicUrl.username
      || publicUrl.password
      || publicUrl.pathname !== "/"
      || publicUrl.search
      || publicUrl.hash
    ) {
      throw new Error(
        "Launcher authorization requires a credential-free HTTPS public origin (or an explicitly allowed HTTP loopback origin outside production)."
      );
    }
    this.origin = publicUrl.origin;
    this.authorizationSeconds = options.authorizationSeconds ?? 10 * 60;
    this.credentialDays = options.credentialDays ?? 90;
    // Three seconds stays comfortably below the auth limiter even when the
    // browser login and approval requests share the launcher's public IP.
    this.pollIntervalSeconds = options.pollIntervalSeconds ?? 3;
    if (!(60 <= this.authorizationSeconds && this.authorizationSeconds <= 15 * 60)) {
      throw new Error("Launcher authorization lifetime must be between 60 and 900 seconds.");
    }
    if (!(1 <= this.credentialDays && this.credentialDays <= 365)) {
      throw new Error("Launcher credential lifetime must be between 1 and 365 days.");
    }
    if (!(1 <= this.pollIntervalSeconds && this.pollIntervalSeconds <= 30)) {
      throw new Error("Launcher poll interval must be between 1 and 30 seconds.");
    }
  }

  async issue(): Promise<LauncherDeviceAuthorization> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const deviceCode = randomBytes(32).toString("hex");
      const code = userCode();
      const expiresAt = new Date(Date.now() + this.authorizationSeconds * 1_000);
      const inserted = await this.sql<{ id: string }[]>`
        insert into launcher_device_authorizations (
          device_code_sha256, user_code, expires_at
        ) values (
          ${sha256(deviceCode)}, ${code}, ${expiresAt}
        )
        on conflict do nothing
        returning id::text
      `;
      if (!inserted[0]) continue;

      const verification = new URL("/", `${this.origin}/`);
      verification.searchParams.set("launcher_code", displayUserCode(code));
      return {
        version: 1,
        deviceCode,
        userCode: displayUserCode(code),
        verificationUrl: verification.toString(),
        expiresAt: expiresAt.toISOString(),
        intervalSeconds: this.pollIntervalSeconds
      };
    }

    throw new LauncherDeviceError(503, "Could not create a launcher authorization. Try again.");
  }

  async approve(playerId: string, suppliedCode: string): Promise<LauncherDeviceApproval> {
    const code = normalizeUserCode(suppliedCode);
    if (!USER_CODE_PATTERN.test(code)) {
      throw new LauncherDeviceError(400, "Launcher authorization code is invalid.");
    }

    const result = await this.sql.begin(async (transaction) => {
      const [authorization] = await transaction<AuthorizationRow[]>`
        select id::text, player_id::text, status, expires_at, approved_at
        from launcher_device_authorizations
        where user_code = ${code}
        for update
      `;
      if (!authorization) {
        throw new LauncherDeviceError(404, "Launcher authorization code was not found.");
      }
      if (authorization.expires_at.getTime() <= Date.now()) {
        if (authorization.status !== "consumed") {
          await transaction`
            update launcher_device_authorizations
            set status = 'expired', player_id = null, approved_at = null
            where id = ${authorization.id}
          `;
        }
        return null;
      }
      if (authorization.status === "consumed") {
        throw new LauncherDeviceError(409, "Launcher authorization code was already used.");
      }
      if (authorization.status === "approved" && authorization.player_id !== playerId) {
        throw new LauncherDeviceError(409, "Launcher authorization code was already approved.");
      }
      if (authorization.status === "pending") {
        await transaction`
          update launcher_device_authorizations
          set status = 'approved', player_id = ${playerId}, approved_at = now()
          where id = ${authorization.id}
        `;
      }

      return {
        version: 1,
        status: "approved",
        userCode: displayUserCode(code),
        expiresAt: authorization.expires_at.toISOString()
      } satisfies LauncherDeviceApproval;
    });
    if (!result) {
      throw new LauncherDeviceError(410, "Launcher authorization code expired.");
    }
    return result;
  }

  async exchange(deviceCode: string, deviceName?: string): Promise<LauncherTokenExchange> {
    if (!DEVICE_CODE_PATTERN.test(deviceCode)) {
      throw new LauncherDeviceError(401, "Launcher authorization is invalid.");
    }
    const name = normalizeDeviceName(deviceName);

    const result = await this.sql.begin(async (transaction) => {
      const [authorization] = await transaction<AuthorizationRow[]>`
        select id::text, player_id::text, status, expires_at, approved_at
        from launcher_device_authorizations
        where device_code_sha256 = ${sha256(deviceCode.toLowerCase())}
        for update
      `;
      if (!authorization) {
        throw new LauncherDeviceError(401, "Launcher authorization is invalid.");
      }
      if (authorization.expires_at.getTime() <= Date.now()) {
        if (authorization.status !== "consumed") {
          await transaction`
            update launcher_device_authorizations
            set status = 'expired', player_id = null, approved_at = null
            where id = ${authorization.id}
          `;
        }
        return null;
      }
      if (authorization.status === "pending") {
        return {
          version: 1,
          status: "pending",
          retryAfterSeconds: this.pollIntervalSeconds
        } satisfies LauncherTokenExchange;
      }
      if (authorization.status !== "approved" || !authorization.player_id) {
        throw new LauncherDeviceError(409, "Launcher authorization was already completed.");
      }

      const accessToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + this.credentialDays * 24 * 60 * 60 * 1_000);
      await transaction`
        insert into launcher_credentials (
          player_id, token_sha256, device_name, expires_at
        ) values (
          ${authorization.player_id}, ${sha256(accessToken)}, ${name}, ${expiresAt}
        )
      `;
      await transaction`
        update launcher_device_authorizations
        set status = 'consumed', consumed_at = now()
        where id = ${authorization.id}
      `;

      return {
        version: 1,
        status: "authorized",
        accessToken,
        expiresAt: expiresAt.toISOString()
      } satisfies LauncherTokenExchange;
    });
    if (!result) {
      throw new LauncherDeviceError(410, "Launcher authorization expired. Start again.");
    }
    return result;
  }

  async authenticate(accessToken: string): Promise<LauncherIdentity> {
    if (!DEVICE_CODE_PATTERN.test(accessToken)) {
      throw new LauncherDeviceError(401, "Invalid launcher credentials.");
    }
    const [credential] = await this.sql<{
      credential_id: string;
      player_id: string;
      expires_at: Date;
    }[]>`
      update launcher_credentials
      set last_used_at = now()
      where token_sha256 = ${sha256(accessToken.toLowerCase())}
        and revoked_at is null
        and expires_at > now()
      returning id::text as credential_id, player_id::text, expires_at
    `;
    if (!credential) {
      throw new LauncherDeviceError(401, "Invalid or expired launcher credentials.");
    }
    return {
      credentialId: credential.credential_id,
      playerId: credential.player_id,
      expiresAt: credential.expires_at.toISOString()
    };
  }

  async revoke(accessToken: string): Promise<void> {
    if (!DEVICE_CODE_PATTERN.test(accessToken)) {
      throw new LauncherDeviceError(401, "Invalid launcher credentials.");
    }
    const revoked = await this.sql<{ id: string }[]>`
      update launcher_credentials
      set revoked_at = now()
      where token_sha256 = ${sha256(accessToken.toLowerCase())}
        and revoked_at is null
      returning id::text
    `;
    if (!revoked[0]) {
      throw new LauncherDeviceError(401, "Invalid launcher credentials.");
    }
  }
}
