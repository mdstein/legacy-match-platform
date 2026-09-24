import type postgres from "postgres";
import { grantServiceLevelRewards } from "./service-level-rewards.js";

// Called only while migration 033 is being applied, within its transaction and
// advisory lock. Its receipt and every granted item commit or roll back together.
export async function convertProfileXpTo1000(tx: postgres.TransactionSql): Promise<void> {
  const players = await tx<{
    id: string; profile_level: number; profile_xp: number; service_prestige: number;
  }[]>`select id, profile_level, profile_xp, service_prestige from players order by id for update`;
  for (const player of players) {
    const levels = Math.min(40 - player.profile_level, Math.floor(player.profile_xp / 1000));
    const level = player.profile_level + levels;
    const remaining = player.profile_xp - levels * 1000;
    const xp = level === 40 ? 0 : remaining;
    const reserve = level === 40 ? remaining : 0;
    await tx`insert into player_xp_conversion_1000
      (player_id, previous_level, previous_xp, next_level, next_xp, reserved_xp)
      values (${player.id}, ${player.profile_level}, ${player.profile_xp}, ${level}, ${xp}, ${reserve})`;
    await tx`update players set profile_level=${level}, profile_xp=${xp}, profile_xp_reserve=${reserve},
      updated_at=now() where id=${player.id}`;
    for (let crossed = player.profile_level + 1; crossed <= level; crossed++) {
      await grantServiceLevelRewards(tx, player.id, crossed, player.service_prestige, null);
    }
  }
  await tx`alter table players drop constraint players_profile_xp_check`;
  await tx`alter table players add constraint players_profile_xp_check check (profile_xp between 0 and 999)`;
}
