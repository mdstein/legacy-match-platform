import { describe, expect, it } from "vitest";
import { loadConfig, parseLatencyProbeEndpoints } from "../src/config.js";

describe("configuration", () => {
  it("rejects an incomplete production configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow();
  });

  it("rejects insecure production origins and development identities", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      AFTERTICK_PUBLIC_URL: "http://platform.example.com",
      DATABASE_URL: "postgres://db.example.com/aftertick",
      REDIS_URL: "redis://redis.example.com/0",
      SESSION_SECRET: "a-secure-production-secret-with-32-characters",
      DEV_PLAYER_ID: "forbidden"
    })).toThrow();
  });

  it("normalizes the public and configured CORS origins", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      AFTERTICK_PUBLIC_URL: "http://127.0.0.1:4173/path",
      CORS_ORIGINS: "http://localhost:5173, http://127.0.0.1:4173"
    });

    expect(config.allowedOrigins).toEqual([
      "http://127.0.0.1:4173",
      "http://localhost:5173"
    ]);
    expect(config.bindHost).toBe("127.0.0.1");
  });

  it("accepts the explicit container bind address", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "0.0.0.0"
    });

    expect(config.bindHost).toBe("0.0.0.0");
  });

  it("parses only named Source endpoints for regional launcher probes", () => {
    expect(parseLatencyProbeEndpoints(
      "NA Central=na.example.test:27015;EU Central=[::1]:27016"
    )).toEqual({
      "NA Central": "na.example.test:27015",
      "EU Central": "[::1]:27016"
    });
    expect(() => parseLatencyProbeEndpoints("Unknown=host:27015")).toThrow(/region/i);
    expect(() => parseLatencyProbeEndpoints(
      "NA Central=host:27015;NA Central=other:27016"
    )).toThrow(/duplicate/i);
    expect(() => parseLatencyProbeEndpoints("NA Central=host:0")).toThrow(/endpoint/i);
  });
});
