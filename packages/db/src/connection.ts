import postgres from "postgres";

export type Sql = postgres.Sql;

export function createConnection(url?: string): Sql {
  const connectionUrl =
    url ?? process.env["DATABASE_URL"] ?? "postgres://localhost:5432/aftertick";

  return postgres(connectionUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      bigint: postgres.BigInt
    }
  });
}
