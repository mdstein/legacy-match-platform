import { createConnection } from "./connection.js";
import { runMigrations } from "./migrations.js";

async function migrate() {
  const sql = createConnection();

  try {
    const result = await runMigrations(sql);
    if (result.applied.length === 0) {
      process.stdout.write("No pending migrations.\n");
      return;
    }

    for (const version of result.applied) {
      process.stdout.write(`Applied: ${version}.sql\n`);
    }
    process.stdout.write(`Done. Applied ${result.applied.length} migration(s).\n`);
  } finally {
    await sql.end();
  }
}

migrate().catch((error) => {
  process.stderr.write(`Migration failed: ${error}\n`);
  process.exit(1);
});
