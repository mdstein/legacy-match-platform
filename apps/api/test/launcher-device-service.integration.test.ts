import { randomUUID } from "node:crypto";
import { createConnection, runMigrations, type Sql } from "@aftertick/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LauncherDeviceError,
  LauncherDeviceService
} from "../src/launcher-device-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

describe("launcher device public origin", () => {
  const unusedSql = {} as Sql;

  it("allows only explicitly enabled HTTP loopback origins", () => {
    expect(() => new LauncherDeviceService(unusedSql, {
      publicUrl: "http://127.0.0.1:8787",
      allowInsecureLoopback: true
    })).not.toThrow();
    expect(() => new LauncherDeviceService(unusedSql, {
      publicUrl: "http://example.test",
      allowInsecureLoopback: true
    })).toThrow(/HTTPS public origin/);
  });

  it("keeps HTTP loopback disabled unless the caller opts in", () => {
    expect(() => new LauncherDeviceService(unusedSql, {
      publicUrl: "http://localhost:8787"
    })).toThrow(/HTTPS public origin/);
  });
});

integration("launcher device authorization", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const playerId = randomUUID();
  let admin: Sql;
  let sql: Sql;
  let service: LauncherDeviceService;

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
    await runMigrations(sql);
    await sql`
      insert into players (id, steam_id, display_name, region)
      values (${playerId}, '76561198000000125', 'Launcher Player', 'NA Central')
    `;
    service = new LauncherDeviceService(sql, {
      publicUrl: "https://play.back2go.net",
      authorizationSeconds: 120,
      credentialDays: 30,
      pollIntervalSeconds: 1
    });
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it("pairs once, authenticates the launcher, and supports revocation", async () => {
    const authorization = await service.issue();
    expect(authorization).toMatchObject({
      version: 1,
      intervalSeconds: 1
    });
    expect(authorization.deviceCode).toMatch(/^[a-f0-9]{64}$/);
    expect(authorization.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(authorization.verificationUrl).toContain("play.back2go.net");
    expect(authorization.verificationUrl).toContain("launcher_code=");

    await expect(service.exchange(authorization.deviceCode)).resolves.toEqual({
      version: 1,
      status: "pending",
      retryAfterSeconds: 1
    });

    await expect(service.approve(playerId, authorization.userCode)).resolves.toMatchObject({
      version: 1,
      status: "approved",
      userCode: authorization.userCode
    });

    const exchange = await service.exchange(authorization.deviceCode, "Max's PC");
    expect(exchange.status).toBe("authorized");
    if (exchange.status !== "authorized") throw new Error("Expected launcher credential.");
    expect(exchange.accessToken).toMatch(/^[a-f0-9]{64}$/);

    await expect(service.authenticate(exchange.accessToken)).resolves.toMatchObject({
      playerId
    });
    await expect(service.exchange(authorization.deviceCode)).rejects.toMatchObject({
      status: 409
    } satisfies Partial<LauncherDeviceError>);

    await service.revoke(exchange.accessToken);
    await expect(service.authenticate(exchange.accessToken)).rejects.toMatchObject({
      status: 401
    } satisfies Partial<LauncherDeviceError>);
  });

  it("expires unapproved device codes without issuing credentials", async () => {
    const authorization = await service.issue();
    await sql`
      update launcher_device_authorizations
      set expires_at = now() - interval '1 second'
      where user_code = ${authorization.userCode.replace("-", "")}
    `;

    await expect(service.exchange(authorization.deviceCode)).rejects.toMatchObject({
      status: 410
    } satisfies Partial<LauncherDeviceError>);
    const [row] = await sql<{ status: string }[]>`
      select status
      from launcher_device_authorizations
      where user_code = ${authorization.userCode.replace("-", "")}
    `;
    expect(row?.status).toBe("expired");
  });
});
