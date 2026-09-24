process.env.NODE_ENV = "test";
process.env.PORT = "8788";
process.env.SESSION_SECRET ??= "aftertick-e2e-session-secret-not-for-production";
process.env.AFTERTICK_E2E_PLAYER_ID = "10000000-0000-4000-8000-000000000001";
process.env.AFTERTICK_E2E_STEAM_ID = "76561198000000000";
process.env.AFTERTICK_E2E_DISPLAY_NAME = "E2E Player";

// E2E browser tests deliberately exercise the deterministic in-memory adapters.
// Real PostgreSQL and Redis integration have separate suites so failures remain
// attributable and the single browser identity can form a simulated match.
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

await import("./dist/server.js");
