import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    AFTERTICK_API_URL: "https://play.aftertick.example",
    AFTERTICK_NODE_TOKEN: "aftertick-node-token-at-least-thirty-two",
    MANIFEST_SIGNING_SECRET: "aftertick-manifest-secret-at-least-thirty-two",
    AFTERTICK_SERVER_ROOT: "C:\\Aftertick\\game",
    AFTERTICK_SRCDS_LAUNCHER: "C:\\Aftertick\\current\\scripts\\start-srcds-hidden.ps1",
    AFTERTICK_SERVER_ADDRESS: "203.0.113.20:27115",
    AFTERTICK_SRCDS_HOST: "0.0.0.0",
    AFTERTICK_SRCDS_RCON: "aftertick-production-rcon",
    AFTERTICK_SRCDS_IDLE_PASSWORD: "aftertick-production-idle",
    ...overrides
  };
}

describe("game node configuration", () => {
  it("makes public SRCDS mode an explicit production choice", () => {
    expect(loadAgentConfig(environment({
      AFTERTICK_SRCDS_LAN: "0",
      AFTERTICK_SRCDS_GSLT: "0123456789abcdef0123456789abcdef"
    }))).toMatchObject({
      lanMode: false,
      gsltToken: "0123456789abcdef0123456789abcdef",
      host: "0.0.0.0",
      serverAddress: "203.0.113.20:27115",
      latencyProbePort: 27125,
      idlePassword: "aftertick-production-idle"
    });
  });

  it("defaults to LAN mode for local development", () => {
    expect(loadAgentConfig(environment()).lanMode).toBe(true);
  });

  it.each([
    { AFTERTICK_SRCDS_LAN: "2" },
    { AFTERTICK_SRCDS_GSLT: "not-a-steam-token" },
    { AFTERTICK_SRCDS_RCON: "unsafe;quit" },
    { AFTERTICK_SRCDS_IDLE_PASSWORD: "short" },
    { AFTERTICK_LATENCY_PROBE_PORT: "70000" }
  ])("rejects unsafe server settings: %o", (override) => {
    expect(() => loadAgentConfig(environment(override))).toThrow();
  });
});
