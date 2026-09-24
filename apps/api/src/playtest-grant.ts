import { randomInt, randomUUID } from "node:crypto";
import {
  B2G_CASES,
  B2G_DROP_ODDS,
  B2G_PIN_PACKAGES,
  B2G_SERVICE_DROP_ODDS,
  B2G_SOUVENIR_PACKAGES,
  createConnection,
  type B2GContainerDefinition
} from "@aftertick/db";

function numericArgument(name: string): number {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  const index = process.argv.indexOf(`--${name}`);
  return Number(inline?.slice(name.length + 3) ?? (index >= 0 ? process.argv[index + 1] : 0));
}

const steamId = process.argv.find((value) => /^\d{17}$/.test(value));
const revert = process.argv.includes("--revert");
const casesArgument = process.argv.find((value) => value.startsWith("--cases="));
const casesIndex = process.argv.indexOf("--cases");
const gloveCases = process.argv.includes("--glove-cases");
const requestedCaseCount = Number(
  casesArgument?.slice("--cases=".length)
    ?? (casesIndex >= 0 ? process.argv[casesIndex + 1] : 0)
);
const requestedAssortedCaseCount = numericArgument("assorted-cases");
const requestedCobblestonePackageCount = numericArgument("cobblestone-packages");
const requestedPinPackageCount = numericArgument("pin-packages");
const adminGloves = process.argv.includes("--admin-gloves");
const purgeCaseRewards = process.argv.includes("--purge-case-rewards");
const effectiveRequestedCaseCount = requestedAssortedCaseCount || requestedCaseCount;
const adminCaseGrantPurpose = requestedAssortedCaseCount > 0
  ? "b2g-0.2.16-cubsfan49-assorted-case-batch"
  : gloveCases
  ? "b2g-0.2.11-cubsfan49-glove-case-batch"
  : "b2g-0.2.9-cubsfan49-case-batch";
const adminM9GrantPurpose = "b2g-0.2.9-cubsfan49-m9-sapphire";
const adminCobblestoneGrantPurpose = "b2g-0.2.13-cubsfan49-cobblestone-package-batch-2";
const adminPinGrantPurpose = "b2g-0.2.12-cubsfan49-pin-package-batch";
const adminGloveGrantPurpose = "b2g-0.2.16-cubsfan49-minimal-wear-gloves";
const adminCaseRewardResetPurpose = "b2g-0.2.16-cubsfan49-pre-v4-case-reward-reset";
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl || !steamId || !Number.isInteger(requestedCaseCount)
  || requestedCaseCount < 0 || requestedCaseCount > 100
  || !Number.isInteger(requestedAssortedCaseCount)
  || requestedAssortedCaseCount < 0 || requestedAssortedCaseCount > 1_000
  || (requestedCaseCount > 0 && requestedAssortedCaseCount > 0)
  || (gloveCases && requestedAssortedCaseCount > 0)
  || !Number.isInteger(requestedCobblestonePackageCount)
  || requestedCobblestonePackageCount < 0 || requestedCobblestonePackageCount > 100
  || !Number.isInteger(requestedPinPackageCount)
  || requestedPinPackageCount < 0 || requestedPinPackageCount > 100) {
  throw new Error(
    "Usage: DATABASE_URL=... node playtest-grant.js <17-digit-steam-id> [--cases 0..100] "
      + "[--glove-cases] [--cobblestone-packages 0..100] [--pin-packages 0..100] "
      + "[--assorted-cases 0..1000] [--purge-case-rewards] [--admin-gloves] [--revert]"
  );
}

const ADMIN_GLOVES = [
  { definitionIndex: 5030, weaponKey: "sporty_gloves", displayName: "Sport Gloves | Vice", paintIndex: 10048 },
  { definitionIndex: 5030, weaponKey: "sporty_gloves", displayName: "Sport Gloves | Pandora's Box", paintIndex: 10037 },
  { definitionIndex: 5033, weaponKey: "motorcycle_gloves", displayName: "Moto Gloves | Spearmint", paintIndex: 10026 },
  { definitionIndex: 5030, weaponKey: "sporty_gloves", displayName: "Sport Gloves | Hedge Maze", paintIndex: 10038 },
  { definitionIndex: 5034, weaponKey: "specialist_gloves", displayName: "Specialist Gloves | Crimson Kimono", paintIndex: 10033 },
  { definitionIndex: 5031, weaponKey: "slick_gloves", displayName: "Driver Gloves | Snow Leopard", paintIndex: 10070 }
] as const;

const gloveCase = B2G_CASES.find((entry) => entry.internalName === "crate_community_15");
if (gloveCases && !gloveCase) throw new Error("The final-client Glove Case definition is unavailable.");
const cobblestonePackages = B2G_SOUVENIR_PACKAGES.filter(
  (entry) => entry.internalName.endsWith("_promo_de_cbble")
);
if (requestedCobblestonePackageCount > 0 && cobblestonePackages.length === 0) {
  throw new Error("The final-client Cobblestone souvenir package definitions are unavailable.");
}

const sql = createConnection(databaseUrl);
try {
  const result = await sql.begin(async (transaction) => {
    const [player] = await transaction<{
      id: string;
      rating: number;
      profile_level: number;
      profile_xp: number;
    }[]>`
      select id::text, rating, profile_level, profile_xp
      from players where steam_id = ${steamId} for update
    `;
    if (!player) throw new Error(`No B2G player exists for Steam ID ${steamId}.`);
    const [existingCaseRewardReset] = await transaction<{
      deleted_count: number;
      deleted_asset_ids: string[];
    }[]>`
      select coalesce((detail->>'deletedCount')::int, 0) as deleted_count,
             coalesce(array(select jsonb_array_elements_text(detail->'assetIds')), array[]::text[])
               as deleted_asset_ids
      from audit_log
      where action = 'inventory.admin_case_reward_reset'
        and target_id = ${player.id}
        and detail->>'purpose' = ${adminCaseRewardResetPurpose}
      order by created_at desc limit 1
    `;
    let caseRewardsPurged = existingCaseRewardReset?.deleted_count ?? 0;
    let purgedCaseRewardAssetIds = existingCaseRewardReset?.deleted_asset_ids ?? [];
    let caseRewardResetApplied = false;
    if (purgeCaseRewards && !existingCaseRewardReset) {
      const obsoleteRewards = await transaction<{ asset_id: string }[]>`
        select item.asset_id
        from player_b2g_inventory_items item
        join player_b2g_case_grants case_grant on case_grant.id = item.case_grant_id
        where item.player_id = ${player.id}
          and item.item_kind = 'cosmetic'
          and item.state = 'active'
        order by item.asset_id
        for update of item
      `;
      purgedCaseRewardAssetIds = obsoleteRewards.map((item) => item.asset_id);
      if (purgedCaseRewardAssetIds.length > 0) {
        await transaction`
          delete from player_b2g_inventory_items
          where player_id = ${player.id}
            and asset_id = any(${purgedCaseRewardAssetIds})
        `;
      }
      caseRewardsPurged = purgedCaseRewardAssetIds.length;
      const resetId = randomUUID();
      await transaction`
        insert into audit_log (id, action, target_type, target_id, detail)
        values (${resetId}, 'inventory.admin_case_reward_reset', 'player', ${player.id},
          ${transaction.json({
            purpose: adminCaseRewardResetPurpose,
            deletedCount: caseRewardsPurged,
            assetIds: purgedCaseRewardAssetIds,
            scope: "active cosmetics backed directly by a B2G case grant",
            reason: "replace pre-v4 case outcomes after case-pool and inherited-wear corrections"
          })})
      `;
      caseRewardResetApplied = true;
    }
    const [active] = await transaction<{
      id: string;
      previous_rating: number;
    }[]>`
      select grant_row.id::text,
             (grant_row.detail->>'previousRating')::int as previous_rating
      from audit_log grant_row
      where grant_row.action = 'playtest.temp_grant'
        and grant_row.target_id = ${player.id}
        and not exists (
          select 1 from audit_log reverted
          where reverted.action = 'playtest.temp_grant.reverted'
            and reverted.detail->>'grantId' = grant_row.id::text
        )
      order by grant_row.created_at desc limit 1
    `;
    const [existingCaseBatch] = await transaction<{ id: string; case_count: number }[]>`
      select audit.id::text,
             (select count(*)::int from player_b2g_case_grants case_grant
               where case_grant.player_id = ${player.id}
                 and case_grant.batch_id = audit.id) as case_count
      from audit_log audit
      where audit.action = 'inventory.admin_case_grant'
        and audit.target_id = ${player.id}
        and audit.detail->>'purpose' = ${adminCaseGrantPurpose}
      order by audit.created_at desc limit 1
    `;
    let adminCaseCount = existingCaseBatch?.case_count ?? 0;
    let casesAdded = false;
    if (effectiveRequestedCaseCount > 0 && !existingCaseBatch) {
      const caseBatchId = randomUUID();
      for (let index = 0; index < effectiveRequestedCaseCount; index += 1) {
        const droppedCase = requestedAssortedCaseCount > 0
          ? B2G_CASES[index % B2G_CASES.length]
          : gloveCase ?? B2G_CASES[randomInt(B2G_CASES.length)];
        if (!droppedCase) throw new Error("The B2G case catalog is empty.");
        const [assetIds] = await transaction<{ case_asset_id: string; key_asset_id: string }[]>`
          select nextval('b2g_inventory_asset_id_seq')::text as case_asset_id,
                 nextval('b2g_inventory_asset_id_seq')::text as key_asset_id
        `;
        if (!assetIds) throw new Error("Could not allocate admin-granted case assets.");
        const [caseGrant] = await transaction<{ id: string }[]>`
          insert into player_b2g_case_grants (
            player_id, grant_type, batch_id,
            case_definition_index, key_definition_index,
            case_asset_id, key_asset_id, odds_version
          ) values (
            ${player.id}, 'admin', ${caseBatchId},
            ${droppedCase.definitionIndex}, ${droppedCase.keyDefinitionIndex},
            ${assetIds.case_asset_id}, ${assetIds.key_asset_id}, ${B2G_DROP_ODDS.version}
          )
          returning id::text
        `;
        if (!caseGrant) throw new Error("Could not persist an admin case grant.");
        const inventoryPosition = 1_073_742_000 + index * 2;
        await transaction`
          insert into player_b2g_inventory_items (
            player_id, asset_id, case_grant_id, item_kind, definition_index,
            weapon_key, display_name, icon_path, inventory_position,
            quality, rarity, origin, loadout_slot
          ) values
          (
            ${player.id}, ${assetIds.case_asset_id}, ${caseGrant.id}, 'case',
            ${droppedCase.definitionIndex}, 'b2g_case', ${droppedCase.displayName},
            ${droppedCase.iconPath}, ${inventoryPosition}, 4, 1, 24, 0
          ),
          (
            ${player.id}, ${assetIds.key_asset_id}, ${caseGrant.id}, 'key',
            ${droppedCase.keyDefinitionIndex}, 'b2g_key', 'B2G Case Key',
            null, ${inventoryPosition + 1}, 4, 1, 24, 0
          )
        `;
      }
      await transaction`
        insert into audit_log (id, action, target_type, target_id, detail)
        values (${caseBatchId}, 'inventory.admin_case_grant', 'player', ${player.id},
          ${transaction.json({
            purpose: adminCaseGrantPurpose,
            caseCount: effectiveRequestedCaseCount,
            caseDefinitionIndex: gloveCase?.definitionIndex ?? null,
            caseName: requestedAssortedCaseCount > 0
              ? "even assortment across every supported legacy case"
              : gloveCases ? "Glove Case" : "uniform legacy case pool",
            distinctCaseDefinitions: requestedAssortedCaseCount > 0 ? B2G_CASES.length : null,
            oddsVersion: B2G_DROP_ODDS.version,
            permanent: true
          })})
      `;
      adminCaseCount = effectiveRequestedCaseCount;
      casesAdded = true;
    }
    const grantAdminContainers = async (options: {
      count: number;
      purpose: string;
      containerType: "pin_package" | "souvenir_package";
      catalog: readonly B2GContainerDefinition[];
      inventoryBase: number;
    }): Promise<{ count: number; added: boolean }> => {
      const [existingBatch] = await transaction<{ id: string; container_count: number }[]>`
        select audit.id::text,
               (select count(*)::int from player_b2g_container_grants container_grant
                 where container_grant.player_id = ${player.id}
                   and container_grant.batch_id = audit.id) as container_count
        from audit_log audit
        where audit.action = 'inventory.admin_container_grant'
          and audit.target_id = ${player.id}
          and audit.detail->>'purpose' = ${options.purpose}
        order by audit.created_at desc limit 1
      `;
      if (options.count === 0 || existingBatch) {
        return { count: existingBatch?.container_count ?? 0, added: false };
      }
      const batchId = randomUUID();
      for (let index = 0; index < options.count; index += 1) {
        const container = options.catalog[randomInt(options.catalog.length)];
        if (!container) throw new Error(`The ${options.containerType} admin catalog is empty.`);
        const [asset] = await transaction<{ asset_id: string }[]>`
          select nextval('b2g_inventory_asset_id_seq')::text as asset_id
        `;
        if (!asset) throw new Error("Could not allocate an admin reward container asset.");
        const [containerGrant] = await transaction<{ id: string }[]>`
          insert into player_b2g_container_grants (
            player_id, batch_id, grant_type, container_type,
            container_definition_index, container_asset_id, odds_version
          ) values (
            ${player.id}, ${batchId}, 'admin', ${options.containerType},
            ${container.definitionIndex}, ${asset.asset_id}, ${B2G_SERVICE_DROP_ODDS.version}
          )
          returning id::text
        `;
        if (!containerGrant) throw new Error("Could not persist an admin reward container grant.");
        await transaction`
          insert into player_b2g_inventory_items (
            player_id, asset_id, container_grant_id, item_kind, definition_index,
            weapon_key, display_name, icon_path, inventory_position,
            quality, rarity, origin, loadout_slot
          ) values (
            ${player.id}, ${asset.asset_id}, ${containerGrant.id}, 'case',
            ${container.definitionIndex}, ${options.containerType}, ${container.displayName},
            ${container.iconPath}, ${options.inventoryBase + index}, 4, 1, 24, 0
          )
        `;
      }
      await transaction`
        insert into audit_log (id, action, target_type, target_id, detail)
        values (${batchId}, 'inventory.admin_container_grant', 'player', ${player.id},
          ${transaction.json({
            purpose: options.purpose,
            containerType: options.containerType,
            containerCount: options.count,
            definitionIndexes: options.catalog.map((entry) => entry.definitionIndex),
            oddsVersion: B2G_SERVICE_DROP_ODDS.version,
            permanent: true
          })})
      `;
      return { count: options.count, added: true };
    };
    const cobblestoneGrant = await grantAdminContainers({
      count: requestedCobblestonePackageCount,
      purpose: adminCobblestoneGrantPurpose,
      containerType: "souvenir_package",
      catalog: cobblestonePackages,
      inventoryBase: 1_073_742_500
    });
    const pinGrant = await grantAdminContainers({
      count: requestedPinPackageCount,
      purpose: adminPinGrantPurpose,
      containerType: "pin_package",
      catalog: B2G_PIN_PACKAGES,
      inventoryBase: 1_073_742_700
    });
    type GrantedGlove = {
      asset_id: string;
      display_name: string;
      paint_wear: number;
      paint_seed: number;
    };
    const existingGloves = await transaction<GrantedGlove[]>`
      select item.asset_id, item.display_name, item.paint_wear, item.paint_seed
      from audit_log audit
      join player_b2g_inventory_items item
        on item.player_id = ${player.id}
       and item.asset_id = any (
         select jsonb_array_elements_text(audit.detail->'assetIds')
       )
       and item.item_kind = 'cosmetic'
       and item.state = 'active'
      where audit.action = 'inventory.admin_glove_grant'
        and audit.target_id = ${player.id}
        and audit.detail->>'purpose' = ${adminGloveGrantPurpose}
      order by item.display_name
    `;
    let grantedGloves: GrantedGlove[] = [...existingGloves];
    let glovesAdded = false;
    if (adminGloves && existingGloves.length === 0) {
      const assetIds: string[] = [];
      const createdGloves: GrantedGlove[] = [];
      for (const glove of ADMIN_GLOVES) {
        const [allocated] = await transaction<{ asset_id: string }[]>`
          select nextval('b2g_inventory_asset_id_seq')::text as asset_id
        `;
        if (!allocated) throw new Error(`Could not allocate ${glove.displayName}.`);
        const paintWear = randomInt(70_000_000, 150_000_000) / 1_000_000_000;
        const paintSeed = randomInt(1, 1_001);
        const [created] = await transaction<GrantedGlove[]>`
          insert into player_b2g_inventory_items (
            player_id, asset_id, item_kind, definition_index, weapon_key, display_name,
            inventory_position, paint_index, paint_wear, paint_seed,
            quality, rarity, origin, loadout_slot
          ) values (
            ${player.id}, ${allocated.asset_id}, 'cosmetic', ${glove.definitionIndex},
            ${glove.weaponKey}, ${glove.displayName}, 1073741829, ${glove.paintIndex},
            ${paintWear}, ${paintSeed}, 3, 6, 24, 41
          )
          returning asset_id, display_name, paint_wear, paint_seed
        `;
        if (!created) throw new Error(`Could not persist ${glove.displayName}.`);
        assetIds.push(created.asset_id);
        createdGloves.push(created);
      }
      const gloveGrantId = randomUUID();
      await transaction`
        insert into audit_log (id, action, target_type, target_id, detail)
        values (${gloveGrantId}, 'inventory.admin_glove_grant', 'player', ${player.id},
          ${transaction.json({
            purpose: adminGloveGrantPurpose,
            assetIds,
            wearClass: "Minimal Wear",
            wearRange: { minimumInclusive: 0.07, maximumExclusive: 0.15 },
            permanent: true
          })})
      `;
      grantedGloves = createdGloves.sort((left, right) =>
        left.display_name.localeCompare(right.display_name));
      glovesAdded = true;
    }
    const [existingM9Grant] = await transaction<{ asset_id: string }[]>`
      select item.asset_id
      from audit_log audit
      join player_b2g_inventory_items item
        on item.player_id = ${player.id}
       and item.asset_id = audit.detail->>'assetId'
       and item.item_kind = 'cosmetic'
       and item.state = 'active'
      where audit.action = 'inventory.admin_item_grant'
        and audit.target_id = ${player.id}
        and audit.detail->>'purpose' = ${adminM9GrantPurpose}
      order by audit.created_at desc limit 1
    `;
    let adminM9AssetId = existingM9Grant?.asset_id ?? null;
    let m9Added = false;
    if (!adminM9AssetId) {
      const [allocated] = await transaction<{ asset_id: string }[]>`
        select nextval('b2g_inventory_asset_id_seq')::text as asset_id
      `;
      if (!allocated) throw new Error("Could not allocate the permanent M9 Sapphire asset.");
      await transaction`
        insert into player_b2g_inventory_items (
          player_id, asset_id, item_kind, definition_index, weapon_key, display_name,
          inventory_position, paint_index, paint_wear, paint_seed,
          quality, rarity, origin, loadout_slot
        ) values (
          ${player.id}, ${allocated.asset_id}, 'cosmetic', 508, 'knife_m9_bayonet',
          'M9 Bayonet | Doppler (Sapphire)', 1073741825, 416, 0.007, 1, 3, 6, 24, 0
        )
      `;
      const m9GrantId = randomUUID();
      await transaction`
        insert into audit_log (id, action, target_type, target_id, detail)
        values (${m9GrantId}, 'inventory.admin_item_grant', 'player', ${player.id},
          ${transaction.json({
            purpose: adminM9GrantPurpose,
            assetId: allocated.asset_id,
            definitionIndex: 508,
            paintIndex: 416,
            paintKit: "am_sapphire_marbleized",
            paintWear: 0.007,
            permanent: true
          })})
      `;
      adminM9AssetId = allocated.asset_id;
      m9Added = true;
    }
    if (adminM9AssetId) {
      await transaction`
        delete from player_cosmetic_loadouts
        where player_id = ${player.id} and weapon_key like 'knife%'
      `;
      await transaction`
        insert into player_cosmetic_loadouts (player_id, weapon_key, asset_id)
        values (${player.id}, 'knife_m9_bayonet', ${adminM9AssetId})
      `;
    }
    if (revert) {
      if (!active) return {
        changed: false,
        action: "revert",
        playerId: player.id,
        adminCaseCount,
        caseRewardsPurged,
        purgedCaseRewardAssetIds,
        caseRewardResetApplied,
        adminCobblestonePackageCount: cobblestoneGrant.count,
        adminPinPackageCount: pinGrant.count,
        grantedGloves,
        glovesAdded,
        adminM9AssetId,
        profileLevel: player.profile_level,
        profileXp: player.profile_xp
      };
      await transaction`update players set rating = ${active.previous_rating}, updated_at = now() where id = ${player.id}`;
      await transaction`
        insert into audit_log (action, target_type, target_id, detail)
        values ('playtest.temp_grant.reverted', 'player', ${player.id},
          ${transaction.json({ grantId: active.id, restoredRating: active.previous_rating })})
      `;
      return {
        changed: true,
        action: "revert",
        playerId: player.id,
        restoredRating: active.previous_rating,
        adminCaseCount,
        caseRewardsPurged,
        purgedCaseRewardAssetIds,
        caseRewardResetApplied,
        adminCobblestonePackageCount: cobblestoneGrant.count,
        adminPinPackageCount: pinGrant.count,
        grantedGloves,
        glovesAdded,
        adminM9AssetId,
        profileLevel: player.profile_level,
        profileXp: player.profile_xp
      };
    }
    if (active) {
      return {
        changed: false,
        action: "apply",
        playerId: player.id,
        rating: 2500,
        adminCaseCount,
        caseRewardsPurged,
        purgedCaseRewardAssetIds,
        caseRewardResetApplied,
        adminCobblestonePackageCount: cobblestoneGrant.count,
        adminPinPackageCount: pinGrant.count,
        grantedGloves,
        glovesAdded,
        adminM9AssetId,
        casesAdded,
        cobblestonePackagesAdded: cobblestoneGrant.added,
        pinPackagesAdded: pinGrant.added,
        m9Added,
        profileLevel: player.profile_level,
        profileXp: player.profile_xp
      };
    }
    await transaction`update players set rating = 2500, updated_at = now() where id = ${player.id}`;
    const grantId = randomUUID();
    await transaction`
      insert into audit_log (id, action, target_type, target_id, detail)
      values (${grantId}, 'playtest.temp_grant', 'player', ${player.id},
        ${transaction.json({
          previousRating: player.rating,
          temporaryRating: 2500
        })})
    `;
    return {
      changed: true,
      action: "apply",
      playerId: player.id,
      rating: 2500,
      adminCaseCount,
      caseRewardsPurged,
      purgedCaseRewardAssetIds,
      caseRewardResetApplied,
      adminCobblestonePackageCount: cobblestoneGrant.count,
      adminPinPackageCount: pinGrant.count,
      grantedGloves,
      glovesAdded,
      adminM9AssetId,
      casesAdded,
      cobblestonePackagesAdded: cobblestoneGrant.added,
      pinPackagesAdded: pinGrant.added,
      m9Added,
      previousRating: player.rating,
      profileLevel: player.profile_level,
      profileXp: player.profile_xp
    };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await sql.end();
}
