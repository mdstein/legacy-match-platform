process.env.NODE_ENV ??= "development";
process.env.DEV_PLAYER_ID ??= "demo-player";

await import("./dist/server.js");
