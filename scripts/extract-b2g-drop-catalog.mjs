import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function tokenize(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    if (/\s/.test(input[index])) {
      index += 1;
      continue;
    }
    if (input[index] === "/" && input[index + 1] === "/") {
      index = input.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (input[index] === "{" || input[index] === "}") {
      tokens.push(input[index++]);
      continue;
    }
    if (input[index] !== '"') throw new Error(`Unexpected items_game token at byte ${index}.`);
    index += 1;
    let value = "";
    while (index < input.length && input[index] !== '"') {
      if (input[index] === "\\" && index + 1 < input.length) index += 1;
      value += input[index++];
    }
    if (input[index] !== '"') throw new Error("Unterminated items_game string.");
    tokens.push(value);
    index += 1;
  }
  return tokens;
}

function mergeMap(target, source) {
  for (const [key, value] of source) {
    const previous = target.get(key);
    if (previous instanceof Map && value instanceof Map) mergeMap(previous, value);
    else target.set(key, value);
  }
}

function parseObject(tokens, cursor) {
  const result = new Map();
  while (cursor.index < tokens.length && tokens[cursor.index] !== "}") {
    const key = tokens[cursor.index++];
    const value = tokens[cursor.index++];
    if (typeof key !== "string" || value === undefined) throw new Error("Malformed items_game object.");
    if (value === "{") {
      const nested = parseObject(tokens, cursor);
      if (tokens[cursor.index++] !== "}") throw new Error("Unclosed items_game object.");
      const previous = result.get(key);
      if (previous instanceof Map) mergeMap(previous, nested);
      else result.set(key, nested);
    } else {
      result.set(key, value);
    }
  }
  return result;
}

const WEAPONS = new Map([
  ["weapon_deagle", [1, "deagle", "Desert Eagle", 6]],
  ["weapon_elite", [2, "elite", "Dual Berettas", 3]],
  ["weapon_fiveseven", [3, "fiveseven", "Five-SeveN", 5]],
  ["weapon_glock", [4, "glock", "Glock-18", 2]],
  ["weapon_ak47", [7, "ak47", "AK-47", 15]],
  ["weapon_aug", [8, "aug", "AUG", 17]],
  ["weapon_awp", [9, "awp", "AWP", 18]],
  ["weapon_famas", [10, "famas", "FAMAS", 14]],
  ["weapon_g3sg1", [11, "g3sg1", "G3SG1", 19]],
  ["weapon_galilar", [13, "galilar", "Galil AR", 14]],
  ["weapon_m249", [14, "m249", "M249", 23]],
  ["weapon_m4a1", [16, "m4a4", "M4A4", 15]],
  ["weapon_mac10", [17, "mac10", "MAC-10", 8]],
  ["weapon_p90", [19, "p90", "P90", 11]],
  ["weapon_mp5sd", [23, "mp5sd", "MP5-SD", 9]],
  ["weapon_ump45", [24, "ump45", "UMP-45", 10]],
  ["weapon_xm1014", [25, "xm1014", "XM1014", 21]],
  ["weapon_bizon", [26, "bizon", "PP-Bizon", 12]],
  ["weapon_mag7", [27, "mag7", "MAG-7", 22]],
  ["weapon_negev", [28, "negev", "Negev", 24]],
  ["weapon_sawedoff", [29, "sawedoff", "Sawed-Off", 22]],
  ["weapon_tec9", [30, "tec9", "Tec-9", 5]],
  ["weapon_hkp2000", [32, "hkp2000", "P2000", 2]],
  ["weapon_mp7", [33, "mp7", "MP7", 9]],
  ["weapon_mp9", [34, "mp9", "MP9", 8]],
  ["weapon_nova", [35, "nova", "Nova", 20]],
  ["weapon_p250", [36, "p250", "P250", 4]],
  ["weapon_scar20", [38, "scar20", "SCAR-20", 19]],
  ["weapon_sg556", [39, "sg556", "SG 553", 17]],
  ["weapon_ssg08", [40, "ssg08", "SSG 08", 16]],
  ["weapon_m4a1_silencer", [60, "m4a1_silencer", "M4A1-S", 15]],
  ["weapon_usp_silencer", [61, "usp_silencer", "USP-S", 2]],
  ["weapon_cz75a", [63, "cz75a", "CZ75-Auto", 5]],
  ["weapon_revolver", [64, "revolver", "R8 Revolver", 6]],
]);

const KNIVES = new Map([
  ["weapon_bayonet", [500, "knife_bayonet", "Bayonet", 0]],
  ["weapon_knife_css", [503, "knife_css", "Classic Knife", 0]],
  ["weapon_knife_flip", [505, "knife_flip", "Flip Knife", 0]],
  ["weapon_knife_gut", [506, "knife_gut", "Gut Knife", 0]],
  ["weapon_knife_karambit", [507, "knife_karambit", "Karambit", 0]],
  ["weapon_knife_m9_bayonet", [508, "knife_m9_bayonet", "M9 Bayonet", 0]],
  ["weapon_knife_tactical", [509, "knife_tactical", "Huntsman Knife", 0]],
  ["weapon_knife_falchion", [512, "knife_falchion", "Falchion Knife", 0]],
  ["weapon_knife_survival_bowie", [514, "knife_survival_bowie", "Bowie Knife", 0]],
  ["weapon_knife_butterfly", [515, "knife_butterfly", "Butterfly Knife", 0]],
  ["weapon_knife_push", [516, "knife_push", "Shadow Daggers", 0]],
  ["weapon_knife_cord", [517, "knife_cord", "Paracord Knife", 0]],
  ["weapon_knife_canis", [518, "knife_canis", "Survival Knife", 0]],
  ["weapon_knife_ursus", [519, "knife_ursus", "Ursus Knife", 0]],
  ["weapon_knife_gypsy_jackknife", [520, "knife_gypsy_jackknife", "Navaja Knife", 0]],
  ["weapon_knife_outdoor", [521, "knife_outdoor", "Nomad Knife", 0]],
  ["weapon_knife_stiletto", [522, "knife_stiletto", "Stiletto Knife", 0]],
  ["weapon_knife_widowmaker", [523, "knife_widowmaker", "Talon Knife", 0]],
  ["weapon_knife_skeleton", [525, "knife_skeleton", "Skeleton Knife", 0]],
]);

const GLOVES = new Map([
  ["studded_bloodhound_gloves", [5027, "studded_bloodhound_gloves", "Bloodhound Gloves", 41]],
  ["sporty_gloves", [5030, "sporty_gloves", "Sport Gloves", 41]],
  ["slick_gloves", [5031, "slick_gloves", "Driver Gloves", 41]],
  ["leather_handwraps", [5032, "leather_handwraps", "Hand Wraps", 41]],
  ["motorcycle_gloves", [5033, "motorcycle_gloves", "Moto Gloves", 41]],
  ["specialist_gloves", [5034, "specialist_gloves", "Specialist Gloves", 41]],
  ["studded_hydra_gloves", [5035, "studded_hydra_gloves", "Hydra Gloves", 41]],
  ["studded_brokenfang_gloves", [4725, "studded_brokenfang_gloves", "Broken Fang Gloves", 41]],
]);

const PAINTABLE_ITEMS = new Map([...WEAPONS, ...KNIVES, ...GLOVES]);

const RARITY_BY_SUFFIX = new Map([
  ["_common", 1], ["_uncommon", 2], ["_rare", 3], ["_mythical", 4],
  ["_legendary", 5], ["_ancient", 6]
]);

const RARITY_BY_NAME = new Map([
  ["common", 1], ["uncommon", 2], ["rare", 3], ["mythical", 4],
  ["legendary", 5], ["ancient", 6]
]);

function section(root, name) {
  const value = root.get(name);
  if (!(value instanceof Map)) throw new Error(`items_game has no ${name} section.`);
  return value;
}

function directString(map, key) {
  const value = map instanceof Map ? map.get(key) : undefined;
  return typeof value === "string" ? value : null;
}

function humanize(value) {
  return value.replace(/^(?:crate_|cu_|gs_|am_|aq_|hy_|sp_|so_|an_|aa_)/, "")
    .split("_").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function suffixRarity(name, inherited) {
  for (const [suffix, rarity] of RARITY_BY_SUFFIX) if (name.endsWith(suffix)) return rarity;
  return inherited;
}

function parsePaintedName(value) {
  const match = value.match(/^\[([^\]]+)](.+)$/);
  return match ? { paintName: match[1], itemName: match[2] } : null;
}

const [inputArg, unusualInputArg, outputArg, localizationArg] = process.argv.slice(2);
if (!inputArg || !unusualInputArg || !outputArg) {
  throw new Error(
    "Usage: node scripts/extract-b2g-drop-catalog.mjs <items_game.txt> "
      + "<unusual_loot_lists.txt> <output.ts> [csgo_english.txt]"
  );
}

const inputPath = resolve(inputArg);
const unusualInputPath = resolve(unusualInputArg);
const outputPath = resolve(outputArg);
const input = await readFile(inputPath, "utf8");
const unusualInput = await readFile(unusualInputPath, "utf8");
const localizationPath = localizationArg ? resolve(localizationArg) : null;
const localizationInput = localizationPath
  ? await readFile(localizationPath).then((contents) => contents[0] === 0xff && contents[1] === 0xfe
    ? contents.subarray(2).toString("utf16le")
    : contents.toString("utf8"))
  : null;
const tokens = tokenize(input);
const cursor = { index: 0 };
if (tokens[cursor.index++] !== "items_game" || tokens[cursor.index++] !== "{") {
  throw new Error("Input is not a CS:GO items_game KeyValues file.");
}
const root = parseObject(tokens, cursor);
if (tokens[cursor.index++] !== "}" || cursor.index !== tokens.length) {
  throw new Error("Trailing or unclosed items_game data.");
}

const items = section(root, "items");
const paintKits = section(root, "paint_kits");
const paintKitRarities = section(root, "paint_kits_rarity");
const stickerKits = section(root, "sticker_kits");
const lootLists = section(root, "client_loot_lists");
const revolving = section(root, "revolving_loot_lists");
let localizationTokens = new Map();
if (localizationInput !== null) {
  // Legacy resource files append Valve platform conditionals after complete
  // key/value pairs. They do not affect the English token value we need.
  const localized = tokenize(localizationInput.replace(/\s*\[!?\$[^\]]+]\s*(?=\r?\n)/g, ""));
  const localizationCursor = { index: 0 };
  if (localized[localizationCursor.index++] !== "lang"
    || localized[localizationCursor.index++] !== "{") {
    throw new Error("Input is not a CS:GO localization KeyValues file.");
  }
  const localizationRoot = parseObject(localized, localizationCursor);
  if (localized[localizationCursor.index++] !== "}"
    || localizationCursor.index !== localized.length) {
    throw new Error("Trailing or unclosed localization data.");
  }
  localizationTokens = section(localizationRoot, "Tokens");
}

function localizedName(token, fallback) {
  if (!token) return fallback;
  const value = directString(localizationTokens, token.replace(/^#/, ""));
  return value && value.trim() ? value.trim() : fallback;
}

// Valve's client schema intentionally contains only references to the gold-tier
// lists. csgo_gc's pinned supplemental file reconstructs those GC-only list
// contents. Keep duplicate entries because the case-opening implementation
// treats each entry as an equally weighted outcome.
function parseSupplementalLootLists(source) {
  const supplementalTokens = tokenize(source);
  const supplemental = new Map();
  const supplementalCursor = { index: 0 };
  while (supplementalCursor.index < supplementalTokens.length) {
    const name = supplementalTokens[supplementalCursor.index++];
    if (supplementalTokens[supplementalCursor.index++] !== "{") {
      throw new Error(`Malformed supplemental loot list ${String(name)}.`);
    }
    const entries = [];
    while (supplementalCursor.index < supplementalTokens.length
      && supplementalTokens[supplementalCursor.index] !== "}") {
      const entry = supplementalTokens[supplementalCursor.index++];
      const weight = supplementalTokens[supplementalCursor.index++];
      if (typeof entry !== "string" || typeof weight !== "string" || weight === "{") {
        throw new Error(`Malformed entry in supplemental loot list ${String(name)}.`);
      }
      entries.push(entry);
    }
    if (supplementalTokens[supplementalCursor.index++] !== "}") {
      throw new Error(`Unclosed supplemental loot list ${String(name)}.`);
    }
    supplemental.set(name, entries);
  }
  return supplemental;
}

const unusualLootLists = parseSupplementalLootLists(unusualInput);
const itemByName = new Map();
for (const [definitionText, value] of items) {
  if (!/^\d+$/.test(definitionText) || !(value instanceof Map)) continue;
  const name = directString(value, "name");
  if (name) itemByName.set(name, { definitionIndex: Number(definitionText), value });
}
const paintByName = new Map();
const defaultPaintKit = paintKits.get("0");
const defaultMinWear = Number(directString(defaultPaintKit, "wear_remap_min") ?? "0");
const defaultMaxWear = Number(directString(defaultPaintKit, "wear_remap_max") ?? "1");
if (!Number.isFinite(defaultMinWear) || !Number.isFinite(defaultMaxWear)
  || defaultMinWear < 0 || defaultMaxWear > 1 || defaultMinWear > defaultMaxWear) {
  throw new Error("The default CS:GO paint-kit wear range is invalid.");
}
for (const [index, value] of paintKits) {
  if (!/^\d+$/.test(index) || !(value instanceof Map)) continue;
  const name = directString(value, "name");
  if (!name) continue;
  paintByName.set(name, {
    paintIndex: Number(index),
    minWear: Number(directString(value, "wear_remap_min") ?? String(defaultMinWear)),
    maxWear: Number(directString(value, "wear_remap_max") ?? String(defaultMaxWear)),
    paintName: localizedName(directString(value, "description_tag"), humanize(name)),
    rarity: RARITY_BY_NAME.get(directString(paintKitRarities, name))
  });
}

function flattenContainerLootList(name, inheritedRarity = 3, visited = new Set()) {
  if (visited.has(name)) return [];
  const value = lootLists.get(name);
  if (!(value instanceof Map)) return [];
  visited.add(name);
  const rarity = suffixRarity(name, inheritedRarity);
  const rewards = [];
  for (const entry of value.keys()) {
    const painted = parsePaintedName(entry);
    if (painted) {
      const weapon = PAINTABLE_ITEMS.get(painted.itemName);
      const paint = paintByName.get(painted.paintName);
      if (!weapon || !paint) continue;
      rewards.push({
        definitionIndex: weapon[0], weaponKey: weapon[1], loadoutSlot: weapon[3],
        paintIndex: paint.paintIndex, minWear: paint.minWear, maxWear: paint.maxWear,
        rarity, displayName: `${weapon[2]} | ${paint.paintName}`,
        iconPath: null
      });
      continue;
    }
    if (lootLists.has(entry)) {
      rewards.push(...flattenContainerLootList(entry, rarity, new Set(visited)));
      continue;
    }
    const item = itemByName.get(entry);
    if (!item) continue;
    const itemRarity = RARITY_BY_NAME.get(directString(item.value, "item_rarity")) ?? rarity;
    rewards.push({
      definitionIndex: item.definitionIndex,
      weaponKey: "collectible_pin",
      loadoutSlot: 55,
      paintIndex: null,
      minWear: null,
      maxWear: null,
      rarity: itemRarity,
      displayName: localizedName(
        directString(item.value, "item_name"),
        entry.replace(/^(?:Commodity|Collectible) Pin - /, "Pin | ")
      ),
      iconPath: directString(item.value, "image_inventory")
    });
  }
  return rewards;
}

function flattenLootList(name, inheritedRarity = 3, visited = new Set(), inheritedSpecial = false) {
  if (visited.has(name)) return [];
  const clientValue = lootLists.get(name);
  const unusualValue = unusualLootLists.get(name);
  if (!(clientValue instanceof Map) && !Array.isArray(unusualValue)) return [];
  visited.add(name);
  const special = inheritedSpecial || Array.isArray(unusualValue);
  const rarity = suffixRarity(name, inheritedRarity);
  const rewards = [];
  const entries = clientValue instanceof Map ? [...clientValue.keys()] : unusualValue;
  for (const entry of entries) {
    const painted = parsePaintedName(entry);
    if (painted) {
      const weapon = PAINTABLE_ITEMS.get(painted.itemName);
      const paint = paintByName.get(painted.paintName);
      if (!weapon || !paint) {
        throw new Error(`Unknown painted reward ${entry} in loot list ${name}.`);
      }
      rewards.push({
        definitionIndex: weapon[0], weaponKey: weapon[1], loadoutSlot: weapon[3],
        paintIndex: paint.paintIndex, minWear: paint.minWear, maxWear: paint.maxWear,
        rarity: special ? 6 : rarity,
        displayName: `${weapon[2]} | ${paint.paintName}`,
        special
      });
    } else if (lootLists.has(entry) || unusualLootLists.has(entry)) {
      rewards.push(...flattenLootList(entry, rarity, new Set(visited), special));
    }
  }
  return rewards;
}

function publicReward(reward) {
  const { special: _special, ...result } = reward;
  return result;
}

const cases = [];
for (const [definitionText, value] of items) {
  if (!/^\d+$/.test(definitionText) || !(value instanceof Map)) continue;
  const prefabs = (directString(value, "prefab") ?? "").split(/\s+/);
  if (!prefabs.includes("weapon_case")) continue;
  const attributes = value.get("attributes");
  const supply = attributes instanceof Map ? attributes.get("set supply crate series") : null;
  const series = supply instanceof Map ? Number(directString(supply, "value")) : 0;
  const lootName = directString(revolving, String(series));
  const associated = value.get("associated_items");
  const keyText = associated instanceof Map ? [...associated.keys()].find((key) => /^\d+$/.test(key)) : null;
  const allRewards = lootName ? flattenLootList(lootName) : [];
  const rewards = allRewards.filter((reward) => !reward.special).map(publicReward);
  const specialRewards = allRewards.filter((reward) => reward.special).map(publicReward);
  if (!series || !lootName || !keyText || rewards.length === 0 || specialRewards.length === 0) continue;
  const internalName = directString(value, "name") ?? lootName;
  cases.push({
    definitionIndex: Number(definitionText),
    keyDefinitionIndex: Number(keyText),
    supplyCrateSeries: series,
    internalName,
    displayName: localizedName(directString(value, "item_name"), `${humanize(internalName)} Case`),
    iconPath: directString(value, "image_inventory"),
    rewards,
    specialRewards
  });
}
cases.sort((left, right) => left.supplyCrateSeries - right.supplyCrateSeries);

const pinPackages = [];
const souvenirPackages = [];
for (const [definitionText, value] of items) {
  if (!/^\d+$/.test(definitionText) || !(value instanceof Map)) continue;
  const internalName = directString(value, "name") ?? "";
  const prefabs = (directString(value, "prefab") ?? "").split(/\s+/);
  const attributes = value.get("attributes");
  const supply = attributes instanceof Map ? attributes.get("set supply crate series") : null;
  const series = supply instanceof Map ? Number(directString(supply, "value")) : 0;
  const lootName = directString(revolving, String(series));
  if (!series || !lootName) continue;

  if (internalName.startsWith("crate_pins_")) {
    const rewards = flattenContainerLootList(lootName);
    if (rewards.length > 0) {
      pinPackages.push({
        definitionIndex: Number(definitionText), supplyCrateSeries: series,
        internalName,
        displayName: localizedName(directString(value, "item_name"), `${humanize(internalName)} Package`),
        iconPath: directString(value, "image_inventory"), rewards
      });
    }
    continue;
  }

  if (prefabs.includes("weapon_case_souvenirpkg")) {
    const rewards = flattenContainerLootList(lootName)
      .filter((reward) => reward.paintIndex !== null && reward.rarity >= 1 && reward.rarity <= 6);
    if (rewards.some((reward) => reward.rarity === 6)) {
      souvenirPackages.push({
        definitionIndex: Number(definitionText), supplyCrateSeries: series,
        internalName,
        displayName: localizedName(
          directString(value, "item_name"),
          `${humanize(internalName)} Souvenir Package`
        ),
        iconPath: directString(value, "image_inventory"), rewards
      });
    }
  }
}
pinPackages.sort((left, right) => left.supplyCrateSeries - right.supplyCrateSeries);
souvenirPackages.sort((left, right) => left.supplyCrateSeries - right.supplyCrateSeries);

// Graffiti are represented by the final client's sealed spray item (def 1348)
// with the spray-kit id stored in attribute 113.  Keep only purple-or-higher
// community graffiti, as requested by the B2G service-level policy.  Tournament
// team graffiti use separate naming and acquisition rules and are intentionally
// excluded from the normal service-drop pool.
const graffiti = [];
for (const [definitionText, value] of stickerKits) {
  if (!/^\d+$/.test(definitionText) || !(value instanceof Map)) continue;
  const internalName = directString(value, "name") ?? "";
  const rarity = RARITY_BY_NAME.get(directString(value, "item_rarity"));
  if (!internalName.startsWith("spray_") || rarity === undefined || rarity < 4 || rarity > 6) continue;
  graffiti.push({
    sprayKitId: Number(definitionText),
    internalName,
    displayName: `Graffiti | ${humanize(internalName.replace(/^spray_/, ""))}`,
    rarity
  });
}
graffiti.sort((left, right) => left.sprayKitId - right.sprayKitId);

const specialRewardCount = cases.reduce((sum, entry) => sum + entry.specialRewards.length, 0);
if (cases.length < 20 || specialRewardCount < 100) {
  throw new Error(`Incomplete drop catalog: ${cases.length} cases, ${specialRewardCount} case-specific special rewards.`);
}
if (pinPackages.length < 3 || souvenirPackages.length < 3) {
  throw new Error(`Incomplete service-drop catalog: ${pinPackages.length} pin packages, ${souvenirPackages.length} souvenir packages.`);
}
if (graffiti.length < 20 || graffiti.some((entry) => entry.rarity < 4 || entry.rarity > 6)) {
  throw new Error(`Incomplete purple-or-higher graffiti catalog: ${graffiti.length} entries.`);
}
const sha256 = createHash("sha256").update(input).digest("hex");
const unusualSha256 = createHash("sha256").update(unusualInput).digest("hex");
const generated = `// Generated from Valve's final September 2023 CS:GO item schema.\n`
  + `// Source SHA-256: ${sha256}\n`
  + `// Supplemental unusual-loot-list SHA-256: ${unusualSha256}\n`
  + `export interface B2GDropReward { definitionIndex: number; weaponKey: string; loadoutSlot: number; paintIndex: number; minWear: number; maxWear: number; rarity: number; displayName: string }\n`
  + `export interface B2GCaseDefinition { definitionIndex: number; keyDefinitionIndex: number; supplyCrateSeries: number; internalName: string; displayName: string; iconPath: string | null; rewards: readonly B2GDropReward[]; specialRewards: readonly B2GDropReward[] }\n`
  + `export interface B2GContainerReward { definitionIndex: number; weaponKey: string; loadoutSlot: number; paintIndex: number | null; minWear: number | null; maxWear: number | null; rarity: number; displayName: string; iconPath: string | null }\n`
  + `export interface B2GContainerDefinition { definitionIndex: number; supplyCrateSeries: number; internalName: string; displayName: string; iconPath: string | null; rewards: readonly B2GContainerReward[] }\n`
  + `export interface B2GGraffitiDefinition { sprayKitId: number; internalName: string; displayName: string; rarity: number }\n`
  + `export const B2G_DROP_ODDS = { version: "b2g-cases-v4", specialBasisPoints: 500, statTrakBasisPoints: 1000, nonSpecialRarityBasisPoints: { blue: 5100, purple: 2500, pink: 1600, red: 800 } } as const;\n`
  + `export const B2G_SERVICE_DROP_ODDS = { version: "b2g-service-drops-v4", primaryRewardsPerLevel: 2, totalRewardsPerLevel: 3, graffitiCharges: 50, graffitiMinimumRarity: 4, kindBasisPoints: { case: 9300, pinPackage: 200, souvenirPackage: 500 }, pinRarityBasisPoints: { blue: 4000, purple: 3000, pink: 2000, red: 1000 }, souvenirRarityBasisPoints: { consumer: 3800, industrial: 2500, blue: 1500, purple: 1000, pink: 700, red: 500 } } as const;\n`
  + `export const B2G_CASES: readonly B2GCaseDefinition[] = ${JSON.stringify(cases)} as const;\n`
  + `export const B2G_PIN_PACKAGES: readonly B2GContainerDefinition[] = ${JSON.stringify(pinPackages)} as const;\n`
  + `export const B2G_SOUVENIR_PACKAGES: readonly B2GContainerDefinition[] = ${JSON.stringify(souvenirPackages)} as const;\n`
  + `export const B2G_GRAFFITI: readonly B2GGraffitiDefinition[] = ${JSON.stringify(graffiti)} as const;\n`
  + `export const B2G_SPECIAL_REWARDS: readonly B2GDropReward[] = ${JSON.stringify(cases.flatMap((entry) => entry.specialRewards))} as const;\n`;
await writeFile(outputPath, generated, "utf8");
console.log(JSON.stringify({
  inputPath,
  unusualInputPath,
  outputPath,
  cases: cases.length,
  pinPackages: pinPackages.length,
  souvenirPackages: souvenirPackages.length,
  graffiti: graffiti.length,
  rewards: cases.reduce((sum, entry) => sum + entry.rewards.length, 0),
  specialRewards: specialRewardCount,
  sha256,
  unusualSha256,
  localizationPath,
  defaultWear: { min: defaultMinWear, max: defaultMaxWear }
}));
