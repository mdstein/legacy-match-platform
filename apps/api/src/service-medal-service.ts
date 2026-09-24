import { advanceProfile, grantServiceLevelRewards, nextServiceMedal, type Sql } from "@aftertick/db";

export class ServiceMedalError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class ServiceMedalService {
  constructor(private readonly sql: Sql) {}

  async preview(playerId: string) {
    const [player] = await this.sql<{ profile_level: number; profile_xp: number; service_prestige: number }[]>`
      select profile_level, profile_xp, service_prestige from players where id=${playerId}
    `;
    if (!player) throw new ServiceMedalError(404, "Player not found.");
    const medal = nextServiceMedal(player.service_prestige);
    const [owned] = medal ? await this.sql<{ asset_id: string }[]>`
      select asset_id from player_service_medals where player_id=${playerId} and medal_year=${medal.year}
    ` : [];
    const [capacity] = medal && !owned ? await this.sql<{ count: number }[]>`
      select count(*)::int as count from player_b2g_inventory_items where player_id=${playerId} and state='active'
    ` : [];
    const failureReason = !medal ? 3 : player.profile_level !== 40 ? 1
      : (capacity?.count ?? 0) >= 512 ? 2 : 0;
    return {
      playerLevel: player.profile_level, playerXp: player.profile_xp,
      completedPrestiges: player.service_prestige,
      canRedeem: failureReason === 0, failureReason,
      medal: medal ? { ...medal, upgradeAssetId: owned?.asset_id ?? null } : null
    };
  }

  async redeem(playerId: string, definitionIndex: number) {
    return this.sql.begin(async (tx) => {
      const [player] = await tx<{ profile_level: number; profile_xp: number; profile_xp_reserve: number; service_prestige: number }[]>`
        select profile_level, profile_xp, profile_xp_reserve, service_prestige from players where id=${playerId} for update
      `;
      if (!player) throw new ServiceMedalError(404, "Player not found.");
      const [previous] = await tx<{
        prestige: number; medal_year: number; medal_tier: number; asset_id: string; redeemed_at: Date;
      }[]>`
        select prestige, medal_year, medal_tier, asset_id, redeemed_at
        from player_service_medal_redemptions where player_id=${playerId} and definition_index=${definitionIndex}
      `;
      if (previous) return {
        alreadyCompleted: true, definitionIndex, assetId: previous.asset_id,
        prestige: previous.prestige, year: previous.medal_year, tier: previous.medal_tier,
        redeemedAt: previous.redeemed_at.toISOString(),
        playerLevel: player.profile_level, playerXp: player.profile_xp
      };
      const medal = nextServiceMedal(player.service_prestige);
      if (!medal) throw new ServiceMedalError(409, "All available service medal tiers have been redeemed.");
      if (player.profile_level !== 40) throw new ServiceMedalError(409, "Reach level 40 to redeem your next service medal.");
      if (medal.definitionIndex !== definitionIndex)
        throw new ServiceMedalError(409, "Your next service medal has changed. Open the medal preview again.");
      const [owned] = await tx<{ asset_id: string; medal_tier: number }[]>`
        select asset_id, medal_tier from player_service_medals where player_id=${playerId} and medal_year=${medal.year}
      `;
      let assetId: string;
      if (owned) {
        if (owned.medal_tier !== medal.tier - 1) throw new ServiceMedalError(409, "The saved medal tier needs repair.");
        const [updated] = await tx<{ asset_id: string }[]>`
          update player_b2g_inventory_items set definition_index=${medal.definitionIndex},
            display_name=${medal.displayName}, icon_path=${medal.iconPath}
          where player_id=${playerId} and asset_id=${owned.asset_id} and state='active' and source='b2g'
            and weapon_key='service_medal' returning asset_id
        `;
        if (!updated) throw new ServiceMedalError(409, "The owned service medal is unavailable.");
        assetId = updated.asset_id;
        await tx`update player_service_medals set medal_tier=${medal.tier}, updated_at=now()
          where player_id=${playerId} and medal_year=${medal.year}`;
      } else {
        if (medal.tier !== 1) throw new ServiceMedalError(409, "The earlier service medal is missing.");
        const [capacity] = await tx<{ count: number }[]>`
          select count(*)::int as count from player_b2g_inventory_items where player_id=${playerId} and state='active'
        `;
        if ((capacity?.count ?? 0) >= 512) throw new ServiceMedalError(409, "Your B2G inventory is full.");
        const [created] = await tx<{ asset_id: string }[]>`
          insert into player_b2g_inventory_items (
            player_id, asset_id, item_kind, definition_index, weapon_key, display_name,
            icon_path, inventory_position, quality, rarity, origin, loadout_slot
          ) values (
            ${playerId}, nextval('b2g_inventory_asset_id_seq')::text, 'cosmetic',
            ${medal.definitionIndex}, 'service_medal', ${medal.displayName}, ${medal.iconPath},
            1073741844, 4, 6, 24, 55
          ) returning asset_id
        `;
        if (!created) throw new Error("Could not create the service medal.");
        assetId = created.asset_id;
        await tx`insert into player_service_medals(player_id, medal_year, medal_tier, asset_id)
          values (${playerId}, ${medal.year}, ${medal.tier}, ${assetId})`;
      }
      const [receipt] = await tx<{ redeemed_at: Date }[]>`
        insert into player_service_medal_redemptions (
          player_id, prestige, medal_year, medal_tier, definition_index, asset_id, previous_xp
        ) values (${playerId}, ${medal.prestige}, ${medal.year}, ${medal.tier},
          ${medal.definitionIndex}, ${assetId}, ${player.profile_xp}) returning redeemed_at
      `;
      if (!receipt) throw new Error("Could not persist the service medal receipt.");
      const next = advanceProfile({ level: 1, xp: 0 }, player.profile_xp_reserve);
      await tx`update players set service_prestige=${medal.prestige}, profile_level=${next.level},
        profile_xp=${next.xp}, profile_xp_reserve=0, updated_at=now() where id=${playerId}`;
      for (let level = 2; level <= next.level; level++) {
        await grantServiceLevelRewards(tx, playerId, level, medal.prestige, null);
      }
      await tx`insert into audit_log(actor_id, action, target_type, target_id, detail)
        values (${playerId}, 'service_medal.redeemed', 'player', ${playerId},
          ${tx.json({ prestige: medal.prestige, year: medal.year, tier: medal.tier,
            definitionIndex, assetId, previousLevel: 40, previousXp: player.profile_xp,
            nextLevel: next.level, nextXp: next.xp, restoredXp: player.profile_xp_reserve })})`;
      return {
        alreadyCompleted: false, definitionIndex, assetId, prestige: medal.prestige,
        year: medal.year, tier: medal.tier, redeemedAt: receipt.redeemed_at.toISOString(),
        playerLevel: next.level, playerXp: next.xp
      };
    });
  }
}
