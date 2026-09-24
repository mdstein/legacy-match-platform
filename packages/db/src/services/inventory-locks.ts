import type postgres from "postgres";

/** All economy writers lock owners in the same order before touching items. */
export async function lockInventoryPlayers(tx: postgres.TransactionSql, playerIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(playerIds)].sort();
  if (!ids.length) return [];
  const rows = await tx<{ id: string }[]>`select id from players where id=any(${ids}) order by id for update`;
  return rows.map(row => row.id);
}
