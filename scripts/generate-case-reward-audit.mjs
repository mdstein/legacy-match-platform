import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [outputArg] = process.argv.slice(2);
if (!outputArg) {
  throw new Error("Usage: node scripts/generate-case-reward-audit.mjs <output.sql>");
}

const catalogPath = resolve("packages/db/src/drop-catalog.ts");
const catalogSource = await readFile(catalogPath, "utf8");
const declaration = catalogSource.indexOf("export const B2G_CASES");
const jsonStart = catalogSource.indexOf("= [", declaration) + 2;
const jsonEnd = catalogSource.indexOf("] as const", jsonStart) + 1;
if (declaration < 0 || jsonStart < 2 || jsonEnd <= jsonStart) {
  throw new Error("Could not locate the generated B2G case catalog.");
}

const cases = JSON.parse(catalogSource.slice(jsonStart, jsonEnd));
const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;
const rows = [];
for (const caseDefinition of cases) {
  for (const [special, rewards] of [
    [false, caseDefinition.rewards],
    [true, caseDefinition.specialRewards]
  ]) {
    for (const reward of rewards) {
      rows.push(`(${[
        caseDefinition.definitionIndex,
        reward.definitionIndex,
        reward.paintIndex,
        reward.minWear,
        reward.maxWear,
        reward.rarity,
        sqlText(reward.weaponKey),
        reward.loadoutSlot,
        special ? "TRUE" : "FALSE"
      ].join(", ")})`);
    }
  }
}

const output = `\\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE expected_b2g_case_rewards (
  case_definition_index integer NOT NULL,
  definition_index integer NOT NULL,
  paint_index integer NOT NULL,
  min_wear double precision NOT NULL,
  max_wear double precision NOT NULL,
  rarity integer NOT NULL,
  weapon_key text NOT NULL,
  loadout_slot integer NOT NULL,
  special boolean NOT NULL,
  PRIMARY KEY (case_definition_index, definition_index, paint_index)
) ON COMMIT DROP;

INSERT INTO expected_b2g_case_rewards (
  case_definition_index, definition_index, paint_index, min_wear, max_wear,
  rarity, weapon_key, loadout_slot, special
) VALUES
${rows.join(",\n")}
ON CONFLICT DO NOTHING;

WITH opened AS (
  SELECT grant_row.id AS grant_id,
         grant_row.player_id,
         grant_row.case_definition_index,
         grant_row.odds_version,
         grant_row.result_asset_id,
         item.definition_index,
         item.paint_index,
         item.paint_wear,
         item.rarity,
         item.weapon_key,
         item.loadout_slot
  FROM player_b2g_case_grants grant_row
  LEFT JOIN player_b2g_inventory_items item
    ON item.player_id = grant_row.player_id
   AND item.asset_id = grant_row.result_asset_id
   AND item.case_grant_id = grant_row.id
   AND item.item_kind = 'cosmetic'
  WHERE grant_row.opened_at IS NOT NULL
), invalid AS (
  SELECT opened.*,
         expected.min_wear,
         expected.max_wear,
         expected.special
  FROM opened
  LEFT JOIN expected_b2g_case_rewards expected
    ON expected.case_definition_index = opened.case_definition_index
   AND expected.definition_index = opened.definition_index
   AND expected.paint_index = opened.paint_index
   AND expected.rarity = opened.rarity
   AND expected.weapon_key = opened.weapon_key
   AND expected.loadout_slot = opened.loadout_slot
  WHERE expected.case_definition_index IS NULL
     OR opened.paint_wear < expected.min_wear
     OR opened.paint_wear > expected.max_wear
)
SELECT grant_id, player_id, case_definition_index, odds_version,
       result_asset_id, definition_index, paint_index, paint_wear, rarity,
       weapon_key, loadout_slot, min_wear, max_wear, special
FROM invalid
ORDER BY grant_id;

SELECT
  (SELECT count(*) FROM player_b2g_case_grants WHERE opened_at IS NOT NULL)
    AS opened_case_count,
  (SELECT count(*)
   FROM player_b2g_case_grants grant_row
   JOIN player_b2g_inventory_items item
     ON item.player_id = grant_row.player_id
    AND item.asset_id = grant_row.result_asset_id
    AND item.case_grant_id = grant_row.id
   JOIN expected_b2g_case_rewards expected
     ON expected.case_definition_index = grant_row.case_definition_index
    AND expected.definition_index = item.definition_index
    AND expected.paint_index = item.paint_index
    AND expected.rarity = item.rarity
    AND expected.weapon_key = item.weapon_key
    AND expected.loadout_slot = item.loadout_slot
   WHERE grant_row.opened_at IS NOT NULL
     AND item.item_kind = 'cosmetic'
     AND item.paint_wear BETWEEN expected.min_wear AND expected.max_wear)
    AS valid_case_reward_count,
  (SELECT count(DISTINCT case_definition_index) FROM expected_b2g_case_rewards)
    AS catalog_case_count,
  (SELECT count(*) FROM expected_b2g_case_rewards)
    AS catalog_reward_count;

COMMIT;
`;

const outputPath = resolve(outputArg);
await writeFile(outputPath, output, "utf8");
console.log(JSON.stringify({ outputPath, cases: cases.length, rewards: rows.length }));
