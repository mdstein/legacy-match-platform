import { createConnection } from "./connection.js";
import { runSeeds } from "./seeds.js";

async function seed() {
  const sql = createConnection();
  try {
    const result = await runSeeds(sql, {
      includeTestPlayers: process.env["AFTERTICK_SEED_TEST_PLAYERS"] === "true"
    });
    console.log(`Seeded Founders Season (${result.seasonId}) and ${result.testPlayers} test players.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

seed().catch((error) => {
  console.error("Database seed failed:", error);
  process.exit(1);
});
