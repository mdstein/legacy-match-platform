import { randomUUID } from "node:crypto";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const redisUrl = process.env["TEST_REDIS_URL"] ?? "";
const integration = redisUrl ? describe : describe.skip;

integration("Redis sessions", () => {
  const client = createClient({ url: redisUrl });
  const prefix = `aftertick:test:${randomUUID()}:`;

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) await client.del(keys);
    await client.quit();
  });

  it("restores authentication through a separate app instance", async () => {
    const sessionOptions = {
      store: new RedisStore({ client, prefix }),
      secret: "aftertick-real-redis-integration-secret",
      secureCookies: false
    };
    const identity = {
      playerId: "redis-player",
      steamId: "redis-steam",
      displayName: "Redis Player"
    };
    const firstApp = createApp({ session: sessionOptions, devIdentity: identity });
    const secondApp = createApp({ session: sessionOptions });

    const initial = await request(firstApp).get("/api/auth/csrf");
    const cookie = initial.headers["set-cookie"]?.[0];
    expect(cookie).toBeTruthy();

    const restored = await request(secondApp)
      .get("/api/auth/me")
      .set("Cookie", cookie!);
    expect(restored.body).toMatchObject({
      authenticated: true,
      playerId: identity.playerId,
      displayName: identity.displayName
    });

    const storedKeys = await client.keys(`${prefix}*`);
    expect(storedKeys).toHaveLength(1);
    expect(await client.ttl(storedKeys[0]!)).toBeGreaterThan(0);
  });
});
