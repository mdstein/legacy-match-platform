import { randomInt } from "node:crypto";
import type postgres from "postgres";
import {
  B2G_CASES,
  B2G_DROP_ODDS,
  B2G_GRAFFITI,
  B2G_PIN_PACKAGES,
  B2G_SERVICE_DROP_ODDS,
  B2G_SOUVENIR_PACKAGES
} from "../drop-catalog.js";

export type ServiceRewardKind = "case" | "pin_package" | "souvenir_package";

export function chooseServiceRewardKind(roll: number): ServiceRewardKind {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 10_000) {
    throw new RangeError("Service reward roll must be an integer from 0 through 9999.");
  }
  if (roll < B2G_SERVICE_DROP_ODDS.kindBasisPoints.case) return "case";
  if (roll < B2G_SERVICE_DROP_ODDS.kindBasisPoints.case
    + B2G_SERVICE_DROP_ODDS.kindBasisPoints.pinPackage) return "pin_package";
  return "souvenir_package";
}

export async function grantServiceLevelRewards(tx: postgres.TransactionSql, playerId: string, level: number, prestige: number, matchId: string | null) {
        const [reward] = await tx<{
          id: string;
          service_level: number;
        }[]>`
          INSERT INTO player_service_drops (
            player_id, match_id, service_level, reward_type, service_prestige
          ) VALUES (
            ${playerId}, ${matchId}, ${level}, 'b2g_service_drop', ${prestige}
          )
          RETURNING id, service_level
        `;
        if (!reward) {
          throw new Error(`Could not persist service drop for roster player ${playerId}.`);
        }
        const serviceDrop = {
          id: reward.id,
          serviceLevel: reward.service_level,
            rewardType: "b2g_service_drop" as const
          };
        for (let dropSlot = 1; dropSlot <= B2G_SERVICE_DROP_ODDS.primaryRewardsPerLevel; dropSlot += 1) {
          const rewardKind = chooseServiceRewardKind(randomInt(10_000));
          if (rewardKind === "case") {
            const droppedCase = B2G_CASES[randomInt(B2G_CASES.length)];
            if (!droppedCase) throw new Error("The B2G case catalog is empty.");
            const [assetIds] = await tx<{ case_asset_id: string; key_asset_id: string }[]>`
              select nextval('b2g_inventory_asset_id_seq')::text as case_asset_id,
                     nextval('b2g_inventory_asset_id_seq')::text as key_asset_id
            `;
            if (!assetIds) throw new Error("Could not allocate B2G inventory assets.");
            const [caseGrant] = await tx<{ id: string }[]>`
              insert into player_b2g_case_grants (
                player_id, service_drop_id, grant_type, drop_slot,
                case_definition_index, key_definition_index,
                case_asset_id, key_asset_id, odds_version
              ) values (
                ${playerId}, ${reward.id}, 'service_level', ${dropSlot},
                ${droppedCase.definitionIndex}, ${droppedCase.keyDefinitionIndex},
                ${assetIds.case_asset_id}, ${assetIds.key_asset_id}, ${B2G_DROP_ODDS.version}
              )
              returning id
            `;
            if (!caseGrant) throw new Error(`Could not persist case grant for roster player ${playerId}.`);
            await tx`
              insert into player_b2g_inventory_items (
                player_id, asset_id, case_grant_id, item_kind, definition_index,
                weapon_key, display_name, icon_path, inventory_position,
                quality, rarity, origin, loadout_slot
              ) values
              (
                ${playerId}, ${assetIds.case_asset_id}, ${caseGrant.id}, 'case',
                ${droppedCase.definitionIndex}, 'b2g_case', ${droppedCase.displayName},
                ${droppedCase.iconPath}, ${1_073_741_824 + dropSlot}, 4, 1, 24, 0
              ),
              (
                ${playerId}, ${assetIds.key_asset_id}, ${caseGrant.id}, 'key',
                ${droppedCase.keyDefinitionIndex}, 'b2g_key', 'B2G Case Key',
                null, ${2 + dropSlot}, 4, 1, 24, 0
              )
            `;
            continue;
          }

          const catalog = rewardKind === "pin_package"
            ? B2G_PIN_PACKAGES
            : B2G_SOUVENIR_PACKAGES;
          const container = catalog[randomInt(catalog.length)];
          if (!container) throw new Error(`The B2G ${rewardKind} catalog is empty.`);
          const [asset] = await tx<{ asset_id: string }[]>`
            select nextval('b2g_inventory_asset_id_seq')::text as asset_id
          `;
          if (!asset) throw new Error("Could not allocate a B2G reward container.");
          const [containerGrant] = await tx<{ id: string }[]>`
            insert into player_b2g_container_grants (
              player_id, service_drop_id, drop_slot, container_type,
              container_definition_index, container_asset_id, odds_version
            ) values (
              ${playerId}, ${reward.id}, ${dropSlot}, ${rewardKind},
              ${container.definitionIndex}, ${asset.asset_id}, ${B2G_SERVICE_DROP_ODDS.version}
            )
            returning id
          `;
          if (!containerGrant) throw new Error(`Could not persist ${rewardKind} for roster player ${playerId}.`);
          await tx`
            insert into player_b2g_inventory_items (
              player_id, asset_id, container_grant_id, item_kind, definition_index,
              weapon_key, display_name, icon_path, inventory_position,
              quality, rarity, origin, loadout_slot
            ) values (
              ${playerId}, ${asset.asset_id}, ${containerGrant.id}, 'case',
              ${container.definitionIndex}, ${rewardKind}, ${container.displayName},
              ${container.iconPath}, ${1_073_741_824 + dropSlot}, 4, 1, 24, 0
            )
          `;
        }
        const graffiti = B2G_GRAFFITI[randomInt(B2G_GRAFFITI.length)];
        if (!graffiti) throw new Error("The B2G graffiti catalog is empty.");
        const [graffitiAsset] = await tx<{ asset_id: string }[]>`
          select nextval('b2g_inventory_asset_id_seq')::text as asset_id
        `;
        if (!graffitiAsset) throw new Error("Could not allocate a B2G graffiti reward.");
        const graffitiTint = randomInt(1, 20);
        const [directGrant] = await tx<{ id: string }[]>`
          insert into player_b2g_direct_reward_grants (
            player_id, service_drop_id, drop_slot, reward_type, sealed_asset_id,
            spray_kit_id, spray_tint_id, charges, odds_version
          ) values (
            ${playerId}, ${reward.id}, 3, 'graffiti', ${graffitiAsset.asset_id},
            ${graffiti.sprayKitId}, ${graffitiTint}, ${B2G_SERVICE_DROP_ODDS.graffitiCharges},
            ${B2G_SERVICE_DROP_ODDS.version}
          )
          returning id
        `;
        if (!directGrant) throw new Error(`Could not persist graffiti grant for roster player ${playerId}.`);
        await tx`
          insert into player_b2g_inventory_items (
            player_id, asset_id, direct_reward_grant_id, item_kind, definition_index,
            weapon_key, display_name, icon_path, inventory_position, quality,
            rarity, origin, loadout_slot, spray_kit_id, spray_tint_id
          ) values (
            ${playerId}, ${graffitiAsset.asset_id}, ${directGrant.id}, 'cosmetic', 1348,
            'graffiti', ${graffiti.displayName}, null, 1073741827, 4,
            ${graffiti.rarity}, 24, 56, ${graffiti.sprayKitId}, ${graffitiTint}
          )
        `;
  return serviceDrop;
}
