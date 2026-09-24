import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { decodeLink, type CEconItemPreviewDataBlock } from "@csfloat/cs2-inspect-serializer";
import {
  B2G_CASES,
  lockInventoryPlayers,
  B2G_DROP_ODDS,
  B2G_PIN_PACKAGES,
  B2G_SERVICE_DROP_ODDS,
  B2G_SOUVENIR_PACKAGES,
  tradingItemImage,
  type B2GDropReward,
  type B2GCaseDefinition,
  type B2GContainerDefinition,
  type B2GContainerReward,
  type Sql
} from "@aftertick/db";
import { LEGACY_ECON_CATALOG } from "./legacy-econ-catalog.js";
import type postgres from "postgres";

const STEAM_INVENTORY_ORIGIN = "https://steamcommunity.com";
const APP_ID = 730;
const CONTEXT_ID = 2;
const PAGE_SIZE = 2_000;
const MAX_PAGES = 5;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const REFRESH_COOLDOWN_SECONDS = 300;
const OWNERSHIP_MAX_AGE_HOURS = 24;
const MAX_OWNED_ITEMS_PER_PLAYER = 512;
const MAX_INSPECT_LINK_BYTES = 8 * 1024;
const LAUNCHER_GRANT_SECONDS = 3 * 60 * 60;
const LAUNCHER_SESSION_SECONDS = 6 * 60 * 60;

const WEAPONS_BY_DEFINITION = new Map<number, string>([
  [1, "deagle"], [2, "elite"], [3, "fiveseven"], [4, "glock"],
  [7, "ak47"], [8, "aug"], [9, "awp"], [10, "famas"], [11, "g3sg1"],
  [13, "galilar"], [14, "m249"], [16, "m4a4"], [17, "mac10"], [19, "p90"],
  [23, "mp5sd"], [24, "ump45"], [25, "xm1014"], [26, "bizon"], [27, "mag7"],
  [28, "negev"], [29, "sawedoff"], [30, "tec9"], [32, "hkp2000"], [33, "mp7"],
  [34, "mp9"], [35, "nova"], [36, "p250"], [38, "scar20"], [39, "sg556"],
  [40, "ssg08"], [60, "m4a1_silencer"], [61, "usp_silencer"], [63, "cz75a"],
  [64, "revolver"]
]);

const WEAPONS_BY_NAME = new Map<string, { definitionIndex: number; weaponKey: string }>([
  ["Desert Eagle", { definitionIndex: 1, weaponKey: "deagle" }],
  ["Dual Berettas", { definitionIndex: 2, weaponKey: "elite" }],
  ["Five-SeveN", { definitionIndex: 3, weaponKey: "fiveseven" }],
  ["Glock-18", { definitionIndex: 4, weaponKey: "glock" }],
  ["AK-47", { definitionIndex: 7, weaponKey: "ak47" }],
  ["AUG", { definitionIndex: 8, weaponKey: "aug" }],
  ["AWP", { definitionIndex: 9, weaponKey: "awp" }],
  ["FAMAS", { definitionIndex: 10, weaponKey: "famas" }],
  ["G3SG1", { definitionIndex: 11, weaponKey: "g3sg1" }],
  ["Galil AR", { definitionIndex: 13, weaponKey: "galilar" }],
  ["M249", { definitionIndex: 14, weaponKey: "m249" }],
  ["M4A4", { definitionIndex: 16, weaponKey: "m4a4" }],
  ["MAC-10", { definitionIndex: 17, weaponKey: "mac10" }],
  ["P90", { definitionIndex: 19, weaponKey: "p90" }],
  ["MP5-SD", { definitionIndex: 23, weaponKey: "mp5sd" }],
  ["UMP-45", { definitionIndex: 24, weaponKey: "ump45" }],
  ["XM1014", { definitionIndex: 25, weaponKey: "xm1014" }],
  ["PP-Bizon", { definitionIndex: 26, weaponKey: "bizon" }],
  ["MAG-7", { definitionIndex: 27, weaponKey: "mag7" }],
  ["Negev", { definitionIndex: 28, weaponKey: "negev" }],
  ["Sawed-Off", { definitionIndex: 29, weaponKey: "sawedoff" }],
  ["Tec-9", { definitionIndex: 30, weaponKey: "tec9" }],
  ["P2000", { definitionIndex: 32, weaponKey: "hkp2000" }],
  ["MP7", { definitionIndex: 33, weaponKey: "mp7" }],
  ["MP9", { definitionIndex: 34, weaponKey: "mp9" }],
  ["Nova", { definitionIndex: 35, weaponKey: "nova" }],
  ["P250", { definitionIndex: 36, weaponKey: "p250" }],
  ["SCAR-20", { definitionIndex: 38, weaponKey: "scar20" }],
  ["SG 553", { definitionIndex: 39, weaponKey: "sg556" }],
  ["SSG 08", { definitionIndex: 40, weaponKey: "ssg08" }],
  ["M4A1-S", { definitionIndex: 60, weaponKey: "m4a1_silencer" }],
  ["USP-S", { definitionIndex: 61, weaponKey: "usp_silencer" }],
  ["CZ75-Auto", { definitionIndex: 63, weaponKey: "cz75a" }],
  ["R8 Revolver", { definitionIndex: 64, weaponKey: "revolver" }]
]);

// Reuse the same supported knife identities as B2G case rewards. Steam imports
// used to recognize firearms only, even when the native client had the knife.
for (const container of B2G_CASES) {
  for (const reward of container.specialRewards ?? []) {
    if (reward.loadoutSlot !== 0) continue;
    WEAPONS_BY_DEFINITION.set(reward.definitionIndex, reward.weaponKey);
    WEAPONS_BY_NAME.set(reward.displayName.split(" | ", 1)[0]!, {
      definitionIndex: reward.definitionIndex,
      weaponKey: reward.weaponKey
    });
  }
}

interface CommunityAsset {
  assetid?: unknown;
  classid?: unknown;
  instanceid?: unknown;
}

interface CommunityDescription {
  classid?: unknown;
  instanceid?: unknown;
  name?: unknown;
  market_hash_name?: unknown;
  icon_url?: unknown;
  tradable?: unknown;
  marketable?: unknown;
  actions?: unknown;
  app_data?: { def_index?: unknown } | undefined;
}

interface CommunityAssetProperty {
  propertyid?: unknown;
  string_value?: unknown;
}

interface CommunityAssetProperties {
  assetid?: unknown;
  asset_properties?: unknown;
}

interface CommunityPage {
  success?: unknown;
  total_inventory_count?: unknown;
  more_items?: unknown;
  last_assetid?: unknown;
  assets?: unknown;
  descriptions?: unknown;
  asset_properties?: unknown;
}

interface ImportedItem {
  assetId: string;
  classId: string;
  instanceId: string;
  definitionIndex: number;
  weaponKey: string;
  displayName: string;
  marketHashName: string;
  iconPath: string | null;
  tradable: boolean;
  marketable: boolean;
  inventoryPosition: number;
  paintIndex: number;
  paintWear: number | null;
  paintSeed: number;
  quality: number;
  rarity: number;
  origin: number;
  killEaterScoreType: number | null;
  killEaterValue: number | null;
  customName: string | null;
  stickers: LegacySticker[];
  loadoutSlot: number;
  legacyCompatible: true;
}

export interface LegacySticker {
  slot: number;
  stickerId: number;
  wear: number | null;
  scale: number | null;
  rotation: number | null;
}

export interface CosmeticInventoryItem extends Omit<ImportedItem, "paintIndex" | "paintSeed"> {
  paintIndex: number | null;
  paintSeed: number | null;
  selected: boolean;
  iconUrl: string | null;
  source: "steam" | "b2g";
  itemKind: "case" | "key" | "cosmetic";
}

export interface CosmeticInventoryView {
  status: "public" | "private" | "unavailable";
  refreshedAt: string | null;
  nextRefreshAt: string;
  itemCount: number;
  items: CosmeticInventoryItem[];
  serverApplication: "owned-native-loadout";
}

export interface ManifestCosmeticLoadout {
  playerId: string;
  steamId: string;
  items: Array<{
    assetId: string;
    source: "steam" | "b2g";
    itemKind: "case" | "key" | "cosmetic";
    definitionIndex: number;
    weaponKey: string;
    inventoryPosition: number;
    paintIndex: number | null;
    paintWear: number | null;
    paintSeed: number | null;
    quality: number;
    rarity: number;
    origin: number;
    killEaterScoreType: number | null;
    killEaterValue: number | null;
    customName: string | null;
    stickers: LegacySticker[];
    loadoutSlot: number;
    sprayKitId?: number | null;
    sprayTintId?: number | null;
    spraysRemaining?: number | null;
    equipped: boolean;
  }>;
}

export interface LauncherInventoryBundle {
  version: 1;
  inventoryVersion?: number;
  matchId: string;
  expiresAt: string;
  schemaSha256: string;
  players: ManifestCosmeticLoadout[];
}

export interface LauncherInventoryGrant {
  id: string;
  token: string;
  expiresAt: string;
}

export interface B2GCaseOpenResult {
  oddsVersion: string;
  alreadyOpened: boolean;
  itemName: string;
  item: ManifestCosmeticLoadout["items"][number];
}

export interface B2GTradeUpResult {
  alreadyCompleted: boolean;
  inputAssetIds: string[];
  recipeIndex: number;
  item: ManifestCosmeticLoadout["items"][number];
}

export interface B2GSprayUnsealResult {
  alreadyUnsealed: boolean;
  sealedAssetId: string;
  item: ManifestCosmeticLoadout["items"][number];
}

export interface B2GSprayUseResult {
  assetId: string;
  spraysRemaining: number;
}

export class InventoryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function safeString(value: unknown, pattern: RegExp, maximum = 200): string | null {
  return typeof value === "string" && value.length <= maximum && pattern.test(value) ? value : null;
}

function finiteInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function uint32(value: unknown): number | null {
  const parsed = finiteInteger(value);
  return parsed !== null && parsed >= 0 && parsed <= 0xffff_ffff ? parsed : null;
}

function finiteFloat(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validManifestPlayer(value: unknown): value is ManifestCosmeticLoadout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const player = value as ManifestCosmeticLoadout;
  if (
    typeof player.playerId !== "string"
    || !/^[a-f0-9-]{36}$/i.test(player.playerId)
    || typeof player.steamId !== "string"
    || !/^\d{17}$/.test(player.steamId)
    || !Array.isArray(player.items)
    || player.items.length > MAX_OWNED_ITEMS_PER_PLAYER
  ) return false;
  return player.items.every((item) =>
    item
    && typeof item === "object"
    && /^\d{1,20}$/.test(item.assetId)
    && uint32(item.definitionIndex) !== null
    && /^[a-z0-9_]{2,32}$/.test(item.weaponKey)
    && uint32(item.inventoryPosition) !== null
    && (item.paintIndex === null || uint32(item.paintIndex) !== null)
    && (item.paintWear === null || finiteFloat(item.paintWear, 0, 1) !== null)
    && (item.paintSeed === null || uint32(item.paintSeed) !== null)
    && uint32(item.quality) !== null
    && uint32(item.rarity) !== null
    && uint32(item.origin) !== null
    && (item.killEaterScoreType === null || uint32(item.killEaterScoreType) !== null)
    && (item.killEaterValue === null || uint32(item.killEaterValue) !== null)
    && (item.customName === null || safeString(item.customName, /^[^\u0000-\u001f\u007f]{1,100}$/, 100) !== null)
    && (item.sprayKitId == null || uint32(item.sprayKitId) !== null)
    && (item.sprayTintId == null || (Number.isInteger(item.sprayTintId)
      && item.sprayTintId >= 1 && item.sprayTintId <= 19))
    && (item.spraysRemaining == null || (Number.isInteger(item.spraysRemaining)
      && item.spraysRemaining >= 1 && item.spraysRemaining <= 50))
    && Array.isArray(item.stickers)
    && item.stickers.length <= 6
    && item.stickers.every((sticker) =>
      normalizedSticker({
        slot: sticker.slot,
        stickerId: sticker.stickerId,
        ...(sticker.wear === null ? {} : { wear: sticker.wear }),
        ...(sticker.scale === null ? {} : { scale: sticker.scale }),
        ...(sticker.rotation === null ? {} : { rotation: sticker.rotation })
      }) !== null
    )
    && Number.isInteger(item.loadoutSlot)
    && item.loadoutSlot >= 0
    && item.loadoutSlot <= 63
    && typeof item.equipped === "boolean"
    && (item.source === "steam" || item.source === "b2g")
    && (item.itemKind === "case" || item.itemKind === "key" || item.itemKind === "cosmetic")
  );
}

function exactInspectLink(
  description: CommunityDescription,
  steamId: string,
  assetId: string,
  properties: ReadonlyMap<number, string>
): string | null {
  if (!Array.isArray(description.actions)) return null;
  for (const candidate of description.actions) {
    if (!candidate || typeof candidate !== "object") continue;
    const action = candidate as { link?: unknown };
    if (typeof action.link !== "string" || !action.link.includes("econ_action_preview")) continue;
    const link = action.link
      .replaceAll("%owner_steamid%", steamId)
      .replaceAll("%assetid%", assetId)
      .replace(/%propid:(\d+)%/gi, (placeholder, rawPropertyId: string) => {
        const propertyId = uint32(rawPropertyId);
        return propertyId === null ? placeholder : properties.get(propertyId) ?? placeholder;
      });
    if (/%propid:\d+%/i.test(link)) continue;
    if (Buffer.byteLength(link, "utf8") <= MAX_INSPECT_LINK_BYTES) return link;
  }
  return null;
}

function propertiesForAssets(page: CommunityPage): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  if (!Array.isArray(page.asset_properties)) return result;
  for (const value of page.asset_properties) {
    if (!value || typeof value !== "object") continue;
    const entry = value as CommunityAssetProperties;
    const assetId = safeString(entry.assetid, /^\d{1,20}$/);
    if (!assetId || !Array.isArray(entry.asset_properties)) continue;
    const properties = new Map<number, string>();
    for (const rawProperty of entry.asset_properties) {
      if (!rawProperty || typeof rawProperty !== "object") continue;
      const property = rawProperty as CommunityAssetProperty;
      const propertyId = uint32(property.propertyid);
      const propertyValue = safeString(property.string_value, /^[0-9A-F]+$/i, MAX_INSPECT_LINK_BYTES);
      if (propertyId !== null && propertyValue) properties.set(propertyId, propertyValue);
    }
    if (properties.size > 0) result.set(assetId, properties);
  }
  return result;
}

function normalizedSticker(value: CEconItemPreviewDataBlock["stickers"][number]): LegacySticker | null {
  const slot = uint32(value.slot);
  const stickerId = uint32(value.stickerId);
  if (
    slot === null
    || slot > 5
    || stickerId === null
    || !LEGACY_ECON_CATALOG.stickerKitIndexes.has(stickerId)
  ) return null;
  const wear = value.wear === undefined ? null : finiteFloat(value.wear, 0, 1);
  const scale = value.scale === undefined ? null : finiteFloat(value.scale, 0, 100);
  const rotation = value.rotation === undefined ? null : finiteFloat(value.rotation, -360, 360);
  if (
    (value.wear !== undefined && wear === null)
    || (value.scale !== undefined && scale === null)
    || (value.rotation !== undefined && rotation === null)
  ) return null;
  return { slot, stickerId, wear, scale, rotation };
}

function decodeOwnedItem(
  description: CommunityDescription,
  steamId: string,
  assetId: string,
  expectedDefinitionIndex: number,
  properties: ReadonlyMap<number, string>
): Omit<ImportedItem,
  "assetId" | "classId" | "instanceId" | "weaponKey" | "displayName"
  | "marketHashName" | "iconPath" | "tradable" | "marketable"
> | null {
  const inspectLink = exactInspectLink(description, steamId, assetId, properties);
  if (!inspectLink) return null;
  let decoded: CEconItemPreviewDataBlock;
  try {
    decoded = decodeLink(inspectLink);
  } catch {
    return null;
  }
  const itemId = decoded.itemid?.toString();
  const definitionIndex = uint32(decoded.defindex);
  const inventoryPosition = uint32(decoded.inventory) ?? 1;
  const paintIndex = uint32(decoded.paintindex) ?? 0;
  const paintWear = decoded.paintwear === undefined ? null : finiteFloat(decoded.paintwear, 0, 1);
  const paintSeed = uint32(decoded.paintseed) ?? 0;
  const quality = uint32(decoded.quality) ?? 4;
  const rarity = uint32(decoded.rarity) ?? 0;
  const origin = uint32(decoded.origin) ?? 0;
  const killEaterScoreType = decoded.killeaterscoretype === undefined
    ? null
    : uint32(decoded.killeaterscoretype);
  const killEaterValue = decoded.killeatervalue === undefined ? null : uint32(decoded.killeatervalue);
  const customName = decoded.customname === undefined
    ? null
    : safeString(decoded.customname, /^[^\u0000-\u001f\u007f]{1,100}$/, 100);
  const loadoutSlot = LEGACY_ECON_CATALOG.loadoutSlots.get(expectedDefinitionIndex);
  if (
    itemId !== assetId
    || definitionIndex !== expectedDefinitionIndex
    || !LEGACY_ECON_CATALOG.definitionIndexes.has(expectedDefinitionIndex)
    || !LEGACY_ECON_CATALOG.paintKitIndexes.has(paintIndex)
    || loadoutSlot === undefined
    || (decoded.paintwear !== undefined && paintWear === null)
    || (decoded.customname !== undefined && customName === null)
    || (decoded.killeaterscoretype !== undefined && killEaterScoreType === null)
    || (decoded.killeatervalue !== undefined && killEaterValue === null)
  ) return null;
  const stickers = decoded.stickers
    .map(normalizedSticker)
    .filter((sticker): sticker is LegacySticker => sticker !== null)
    .sort((left, right) => left.slot - right.slot);
  if (new Set(stickers.map((sticker) => sticker.slot)).size !== stickers.length) return null;
  return {
    definitionIndex,
    inventoryPosition,
    paintIndex,
    paintWear,
    paintSeed,
    quality,
    rarity,
    origin,
    killEaterScoreType,
    killEaterValue,
    customName,
    stickers,
    loadoutSlot,
    legacyCompatible: true
  };
}

function resolveWeapon(description: CommunityDescription): { definitionIndex: number; weaponKey: string } | null {
  const definitionIndex = finiteInteger(description.app_data?.def_index);
  const fromDefinition = definitionIndex === null ? null : WEAPONS_BY_DEFINITION.get(definitionIndex);
  if (definitionIndex !== null && fromDefinition) return { definitionIndex, weaponKey: fromDefinition };
  const marketHashName = typeof description.market_hash_name === "string" ? description.market_hash_name : "";
  const weaponName = (marketHashName.split(" | ", 1)[0] ?? "")
    .replace(/^★\s+/u, "")
    .replace(/^(?:StatTrak™|Souvenir)\s+/u, "");
  return WEAPONS_BY_NAME.get(weaponName) ?? null;
}

export function parseCommunityInventoryPage(page: CommunityPage, steamId = "76561197960265728"): ImportedItem[] {
  if (!Array.isArray(page.assets) || !Array.isArray(page.descriptions)) return [];
  const assetProperties = propertiesForAssets(page);
  const descriptions = new Map<string, CommunityDescription>();
  for (const value of page.descriptions) {
    if (!value || typeof value !== "object") continue;
    const description = value as CommunityDescription;
    const classId = safeString(description.classid, /^\d{1,20}$/);
    const instanceId = safeString(description.instanceid, /^\d{1,20}$/);
    if (classId && instanceId) descriptions.set(`${classId}:${instanceId}`, description);
  }

  const imported: ImportedItem[] = [];
  for (const value of page.assets) {
    if (!value || typeof value !== "object") continue;
    const asset = value as CommunityAsset;
    const assetId = safeString(asset.assetid, /^\d{1,20}$/);
    const classId = safeString(asset.classid, /^\d{1,20}$/);
    const instanceId = safeString(asset.instanceid, /^\d{1,20}$/);
    if (!assetId || !classId || !instanceId) continue;
    const description = descriptions.get(`${classId}:${instanceId}`);
    if (!description) continue;
    const weapon = resolveWeapon(description);
    const displayName = safeString(description.name, /^[\s\S]{1,160}$/, 160);
    const marketHashName = safeString(description.market_hash_name, /^[\s\S]{1,200}$/, 200);
    if (!weapon || !displayName || !marketHashName) continue;
    const iconPath = safeString(description.icon_url, /^[A-Za-z0-9_./-]{1,512}$/, 512);
    const exact = decodeOwnedItem(
      description,
      steamId,
      assetId,
      weapon.definitionIndex,
      assetProperties.get(assetId) ?? new Map()
    );
    if (!exact) continue;
    imported.push({
      assetId,
      classId,
      instanceId,
      weaponKey: weapon.weaponKey,
      displayName,
      marketHashName,
      iconPath,
      tradable: description.tradable === 1,
      marketable: description.marketable === 1,
      ...exact
    });
  }
  return imported;
}

async function boundedJson(response: Response): Promise<CommunityPage> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("inventory_too_large");
  const reader = response.body?.getReader();
  if (!reader) return await response.json() as CommunityPage;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("inventory_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as CommunityPage;
}

const NON_KNIFE_RARITY_WEIGHTS = new Map<number, number>([
  [3, B2G_DROP_ODDS.nonSpecialRarityBasisPoints.blue],
  [4, B2G_DROP_ODDS.nonSpecialRarityBasisPoints.purple],
  [5, B2G_DROP_ODDS.nonSpecialRarityBasisPoints.pink],
  [6, B2G_DROP_ODDS.nonSpecialRarityBasisPoints.red]
]);

const PIN_RARITY_WEIGHTS = new Map<number, number>([
  [3, B2G_SERVICE_DROP_ODDS.pinRarityBasisPoints.blue],
  [4, B2G_SERVICE_DROP_ODDS.pinRarityBasisPoints.purple],
  [5, B2G_SERVICE_DROP_ODDS.pinRarityBasisPoints.pink],
  [6, B2G_SERVICE_DROP_ODDS.pinRarityBasisPoints.red]
]);

const SOUVENIR_RARITY_WEIGHTS = new Map<number, number>([
  [1, B2G_SERVICE_DROP_ODDS.souvenirRarityBasisPoints.consumer],
  [2, B2G_SERVICE_DROP_ODDS.souvenirRarityBasisPoints.industrial],
  [3, B2G_SERVICE_DROP_ODDS.souvenirRarityBasisPoints.blue],
  [4, B2G_SERVICE_DROP_ODDS.souvenirRarityBasisPoints.purple],
  [5, B2G_SERVICE_DROP_ODDS.souvenirRarityBasisPoints.pink],
  [6, B2G_SERVICE_DROP_ODDS.souvenirRarityBasisPoints.red]
]);

type RandomInteger = (maxExclusive: number) => number;

export function chooseCaseReward(
  caseDefinition: B2GCaseDefinition,
  randomInteger: RandomInteger = randomInt
): {
  reward: B2GDropReward;
  roll: number;
  statTrak: boolean;
} {
  const roll = randomInteger(10_000);
  if (roll < B2G_DROP_ODDS.specialBasisPoints) {
    const reward = caseDefinition.specialRewards[randomInteger(caseDefinition.specialRewards.length)];
    if (!reward) throw new Error("The B2G case-specific special reward catalog is empty.");
    return {
      reward,
      roll,
      // Valve permits StatTrak knives but never StatTrak gloves.
      statTrak: reward.definitionIndex < 1_000
        && randomInteger(10_000) < B2G_DROP_ODDS.statTrakBasisPoints
    };
  }
  const available = [...new Set(caseDefinition.rewards.map((reward) => reward.rarity))]
    .map((rarity) => ({ rarity, weight: NON_KNIFE_RARITY_WEIGHTS.get(rarity) ?? 1 }));
  const totalWeight = available.reduce((total, entry) => total + entry.weight, 0);
  let rarityRoll = randomInteger(totalWeight);
  let selectedRarity = available[available.length - 1]?.rarity;
  for (const entry of available) {
    if (rarityRoll < entry.weight) {
      selectedRarity = entry.rarity;
      break;
    }
    rarityRoll -= entry.weight;
  }
  const pool = caseDefinition.rewards.filter((reward) => reward.rarity === selectedRarity);
  const reward = pool[randomInteger(pool.length)];
  if (!reward) throw new Error("The selected B2G case reward pool is empty.");
  return {
    reward,
    roll,
    statTrak: randomInteger(10_000) < B2G_DROP_ODDS.statTrakBasisPoints
  };
}

export function caseRewardWear(
  reward: B2GDropReward,
  randomInteger: RandomInteger = randomInt
): number {
  if (!Number.isFinite(reward.minWear)
    || !Number.isFinite(reward.maxWear)
    || reward.minWear < 0
    || reward.maxWear > 1
    || reward.minWear > reward.maxWear) {
    throw new Error(`Invalid Valve wear range for ${reward.displayName}.`);
  }
  return reward.minWear
    + (reward.maxWear - reward.minWear) * (randomInteger(1_000_001) / 1_000_000);
}

export function chooseContainerReward(
  container: B2GContainerDefinition,
  randomInteger: RandomInteger = randomInt
): { reward: B2GContainerReward; roll: number } {
  const roll = randomInteger(10_000);
  const rarityWeights = container.rewards.every((reward) => reward.weaponKey === "collectible_pin")
    ? PIN_RARITY_WEIGHTS
    : SOUVENIR_RARITY_WEIGHTS;
  const available = [...new Set(container.rewards.map((reward) => reward.rarity))]
    .filter((rarity) => rarityWeights.has(rarity))
    .map((rarity) => ({ rarity, weight: rarityWeights.get(rarity)! }));
  if (available.length === 0) throw new Error("The B2G reward container has no supported rarity pool.");
  const totalWeight = available.reduce((total, entry) => total + entry.weight, 0);
  let rarityRoll = Math.floor(roll * totalWeight / 10_000);
  let selectedRarity = available[available.length - 1]!.rarity;
  for (const entry of available) {
    if (rarityRoll < entry.weight) {
      selectedRarity = entry.rarity;
      break;
    }
    rarityRoll -= entry.weight;
  }
  const pool = container.rewards.filter((reward) => reward.rarity === selectedRarity);
  const reward = pool[randomInteger(pool.length)];
  if (!reward) throw new Error("The selected B2G container reward pool is empty.");
  return { reward, roll };
}

function containerRewardWear(reward: B2GContainerReward): number | null {
  if (reward.paintIndex === null) return null;
  if (reward.minWear === null || reward.maxWear === null) {
    throw new Error(`Painted container reward ${reward.displayName} has no Valve wear range.`);
  }
  return caseRewardWear(reward as B2GDropReward);
}

function b2gManifestItem(row: {
  asset_id: string;
  definition_index: number;
  weapon_key: string;
  inventory_position: number;
  paint_index: number | null;
  paint_wear: number | null;
  paint_seed: number | null;
  quality: number;
  rarity: number;
  origin: number;
  kill_eater_score_type: number | null;
  kill_eater_value: number | null;
  custom_name: string | null;
  stickers: LegacySticker[];
  loadout_slot: number;
  spray_kit_id?: number | null;
  spray_tint_id?: number | null;
  sprays_remaining?: number | null;
}): ManifestCosmeticLoadout["items"][number] {
  return {
    assetId: row.asset_id,
    source: "b2g",
    itemKind: "cosmetic",
    definitionIndex: row.definition_index,
    weaponKey: row.weapon_key,
    inventoryPosition: row.inventory_position,
    paintIndex: row.paint_index,
    paintWear: row.paint_wear,
    paintSeed: row.paint_seed,
    quality: row.quality,
    rarity: row.rarity,
    origin: row.origin,
    killEaterScoreType: row.kill_eater_score_type,
    killEaterValue: row.kill_eater_value,
    customName: row.custom_name,
    stickers: row.stickers,
    loadoutSlot: row.loadout_slot,
    sprayKitId: row.spray_kit_id ?? null,
    sprayTintId: row.spray_tint_id ?? null,
    spraysRemaining: row.sprays_remaining ?? null,
    equipped: false
  };
}

export class InventoryService {
  constructor(private readonly sql: Sql, private readonly fetchImpl: typeof fetch = fetch) {}

  private async ensureFreeNameTags(playerIds: string[]): Promise<void> {
    for (const playerId of [...new Set(playerIds)]) {
      await this.sql.begin(async transaction => {
        await lockInventoryPlayers(transaction, [playerId]);
        await transaction`
        insert into player_b2g_inventory_items (
          player_id, asset_id, item_kind, definition_index, weapon_key,
          display_name, icon_path, inventory_position, quality, rarity, origin,
          loadout_slot
        )
        select ${playerId}, nextval('b2g_inventory_asset_id_seq')::text, 'cosmetic',
               1200, 'b2g_name_tag', 'Name Tag (Free)', 'econ/tools/tag', 1,
               4, 1, 24, 63
        where exists (select 1 from players where id = ${playerId})
          and not exists (
            select 1 from player_b2g_inventory_items
            where player_id = ${playerId} and source = 'b2g'
              and state = 'active' and definition_index = 1200
          )
        on conflict do nothing
      `;
      });
    }
  }

  async syncLauncherLoadout(playerId: string, assetIds: string[], ownershipGenerations: Record<string,string> = {}): Promise<void> {
    if (assetIds.length > 64 || new Set(assetIds).size !== assetIds.length
      || assetIds.some((assetId) => !/^\d{1,20}$/.test(assetId))
      || Object.entries(ownershipGenerations).some(([assetId,generation]) => !assetIds.includes(assetId)
        || !/^(0|[1-9]\d{0,18})$/.test(generation) || BigInt(generation)>9_223_372_036_854_775_807n)) {
      throw new InventoryError(400, "The launcher loadout snapshot is invalid.");
    }
    await this.sql.begin(async (transaction) => {
      await lockInventoryPlayers(transaction, [playerId]);
      const owned = assetIds.length === 0 ? [] : await transaction<{
        asset_id: string;
        weapon_key: string;
        ownership_generation: string;
      }[]>`
        select asset_id, weapon_key, '0'::text as ownership_generation from player_inventory_items
        where player_id = ${playerId} and legacy_compatible = true
          and asset_id = any(${assetIds})
        union all
        select asset_id, weapon_key, ownership_generation::text from player_b2g_inventory_items
        where player_id = ${playerId} and source = 'b2g' and state = 'active'
          and item_kind = 'cosmetic' and definition_index <> 1200
          and asset_id = any(${assetIds})
      `;
      if (owned.length !== assetIds.length
        || owned.some(item => item.ownership_generation !== (ownershipGenerations[item.asset_id] ?? "0"))
        || new Set(owned.map((item) => item.weapon_key)).size !== owned.length) {
        throw new InventoryError(409, "The launcher loadout contains an unavailable or duplicate-slot item.");
      }
      await transaction`delete from player_cosmetic_loadouts where player_id = ${playerId}`;
      for (const item of owned) {
        await transaction`
          insert into player_cosmetic_loadouts (player_id, weapon_key, asset_id)
          values (${playerId}, ${item.weapon_key}, ${item.asset_id})
        `;
      }
    });
  }

  async acknowledgeB2GItems(
    playerId: string,
    positions: Array<{ assetId: string; position: number; ownershipGeneration?: string | undefined }>
  ): Promise<void> {
    if (positions.length > MAX_OWNED_ITEMS_PER_PLAYER
      || new Set(positions.map((entry) => entry.assetId)).size !== positions.length
      || positions.some((entry) => !/^\d{1,20}$/.test(entry.assetId)
        || !/^(0|[1-9]\d{0,18})$/.test(entry.ownershipGeneration ?? "0")
        || BigInt(entry.ownershipGeneration ?? "0")>9_223_372_036_854_775_807n
        || !Number.isInteger(entry.position) || entry.position < 0 || entry.position >= 0x4000_0000)) {
      throw new InventoryError(400, "The launcher inventory acknowledgement is invalid.");
    }
    await this.sql.begin(async (transaction) => {
      await lockInventoryPlayers(transaction, [playerId]);
      for (const entry of positions) {
        await transaction`
          update player_b2g_inventory_items
          set inventory_position = ${entry.position}
          where player_id = ${playerId} and asset_id = ${entry.assetId}
            and ownership_generation = ${entry.ownershipGeneration ?? "0"}::bigint
            and source = 'b2g' and state = 'active'
            and inventory_position is distinct from ${entry.position}
        `;
      }
    });
  }

  async renameB2GItem(playerId: string, assetId: string, customName: string): Promise<void> {
    if (!/^\d{1,20}$/.test(assetId) || customName.length > 100
      || [...customName].some((character) => character < " " || character === "\u007f")) {
      throw new InventoryError(400, "The B2G item name is invalid.");
    }
    const updated = await this.sql.begin(async transaction => {
      await lockInventoryPlayers(transaction, [playerId]);
      return transaction<{ asset_id: string }[]>`
      update player_b2g_inventory_items
      set custom_name = ${customName || null}
      where player_id = ${playerId} and asset_id = ${assetId}
        and source = 'b2g' and state = 'active' and item_kind = 'cosmetic'
        and definition_index <> 1200
      returning asset_id
    `;
    });
    if (updated.length !== 1) throw new InventoryError(404, "That B2G item cannot be renamed.");
  }

  async unsealB2GGraffiti(playerId: string, sealedAssetId: string): Promise<B2GSprayUnsealResult> {
    if (!/^\d{1,20}$/.test(sealedAssetId)) {
      throw new InventoryError(400, "The B2G graffiti identifier is invalid.");
    }
    return this.sql.begin(async (transaction) => {
      await lockInventoryPlayers(transaction, [playerId]);
      type SprayRow = {
        asset_id: string;
        definition_index: number;
        weapon_key: string;
        inventory_position: number;
        paint_index: null;
        paint_wear: null;
        paint_seed: null;
        quality: number;
        rarity: number;
        origin: number;
        kill_eater_score_type: null;
        kill_eater_value: null;
        custom_name: string | null;
        stickers: LegacySticker[];
        loadout_slot: number;
        spray_kit_id: number;
        spray_tint_id: number;
        sprays_remaining: number;
      };
      const [grant] = await transaction<{
        id: string;
        unsealed_asset_id: string | null;
      }[]>`
        select reward_grant.id::text, reward_grant.unsealed_asset_id
        from player_b2g_direct_reward_grants reward_grant
        where reward_grant.owner_id = ${playerId} and reward_grant.sealed_asset_id = ${sealedAssetId}
          and reward_grant.reward_type = 'graffiti'
        for update
      `;
      if (!grant) throw new InventoryError(404, "That B2G graffiti is not available.");
      if (grant.unsealed_asset_id) {
        const [existing] = await transaction<SprayRow[]>`
          select asset_id, definition_index, weapon_key,
                 inventory_position::double precision as inventory_position,
                 paint_index, paint_wear, paint_seed, quality, rarity, origin,
                 kill_eater_score_type::double precision as kill_eater_score_type,
                 kill_eater_value::double precision as kill_eater_value,
                 custom_name, stickers, loadout_slot, spray_kit_id,
                 spray_tint_id, sprays_remaining
          from player_b2g_inventory_items
          where player_id = ${playerId} and asset_id = ${grant.unsealed_asset_id}
            and definition_index = 1349
        `;
        if (!existing) throw new InventoryError(409, "The recorded B2G graffiti is unavailable.");
        return { alreadyUnsealed: true, sealedAssetId, item: b2gManifestItem(existing) };
      }
      const [sealed] = await transaction<{
        direct_reward_grant_id: string;
        state: string;
        definition_index: number;
        display_name: string;
        rarity: number;
        origin: number;
        spray_kit_id: number;
        spray_tint_id: number;
      }[]>`
        select direct_reward_grant_id::text, state, definition_index, display_name,
               rarity, origin, spray_kit_id, spray_tint_id
        from player_b2g_inventory_items
        where player_id = ${playerId} and asset_id = ${sealedAssetId}
        for update
      `;
      if (!sealed || sealed.state !== "active" || sealed.definition_index !== 1348
        || sealed.direct_reward_grant_id !== grant.id) {
        throw new InventoryError(409, "That B2G graffiti has already been consumed.");
      }
      const [allocated] = await transaction<{ asset_id: string }[]>`
        select nextval('b2g_inventory_asset_id_seq')::text as asset_id
      `;
      if (!allocated) throw new Error("Could not allocate an active B2G graffiti.");
      await transaction`
        update player_b2g_inventory_items
        set state = 'consumed', consumed_at = now()
        where player_id = ${playerId} and asset_id = ${sealedAssetId}
      `;
      const [created] = await transaction<SprayRow[]>`
        insert into player_b2g_inventory_items (
          player_id, asset_id, direct_reward_grant_id, item_kind, definition_index,
          weapon_key, display_name, inventory_position, quality, rarity, origin,
          loadout_slot, spray_kit_id, spray_tint_id, sprays_remaining
        ) values (
          ${playerId}, ${allocated.asset_id}, ${grant.id}, 'cosmetic', 1349,
          'graffiti', ${sealed.display_name}, 1073741829, 4, ${sealed.rarity},
          ${sealed.origin}, 56, ${sealed.spray_kit_id}, ${sealed.spray_tint_id},
          ${B2G_SERVICE_DROP_ODDS.graffitiCharges}
        )
        returning asset_id, definition_index, weapon_key,
                  inventory_position::double precision as inventory_position,
                  paint_index, paint_wear, paint_seed, quality, rarity, origin,
                  kill_eater_score_type::double precision as kill_eater_score_type,
                  kill_eater_value::double precision as kill_eater_value,
                  custom_name, stickers, loadout_slot, spray_kit_id,
                  spray_tint_id, sprays_remaining
      `;
      if (!created) throw new Error("Could not persist the active B2G graffiti.");
      await transaction`
        insert into player_cosmetic_loadouts (player_id, weapon_key, asset_id)
        values (${playerId}, 'graffiti', ${created.asset_id})
        on conflict (player_id, weapon_key) do update
        set asset_id = excluded.asset_id, updated_at = now()
      `;
      await transaction`
        update player_b2g_direct_reward_grants
        set unsealed_at = now(), unsealed_asset_id = ${created.asset_id}
        where id = ${grant.id}
      `;
      return { alreadyUnsealed: false, sealedAssetId, item: b2gManifestItem(created) };
    });
  }

  async consumeB2GGraffiti(playerId: string, assetId: string): Promise<B2GSprayUseResult> {
    if (!/^\d{1,20}$/.test(assetId)) {
      throw new InventoryError(400, "The B2G graffiti identifier is invalid.");
    }
    const [updated] = await this.sql.begin(async transaction => {
      await lockInventoryPlayers(transaction, [playerId]);
      return transaction<{ sprays_remaining: number }[]>`
      update player_b2g_inventory_items
      set sprays_remaining = sprays_remaining - 1,
          state = case when sprays_remaining = 1 then 'consumed' else state end,
          consumed_at = case when sprays_remaining = 1 then now() else consumed_at end
      where player_id = ${playerId} and asset_id = ${assetId}
        and source = 'b2g' and state = 'active' and definition_index = 1349
        and sprays_remaining between 1 and 50
      returning sprays_remaining
    `;
    });
    if (!updated) throw new InventoryError(409, "That B2G graffiti has no sprays remaining.");
    return { assetId, spraysRemaining: updated.sprays_remaining };
  }

  private async announceDropIfInMatch(playerId: string, assetId: string): Promise<void> {
    const [active] = await this.sql<{
      node_id: string;
      match_id: string;
      steam_id: string;
      display_name: string;
      rarity: number;
      quality: number;
    }[]>`
      select instance.node_id::text, lease.match_id::text, player.steam_id,
             item.display_name, item.rarity, item.quality
      from server_leases lease
      join server_instances instance on instance.id = lease.server_instance_id
      join rosters roster on roster.match_id = lease.match_id
        and roster.player_id = ${playerId}
      join players player on player.id = roster.player_id
      join player_b2g_inventory_items item on item.player_id = roster.player_id
        and item.asset_id = ${assetId}
      where lease.status = 'active' and lease.expires_at > now()
      order by lease.leased_at desc
      limit 1
    `;
    if (!active || !/^\d{17}$/.test(active.steam_id)
      || !/^[A-Za-z0-9 |'().:+_\-]{1,160}$/.test(active.display_name)) return;
    await this.sql`
      insert into node_commands (node_id, command_type, payload)
      values (
        ${active.node_id}, 'announce-drop',
        ${this.sql.json({
          matchId: active.match_id,
          steamId: active.steam_id,
          itemName: active.display_name,
          rarity: active.rarity,
          quality: active.quality
        })}
      )
    `;
  }

  async view(playerId: string): Promise<CosmeticInventoryView> {
    const [snapshot] = await this.sql<{
      status: CosmeticInventoryView["status"];
      refreshed_at: Date | null;
      next_refresh_at: Date;
      item_count: number;
    }[]>`
      select status, refreshed_at, next_refresh_at, item_count
      from player_inventory_snapshots where player_id = ${playerId}
    `;
    const rows = await this.sql<CosmeticInventoryItem[]>`
      with owned as (
        select item.player_id, item.asset_id, item.class_id, item.instance_id,
               item.definition_index, item.weapon_key, item.display_name,
               item.market_hash_name, item.icon_path, item.tradable, item.marketable,
               item.inventory_position, item.paint_index, item.paint_wear, item.paint_seed,
               item.quality, item.rarity, item.origin, item.kill_eater_score_type,
               item.kill_eater_value, item.custom_name, item.stickers, item.loadout_slot,
               item.legacy_compatible, 'steam'::text as source, 'cosmetic'::text as item_kind
        from player_inventory_items item where item.player_id = ${playerId}
        union all
        select item.player_id, item.asset_id, item.asset_id, '0'::text,
               item.definition_index, item.weapon_key, item.display_name,
               item.display_name, item.icon_path, false, false,
               item.inventory_position, item.paint_index, item.paint_wear, item.paint_seed,
               item.quality, item.rarity, item.origin, item.kill_eater_score_type,
               item.kill_eater_value, item.custom_name, item.stickers, item.loadout_slot,
               true, item.source, item.item_kind
        from player_b2g_inventory_items item
        where item.player_id = ${playerId}
          and item.state = 'active'
          and item.item_kind <> 'key'
      )
      select item.asset_id as "assetId", item.class_id as "classId",
             item.instance_id as "instanceId", item.definition_index as "definitionIndex",
             item.weapon_key as "weaponKey", item.display_name as "displayName",
             item.market_hash_name as "marketHashName", item.icon_path as "iconPath",
             item.tradable, item.marketable,
             item.inventory_position::double precision as "inventoryPosition",
             item.paint_index as "paintIndex", item.paint_wear as "paintWear",
             item.paint_seed as "paintSeed", item.quality, item.rarity, item.origin,
             item.kill_eater_score_type::double precision as "killEaterScoreType",
             item.kill_eater_value::double precision as "killEaterValue",
             item.custom_name as "customName", item.stickers, item.loadout_slot as "loadoutSlot",
             item.legacy_compatible as "legacyCompatible", item.source, item.item_kind as "itemKind",
             loadout.asset_id is not null as selected
      from owned item
      left join player_cosmetic_loadouts loadout
        on loadout.player_id = item.player_id and loadout.asset_id = item.asset_id
      order by item.item_kind, item.weapon_key, item.display_name, item.asset_id
    `;
    return {
      status: snapshot?.status ?? "unavailable",
      refreshedAt: snapshot?.refreshed_at?.toISOString() ?? null,
      nextRefreshAt: (snapshot?.next_refresh_at ?? new Date(0)).toISOString(),
      itemCount: rows.length,
      items: rows.map((item) => ({
        ...item,
        iconUrl: item.source === "b2g"
          ? tradingItemImage(item.definitionIndex, item.paintIndex, null)
          : item.iconPath
          ? `https://community.fastly.steamstatic.com/economy/image/${item.iconPath}`
          : null
      })),
      serverApplication: "owned-native-loadout"
    };
  }

  async refresh(playerId: string): Promise<CosmeticInventoryView> {
    const [identity] = await this.sql<{ steam_id: string | null; next_refresh_at: Date | null }[]>`
      select player.steam_id, snapshot.next_refresh_at
      from players player
      left join player_inventory_snapshots snapshot on snapshot.player_id = player.id
      where player.id = ${playerId}
    `;
    if (!identity?.steam_id || !/^\d{17}$/.test(identity.steam_id)) {
      throw new InventoryError(409, "A valid Steam account is required before importing inventory.");
    }
    if (identity.next_refresh_at && identity.next_refresh_at.getTime() > Date.now()) {
      throw new InventoryError(429, "Inventory was refreshed recently. Try again after the displayed refresh time.");
    }

    const items = new Map<string, ImportedItem>();
    let startAssetId: string | null = null;
    try {
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
        const url = new URL(`/inventory/${identity.steam_id}/${APP_ID}/${CONTEXT_ID}`, STEAM_INVENTORY_ORIGIN);
        url.searchParams.set("l", "english");
        url.searchParams.set("count", String(PAGE_SIZE));
        if (startAssetId) url.searchParams.set("start_assetid", startAssetId);
        const response = await this.fetchImpl(url, {
          headers: { Accept: "application/json", "User-Agent": "B2G-Inventory/1.0" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000)
        });
        if (response.status === 403 || response.status === 404) {
          await this.recordFailure(playerId, "private", "inventory_private");
          return this.view(playerId);
        }
        if (!response.ok) throw new Error(`steam_http_${response.status}`);
        const body = await boundedJson(response);
        if (body.success !== 1 && body.success !== true) throw new Error("steam_inventory_unsuccessful");
        for (const item of parseCommunityInventoryPage(body, identity.steam_id)) {
          if (items.size >= MAX_OWNED_ITEMS_PER_PLAYER && !items.has(item.assetId)) break;
          items.set(item.assetId, item);
        }
        if (body.more_items !== 1 && body.more_items !== true) break;
        const next = safeString(body.last_assetid, /^\d{1,20}$/);
        if (!next || next === startAssetId) throw new Error("steam_inventory_pagination_invalid");
        startAssetId = next;
        if (pageIndex === MAX_PAGES - 1) throw new Error("steam_inventory_page_limit");
      }
    } catch (error) {
      await this.recordFailure(playerId, "unavailable", "steam_inventory_unavailable");
      throw new InventoryError(502, "Steam inventory could not be verified. Your saved loadout was not changed.");
    }

    await this.sql.begin(async (transaction) => {
      await lockInventoryPlayers(transaction, [playerId]);
      for (const item of items.values()) {
        await transaction`
          insert into player_inventory_items (
            player_id, asset_id, class_id, instance_id, definition_index,
            weapon_key, display_name, market_hash_name, icon_path, tradable, marketable,
            inventory_position, paint_index, paint_wear, paint_seed, quality, rarity,
            origin, kill_eater_score_type, kill_eater_value, custom_name, stickers,
            loadout_slot, legacy_compatible
          ) values (
            ${playerId}, ${item.assetId}, ${item.classId}, ${item.instanceId},
            ${item.definitionIndex}, ${item.weaponKey}, ${item.displayName},
            ${item.marketHashName}, ${item.iconPath}, ${item.tradable}, ${item.marketable},
            ${item.inventoryPosition}, ${item.paintIndex}, ${item.paintWear}, ${item.paintSeed},
            ${item.quality}, ${item.rarity}, ${item.origin}, ${item.killEaterScoreType},
            ${item.killEaterValue}, ${item.customName}, ${transaction.json(item.stickers.map((sticker) => ({
              slot: sticker.slot,
              stickerId: sticker.stickerId,
              wear: sticker.wear,
              scale: sticker.scale,
              rotation: sticker.rotation
            })))},
            ${item.loadoutSlot}, true
          )
          on conflict (player_id, asset_id) do update set
            class_id = excluded.class_id,
            instance_id = excluded.instance_id,
            definition_index = excluded.definition_index,
            weapon_key = excluded.weapon_key,
            display_name = excluded.display_name,
            market_hash_name = excluded.market_hash_name,
            icon_path = excluded.icon_path,
            tradable = excluded.tradable,
            marketable = excluded.marketable,
            inventory_position = excluded.inventory_position,
            paint_index = excluded.paint_index,
            paint_wear = excluded.paint_wear,
            paint_seed = excluded.paint_seed,
            quality = excluded.quality,
            rarity = excluded.rarity,
            origin = excluded.origin,
            kill_eater_score_type = excluded.kill_eater_score_type,
            kill_eater_value = excluded.kill_eater_value,
            custom_name = excluded.custom_name,
            stickers = excluded.stickers,
            loadout_slot = excluded.loadout_slot,
            legacy_compatible = true,
            imported_at = now()
        `;
      }
      await transaction`
        delete from player_inventory_items
        where player_id = ${playerId}
          and asset_id not in (
            select jsonb_array_elements_text(${transaction.json([...items.keys()])})
          )
      `;
      await transaction`
        insert into player_inventory_snapshots (
          player_id, status, item_count, refreshed_at, last_attempt_at,
          next_refresh_at, last_error_code, updated_at
        ) values (
          ${playerId}, 'public', ${items.size}, now(), now(),
          now() + ${REFRESH_COOLDOWN_SECONDS} * interval '1 second', null, now()
        )
        on conflict (player_id) do update set
          status = 'public', item_count = excluded.item_count,
          refreshed_at = excluded.refreshed_at, last_attempt_at = excluded.last_attempt_at,
          next_refresh_at = excluded.next_refresh_at, last_error_code = null, updated_at = now()
      `;
      // The running launcher watches this inventory revision. A manual Steam
      // refresh must deliver newly imported items to the game as well as the UI.
      await transaction`
        update players set b2g_inventory_revision = b2g_inventory_revision + 1
        where id = ${playerId}
      `;
    });
    return this.view(playerId);
  }

  async ensureFreshForPlayers(playerIds: string[]): Promise<void> {
    const uniquePlayerIds = [...new Set(playerIds)];
    if (uniquePlayerIds.length === 0) return;
    const candidates = await this.sql<{
      player_id: string;
      status: CosmeticInventoryView["status"] | null;
      refreshed_at: Date | null;
      next_refresh_at: Date | null;
      item_count: number | null;
    }[]>`
      select player.id::text as player_id, snapshot.status, snapshot.refreshed_at,
             snapshot.next_refresh_at, snapshot.item_count
      from players player
      left join player_inventory_snapshots snapshot on snapshot.player_id = player.id
      where player.id::text in (
        select jsonb_array_elements_text(${this.sql.json(uniquePlayerIds)})
      )
        and player.steam_id ~ '^[0-9]{17}$'
    `;
    const now = Date.now();
    const freshAfter = now - OWNERSHIP_MAX_AGE_HOURS * 60 * 60 * 1_000;
    for (const candidate of candidates) {
      const hasUsableSnapshot = candidate.status === "public"
        && (candidate.item_count ?? 0) > 0
        && candidate.refreshed_at !== null
        && candidate.refreshed_at.getTime() >= freshAfter;
      const coolingDown = candidate.next_refresh_at !== null
        && candidate.next_refresh_at.getTime() > now;
      if (hasUsableSnapshot || coolingDown) continue;
      try {
        await this.refresh(candidate.player_id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        console.warn(`[inventory] Automatic refresh failed for player ${candidate.player_id}: ${reason}`);
      }
    }
  }

  async saveLoadout(playerId: string, selections: Array<{ weaponKey: string; assetId: string }>): Promise<CosmeticInventoryView> {
    const keys = new Set(selections.map((selection) => selection.weaponKey));
    if (keys.size !== selections.length) throw new InventoryError(400, "Each weapon may have one selected item.");
    await this.sql.begin(async (transaction) => {
      await lockInventoryPlayers(transaction, [playerId]);
      const [snapshot] = await transaction<{ status: string; refreshed_at: Date | null }[]>`
        select status, refreshed_at from player_inventory_snapshots
        where player_id = ${playerId} for update
      `;
      const owned = await transaction<{ asset_id: string; weapon_key: string; source: "steam" | "b2g" }[]>`
        select asset_id, weapon_key, 'steam'::text as source from player_inventory_items
        where player_id = ${playerId} and legacy_compatible = true
          and asset_id in (select jsonb_array_elements_text(${transaction.json(selections.map((item) => item.assetId))}))
        union all
        select asset_id, weapon_key, source from player_b2g_inventory_items
        where player_id = ${playerId} and state = 'active' and item_kind = 'cosmetic'
          and asset_id in (select jsonb_array_elements_text(${transaction.json(selections.map((item) => item.assetId))}))
      `;
      if (owned.some((item) => item.source === "steam") && (
        snapshot?.status !== "public"
        || !snapshot.refreshed_at
        || snapshot.refreshed_at.getTime() < Date.now() - OWNERSHIP_MAX_AGE_HOURS * 60 * 60 * 1_000
      )) {
        throw new InventoryError(409, "Refresh a public Steam inventory before equipping Steam-owned items.");
      }
      const ownedByAsset = new Map(owned.map((item) => [item.asset_id, item.weapon_key]));
      if (selections.some((selection) => ownedByAsset.get(selection.assetId) !== selection.weaponKey)) {
        throw new InventoryError(400, "A selected item is not present in the verified inventory for that weapon.");
      }
      await transaction`delete from player_cosmetic_loadouts where player_id = ${playerId}`;
      for (const selection of selections) {
        await transaction`
          insert into player_cosmetic_loadouts (player_id, weapon_key, asset_id)
          values (${playerId}, ${selection.weaponKey}, ${selection.assetId})
        `;
      }
    });
    return this.view(playerId);
  }

  async manifestsForPlayers(
    playerIds: string[],
    inventoryKinds: "all" | "cosmetics" = "all",
    transaction?: postgres.TransactionSql
  ): Promise<ManifestCosmeticLoadout[]> {
    if (playerIds.length === 0) return [];
    // Server refreshes are read-only and must share the locked lease's
    // transaction; do not grant utility items or query through another pool slot.
    if (inventoryKinds === "all" && !transaction) await this.ensureFreeNameTags(playerIds);
    const sql = transaction ?? this.sql;
    const rows = await sql<{
      player_id: string;
      steam_id: string;
      asset_id: string;
      ownership_generation: string;
      source: "steam" | "b2g";
      item_kind: "case" | "key" | "cosmetic";
      definition_index: number;
      weapon_key: string;
      inventory_position: number;
      paint_index: number | null;
      paint_wear: number | null;
      paint_seed: number | null;
      quality: number;
      rarity: number;
      origin: number;
      kill_eater_score_type: number | null;
      kill_eater_value: number | null;
      custom_name: string | null;
      stickers: LegacySticker[];
      loadout_slot: number;
      spray_kit_id: number | null;
      spray_tint_id: number | null;
      sprays_remaining: number | null;
      equipped: boolean;
    }[]>`
      with owned as (
        select item.player_id, item.asset_id, 'steam'::text as source,
               'cosmetic'::text as item_kind, item.definition_index, item.weapon_key,
               item.inventory_position, item.paint_index, item.paint_wear, item.paint_seed,
               item.quality, item.rarity, item.origin, item.kill_eater_score_type,
               item.kill_eater_value, item.custom_name, item.stickers, item.loadout_slot,
               null::integer as spray_kit_id, null::integer as spray_tint_id,
               null::integer as sprays_remaining, 0::bigint as ownership_generation
        from player_inventory_items item
        join player_inventory_snapshots snapshot on snapshot.player_id = item.player_id
        where snapshot.status = 'public'
          and snapshot.refreshed_at >= now() - ${OWNERSHIP_MAX_AGE_HOURS} * interval '1 hour'
          and item.legacy_compatible = true
        union all
        select item.player_id, item.asset_id, item.source, item.item_kind,
               item.definition_index, item.weapon_key, item.inventory_position,
               item.paint_index, item.paint_wear, item.paint_seed, item.quality,
               item.rarity, item.origin, item.kill_eater_score_type,
               item.kill_eater_value, item.custom_name, item.stickers, item.loadout_slot,
               item.spray_kit_id, item.spray_tint_id, item.sprays_remaining, item.ownership_generation
        from player_b2g_inventory_items item
        where item.state = 'active'
          and item.item_kind <> 'key'
          and (${inventoryKinds} = 'all' or item.item_kind = 'cosmetic')
      )
      select player.id::text as player_id, player.steam_id, item.asset_id,
             item.ownership_generation::text as ownership_generation,
             item.source, item.item_kind, item.definition_index, item.weapon_key,
             item.inventory_position::double precision as inventory_position,
             item.paint_index, item.paint_wear, item.paint_seed, item.quality,
             item.rarity, item.origin,
             item.kill_eater_score_type::double precision as kill_eater_score_type,
             item.kill_eater_value::double precision as kill_eater_value,
             item.custom_name, item.stickers, item.loadout_slot,
             item.spray_kit_id, item.spray_tint_id, item.sprays_remaining,
             loadout.asset_id is not null as equipped
      from owned item
      left join player_cosmetic_loadouts loadout
        on loadout.player_id = item.player_id and loadout.asset_id = item.asset_id
      join players player on player.id = item.player_id
      where item.player_id::text in (
        select jsonb_array_elements_text(${sql.json(playerIds)})
      )
      order by player.id, item.item_kind, item.weapon_key, item.asset_id
    `;
    const manifests = new Map<string, ManifestCosmeticLoadout>();
    for (const row of rows) {
      const manifest = manifests.get(row.player_id) ?? {
        playerId: row.player_id,
        steamId: row.steam_id,
        items: []
      };
      manifest.items.push({
        assetId: row.asset_id,
        ...(row.ownership_generation === "0" ? {} : { ownershipGeneration: row.ownership_generation }),
        source: row.source,
        itemKind: row.item_kind,
        definitionIndex: row.definition_index,
        weaponKey: row.weapon_key,
        inventoryPosition: row.inventory_position,
        paintIndex: row.paint_index,
        paintWear: row.paint_wear,
        paintSeed: row.paint_seed,
        quality: row.quality,
        rarity: row.rarity,
        origin: row.origin,
        killEaterScoreType: row.kill_eater_score_type,
        killEaterValue: row.kill_eater_value,
        customName: row.custom_name,
        stickers: row.stickers,
        loadoutSlot: row.loadout_slot,
        sprayKitId: row.spray_kit_id,
        sprayTintId: row.spray_tint_id,
        spraysRemaining: row.sprays_remaining,
        equipped: row.equipped
      });
      manifests.set(row.player_id, manifest);
    }
    return [...manifests.values()];
  }

  async issueLauncherGrant(matchId: string): Promise<LauncherInventoryGrant> {
    const [lease] = await this.sql<{ expires_at: Date }[]>`
      select expires_at
      from server_leases
      where match_id = ${matchId} and status = 'active' and expires_at > now()
      order by leased_at desc
      limit 1
    `;
    if (!lease) throw new InventoryError(409, "The match has no active inventory authority.");
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Math.min(
      lease.expires_at.getTime(),
      Date.now() + LAUNCHER_GRANT_SECONDS * 1_000
    ));
    await this.sql`
      insert into launcher_inventory_grants (id, match_id, token_sha256, expires_at)
      values (${id}, ${matchId}, ${sha256(token)}, ${expiresAt})
    `;
    return { id, token, expiresAt: expiresAt.toISOString() };
  }

  async launcherBundle(grantId: string, token: string): Promise<LauncherInventoryBundle> {
    if (!/^[a-f0-9-]{36}$/i.test(grantId) || !/^[a-f0-9]{64}$/i.test(token)) {
      throw new InventoryError(401, "Invalid launcher inventory grant.");
    }
    const result = await this.sql.begin(async (transaction) => {
      const [row] = await transaction<{
        match_id: string;
        token_sha256: string;
        expires_at: Date;
        lease_expires_at: Date;
        manifest: Record<string, unknown>;
        redemption_count: number;
      }[]>`
        select inventory_grant.match_id::text, inventory_grant.token_sha256,
               inventory_grant.expires_at,
               lease.expires_at as lease_expires_at, lease.manifest,
               inventory_grant.redemption_count
        from launcher_inventory_grants inventory_grant
        join server_leases lease on lease.match_id = inventory_grant.match_id
          and lease.status = 'active' and lease.expires_at > now()
        where inventory_grant.id = ${grantId}
        order by lease.leased_at desc
        limit 1
        for update of inventory_grant
      `;
      if (!row || !safeHexEqual(row.token_sha256, sha256(token))) {
        throw new InventoryError(401, "Invalid launcher inventory grant.");
      }
      if (row.expires_at.getTime() <= Date.now() || row.redemption_count >= 64) {
        throw new InventoryError(410, "Launcher inventory grant expired.");
      }
      const cosmetics = row.manifest["cosmetics"];
      if (!Array.isArray(cosmetics) || cosmetics.length > 14 || !cosmetics.every(validManifestPlayer)) {
        throw new InventoryError(409, "The signed match inventory is invalid.");
      }
      await transaction`
        update launcher_inventory_grants
        set redemption_count = redemption_count + 1, last_redeemed_at = now()
        where id = ${grantId}
      `;
      return {
        version: 1 as const,
        matchId: row.match_id,
        expiresAt: new Date(Math.min(row.expires_at.getTime(), row.lease_expires_at.getTime())).toISOString(),
        schemaSha256: LEGACY_ECON_CATALOG.sourceSha256,
        players: cosmetics
      };
    });
    return result;
  }

  async launcherAccountBundle(playerId: string): Promise<LauncherInventoryBundle> {
    await this.ensureFreshForPlayers([playerId]);
    const [identity] = await this.sql<{
      steam_id: string | null;
      status: CosmeticInventoryView["status"] | null;
      refreshed_at: Date | null;
      inventory_version: number;
    }[]>`
      select player.steam_id, snapshot.status, snapshot.refreshed_at,
             player.b2g_inventory_revision::double precision as inventory_version
      from players player
      left join player_inventory_snapshots snapshot on snapshot.player_id = player.id
      where player.id = ${playerId}
    `;
    if (!identity?.steam_id || !/^\d{17}$/.test(identity.steam_id)) {
      throw new InventoryError(409, "Link a valid Steam account before starting CS:GO.");
    }
    const freshnessDeadline = Date.now() - OWNERSHIP_MAX_AGE_HOURS * 60 * 60 * 1_000;
    const steamVerified = identity.status === "public" && identity.refreshed_at !== null
      && identity.refreshed_at.getTime() >= freshnessDeadline;
    const manifests = await this.manifestsForPlayers([playerId]);
    const player = manifests[0] ?? { playerId, steamId: identity.steam_id, items: [] };
    // A public Steam inventory is required to import Steam skins, not to play
    // with stock equipment or server-owned B2G items. Keep the query's ownership
    // gate and also fence a refresh racing the earlier snapshot read.
    if (!steamVerified) player.items = player.items.filter((item) => item.source === "b2g");
    const sessionDeadline = Date.now() + LAUNCHER_SESSION_SECONDS * 1_000;
    const expiresAt = new Date(steamVerified ? Math.min(
      identity.refreshed_at!.getTime() + OWNERSHIP_MAX_AGE_HOURS * 60 * 60 * 1_000,
      sessionDeadline
    ) : sessionDeadline);
    return {
      version: 1,
      // This revision is read before the manifest query. If inventory changes
      // concurrently, the launcher may perform one harmless later refresh but
      // can never suppress content that was absent from this bundle.
      inventoryVersion: identity.inventory_version,
      matchId: randomUUID(),
      expiresAt: expiresAt.toISOString(),
      schemaSha256: LEGACY_ECON_CATALOG.sourceSha256,
      players: [player]
    };
  }

  async openB2GCase(
    playerId: string,
    caseAssetId: string,
    requestedKeyAssetId?: string
  ): Promise<B2GCaseOpenResult> {
    if (!/^\d{1,20}$/.test(caseAssetId)
      || (requestedKeyAssetId !== undefined && !/^\d{1,20}$/.test(requestedKeyAssetId))) {
      throw new InventoryError(400, "Invalid B2G case-opening request.");
    }
    const result = await this.sql.begin(async (transaction) => {
      await lockInventoryPlayers(transaction, [playerId]);
      type RewardRow = {
        asset_id: string;
        definition_index: number;
        weapon_key: string;
        display_name: string;
        inventory_position: number;
        paint_index: number | null;
        paint_wear: number | null;
        paint_seed: number | null;
        quality: number;
        rarity: number;
        origin: number;
        kill_eater_score_type: number | null;
        kill_eater_value: number | null;
        custom_name: string | null;
        stickers: LegacySticker[];
        loadout_slot: number;
      };
      const [drop] = await transaction<{
        id: string;
        case_definition_index: number;
        key_definition_index: number;
        case_asset_id: string;
        key_asset_id: string;
        odds_version: string;
        opened_at: Date | null;
        opened_key_asset_id: string | null;
        result_asset_id: string | null;
      }[]>`
        select id::text, case_definition_index, key_definition_index,
               case_asset_id, key_asset_id, odds_version, opened_at,
               opened_key_asset_id, result_asset_id
        from player_b2g_case_grants
        where owner_id = ${playerId} and case_asset_id = ${caseAssetId}
        for update
      `;
      if (!drop) {
        const [containerDrop] = await transaction<{
          id: string;
          container_type: "pin_package" | "souvenir_package";
          container_definition_index: number;
          container_asset_id: string;
          odds_version: string;
          opened_at: Date | null;
          result_asset_id: string | null;
        }[]>`
          select id::text, container_type, container_definition_index,
                 container_asset_id, odds_version, opened_at, result_asset_id
          from player_b2g_container_grants
          where owner_id = ${playerId} and container_asset_id = ${caseAssetId}
          for update
        `;
        if (!containerDrop) {
          throw new InventoryError(404, "That B2G case and virtual key are not available.");
        }
        // v4 changes only which containers drop at level-up. Existing v3
        // packages retain identical opening odds and must remain redeemable.
        if ((!containerDrop.opened_at
            && !["b2g-service-drops-v3", B2G_SERVICE_DROP_ODDS.version]
              .includes(containerDrop.odds_version))
          || (containerDrop.opened_at
            && !["b2g-service-drops-v2", "b2g-service-drops-v3", B2G_SERVICE_DROP_ODDS.version]
              .includes(containerDrop.odds_version))
          || requestedKeyAssetId !== undefined && requestedKeyAssetId !== "0") {
          throw new InventoryError(404, "That B2G reward container is not available.");
        }
        if (containerDrop.opened_at && containerDrop.result_asset_id) {
          const [existing] = await transaction<RewardRow[]>`
            select asset_id, definition_index, weapon_key, display_name,
                   inventory_position::double precision as inventory_position,
                   paint_index, paint_wear, paint_seed, quality, rarity, origin,
                   kill_eater_score_type::double precision as kill_eater_score_type,
                   kill_eater_value::double precision as kill_eater_value,
                   custom_name, stickers, loadout_slot
            from player_b2g_inventory_items
            where player_id = ${playerId} and asset_id = ${containerDrop.result_asset_id}
              and state = 'active' and item_kind = 'cosmetic'
          `;
          if (!existing) throw new InventoryError(409, "The recorded B2G container reward is unavailable.");
          return {
            oddsVersion: containerDrop.odds_version,
            alreadyOpened: true,
            itemName: existing.display_name,
            item: b2gManifestItem(existing)
          };
        }
        const [containerItem] = await transaction<{
          item_kind: string;
          state: string;
          definition_index: number;
        }[]>`
          select item_kind, state, definition_index
          from player_b2g_inventory_items
          where player_id = ${playerId} and asset_id = ${caseAssetId}
          for update
        `;
        if (containerItem?.state !== "active" || containerItem.item_kind !== "case"
          || containerItem.definition_index !== containerDrop.container_definition_index) {
          throw new InventoryError(409, "That B2G reward container has already been consumed.");
        }
        const catalog = containerDrop.container_type === "pin_package"
          ? B2G_PIN_PACKAGES
          : B2G_SOUVENIR_PACKAGES;
        const container = catalog.find((entry) => entry.definitionIndex
          === containerDrop.container_definition_index);
        if (!container) throw new InventoryError(409, "That container is not in the active B2G catalog.");
        const { reward, roll } = chooseContainerReward(container);
        const [allocated] = await transaction<{ asset_id: string }[]>`
          select nextval('b2g_inventory_asset_id_seq')::text as asset_id
        `;
        if (!allocated) throw new Error("Could not allocate the B2G container reward.");
        const wear = containerRewardWear(reward);
        const [created] = await transaction<RewardRow[]>`
          insert into player_b2g_inventory_items (
            player_id, asset_id, container_grant_id, item_kind, definition_index,
            weapon_key, display_name, icon_path, inventory_position, paint_index,
            paint_wear, paint_seed, quality, rarity, origin, kill_eater_score_type,
            kill_eater_value, loadout_slot, collection_definition_index
          ) values (
            ${playerId}, ${allocated.asset_id}, ${containerDrop.id}, 'cosmetic',
            ${reward.definitionIndex}, ${reward.weaponKey}, ${reward.displayName},
            ${reward.iconPath}, ${1_073_741_829}, ${reward.paintIndex}, ${wear},
            ${reward.paintIndex === null ? null : randomInt(1, 1_001)},
            ${containerDrop.container_type === "souvenir_package" ? 12 : 4},
            ${reward.rarity}, 8, null, null, ${reward.loadoutSlot},
            ${containerDrop.container_type === "souvenir_package"
              ? containerDrop.container_definition_index
              : null}
          )
          returning asset_id, definition_index, weapon_key, display_name,
                    inventory_position::double precision as inventory_position,
                    paint_index, paint_wear, paint_seed, quality, rarity, origin,
                    kill_eater_score_type::double precision as kill_eater_score_type,
                    kill_eater_value::double precision as kill_eater_value,
                    custom_name, stickers, loadout_slot
        `;
        if (!created) throw new Error("Could not persist the B2G container reward.");
        await transaction`
          update player_b2g_inventory_items
          set state = 'consumed', consumed_at = now()
          where player_id = ${playerId} and asset_id = ${caseAssetId}
        `;
        await transaction`
          update player_b2g_container_grants
          set opened_at = now(), result_asset_id = ${created.asset_id}, result_roll = ${roll}
          where id = ${containerDrop.id}
        `;
        return {
          oddsVersion: containerDrop.odds_version,
          alreadyOpened: false,
          itemName: created.display_name,
          item: b2gManifestItem(created)
        };
      }
      if (!drop || !drop.case_definition_index || !drop.key_definition_index
        || (!drop.opened_at && drop.odds_version !== B2G_DROP_ODDS.version)
        || (drop.opened_at
          && !["b2g-cases-v1", "b2g-cases-v2", "b2g-cases-v3", B2G_DROP_ODDS.version]
            .includes(drop.odds_version))) {
        throw new InventoryError(404, "That B2G case and virtual key are not available.");
      }

      if (drop.opened_at && drop.result_asset_id) {
        if (requestedKeyAssetId !== undefined
          && drop.opened_key_asset_id !== requestedKeyAssetId) {
          throw new InventoryError(409, "That B2G case was opened with a different virtual key.");
        }
        const [existing] = await transaction<RewardRow[]>`
          select asset_id, definition_index, weapon_key, display_name,
                 inventory_position::double precision as inventory_position,
                 paint_index, paint_wear, paint_seed, quality, rarity, origin,
                 kill_eater_score_type::double precision as kill_eater_score_type,
                 kill_eater_value::double precision as kill_eater_value,
                 custom_name, stickers, loadout_slot
          from player_b2g_inventory_items
          where player_id = ${playerId} and asset_id = ${drop.result_asset_id}
            and state = 'active' and item_kind = 'cosmetic'
        `;
        if (!existing) throw new InventoryError(409, "The recorded B2G case reward is unavailable.");
        return {
          oddsVersion: drop.odds_version,
          alreadyOpened: true,
          itemName: existing.display_name,
          item: b2gManifestItem(existing)
        };
      }

      const [caseItem] = await transaction<{
        asset_id: string;
        item_kind: string;
        state: string;
        definition_index: number;
      }[]>`
        select asset_id, item_kind, state, definition_index
        from player_b2g_inventory_items
        where player_id = ${playerId} and asset_id = ${caseAssetId}
        for update
      `;
      const [keyItem] = requestedKeyAssetId === undefined
        ? await transaction<{
          asset_id: string;
          item_kind: string;
          state: string;
          definition_index: number;
        }[]>`
          select asset_id, item_kind, state, definition_index
          from player_b2g_inventory_items
          where player_id = ${playerId}
            and item_kind = 'key'
            and state = 'active'
            and definition_index = ${drop.key_definition_index}
          order by acquired_at, asset_id
          limit 1
          for update
        `
        : await transaction<{
          asset_id: string;
          item_kind: string;
          state: string;
          definition_index: number;
        }[]>`
          select asset_id, item_kind, state, definition_index
          from player_b2g_inventory_items
          where player_id = ${playerId} and asset_id = ${requestedKeyAssetId}
          for update
        `;
      if (caseItem?.state !== "active" || caseItem.item_kind !== "case"
        || caseItem.definition_index !== drop.case_definition_index
        || keyItem?.state !== "active" || keyItem.item_kind !== "key"
        || keyItem.definition_index !== drop.key_definition_index) {
        throw new InventoryError(409, "That B2G case or virtual key has already been consumed.");
      }
      const caseDefinition = B2G_CASES.find((entry) => entry.definitionIndex === drop.case_definition_index);
      if (!caseDefinition || caseDefinition.keyDefinitionIndex !== drop.key_definition_index) {
        throw new InventoryError(409, "That case is not part of the active B2G drop catalog.");
      }
      const { reward, roll, statTrak } = chooseCaseReward(caseDefinition);
      const [allocated] = await transaction<{ asset_id: string }[]>`
        select nextval('b2g_inventory_asset_id_seq')::text as asset_id
      `;
      if (!allocated) throw new Error("Could not allocate the B2G case reward.");
      const wear = caseRewardWear(reward);
      const quality = reward.definitionIndex >= 500 ? 3 : statTrak ? 9 : 4;
      const [created] = await transaction<RewardRow[]>`
        insert into player_b2g_inventory_items (
          player_id, asset_id, case_grant_id, item_kind, definition_index,
          weapon_key, display_name, inventory_position, paint_index, paint_wear,
          paint_seed, quality, rarity, origin, kill_eater_score_type,
          kill_eater_value, loadout_slot, collection_definition_index
        ) values (
          ${playerId}, ${allocated.asset_id}, ${drop.id}, 'cosmetic', ${reward.definitionIndex},
          ${reward.weaponKey}, ${reward.displayName}, ${1_073_741_829}, ${reward.paintIndex},
          ${wear}, ${randomInt(1, 1_001)}, ${quality}, ${reward.rarity}, 8,
          ${statTrak ? 0 : null}, ${statTrak ? 0 : null}, ${reward.loadoutSlot},
          ${drop.case_definition_index}
        )
        returning asset_id, definition_index, weapon_key, display_name,
                  inventory_position::double precision as inventory_position,
                  paint_index, paint_wear, paint_seed, quality, rarity, origin,
                  kill_eater_score_type::double precision as kill_eater_score_type,
                  kill_eater_value::double precision as kill_eater_value,
                  custom_name, stickers, loadout_slot
      `;
      if (!created) throw new Error("Could not persist the B2G case reward.");
      await transaction`
        update player_b2g_inventory_items
        set state = 'consumed', consumed_at = now()
        where player_id = ${playerId} and asset_id in (${caseAssetId}, ${keyItem.asset_id})
      `;
      await transaction`
        update player_b2g_case_grants
        set opened_at = now(), opened_key_asset_id = ${keyItem.asset_id},
            result_asset_id = ${created.asset_id}, result_roll = ${roll}
        where id = ${drop.id}
      `;
      return {
        oddsVersion: drop.odds_version,
        alreadyOpened: false,
        itemName: created.display_name,
        item: b2gManifestItem(created)
      };
    });
    if (!result.alreadyOpened) await this.announceDropIfInMatch(playerId, result.item.assetId);
    return result;
  }

  async tradeUpB2G(playerId: string, submittedAssetIds: string[]): Promise<B2GTradeUpResult> {
    if (submittedAssetIds.length !== 10
      || new Set(submittedAssetIds).size !== 10
      || submittedAssetIds.some((assetId) => !/^\d{1,20}$/.test(assetId))) {
      throw new InventoryError(400, "A B2G Trade Up Contract requires ten unique item identifiers.");
    }
    const inputAssetIds = [...submittedAssetIds].sort((left, right) => {
      const leftId = BigInt(left);
      const rightId = BigInt(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    const inputFingerprint = sha256(inputAssetIds.join(","));

    type TradeUpItemRow = {
      asset_id: string;
      item_kind: string;
      state: string;
      definition_index: number;
      weapon_key: string;
      inventory_position: number;
      paint_index: number | null;
      paint_wear: number | null;
      paint_seed: number | null;
      quality: number;
      rarity: number;
      origin: number;
      kill_eater_score_type: number | null;
      kill_eater_value: number | null;
      custom_name: string | null;
      stickers: LegacySticker[];
      loadout_slot: number;
      collection_definition_index: number | null;
    };

    return this.sql.begin(async (transaction) => {
      await lockInventoryPlayers(transaction, [playerId]);
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(
          ${`b2g-trade-up:${playerId}:${inputFingerprint}`}, 0
        ))
      `;
      const [completed] = await transaction<{
        result_asset_id: string;
        recipe_index: number;
      }[]>`
        select result_asset_id, recipe_index
        from player_b2g_trade_ups
        where player_id = ${playerId} and input_fingerprint = ${inputFingerprint}
      `;
      if (completed) {
        const [existing] = await transaction<TradeUpItemRow[]>`
          select asset_id, item_kind, state, definition_index, weapon_key,
                 inventory_position::double precision as inventory_position,
                 paint_index, paint_wear, paint_seed, quality, rarity, origin,
                 kill_eater_score_type::double precision as kill_eater_score_type,
                 kill_eater_value::double precision as kill_eater_value,
                 custom_name, stickers, loadout_slot, collection_definition_index
          from player_b2g_inventory_items
          where player_id = ${playerId} and asset_id = ${completed.result_asset_id}
            and state = 'active' and item_kind = 'cosmetic'
        `;
        if (!existing) {
          throw new InventoryError(409, "The recorded B2G trade-up result is no longer active.");
        }
        return {
          alreadyCompleted: true,
          inputAssetIds,
          recipeIndex: completed.recipe_index,
          item: b2gManifestItem(existing)
        };
      }

      const inputs = await transaction<TradeUpItemRow[]>`
        select asset_id, item_kind, state, definition_index, weapon_key,
               inventory_position::double precision as inventory_position,
               paint_index, paint_wear, paint_seed, quality, rarity, origin,
               kill_eater_score_type::double precision as kill_eater_score_type,
               kill_eater_value::double precision as kill_eater_value,
               custom_name, stickers, loadout_slot, collection_definition_index
        from player_b2g_inventory_items
        where player_id = ${playerId} and asset_id = any(${inputAssetIds})
        for update
      `;
      if (inputs.length !== 10) {
        throw new InventoryError(409, "Every Trade Up input must be an active B2G-owned cosmetic.");
      }
      const byAssetId = new Map(inputs.map((item) => [item.asset_id, item]));
      const orderedInputs = inputAssetIds.map((assetId) => byAssetId.get(assetId)!);
      const inputRarity = orderedInputs[0]!.rarity;
      const firstStatTrak = orderedInputs[0]!.quality === 9
        && orderedInputs[0]!.kill_eater_score_type === 0;
      if (inputRarity < 3 || inputRarity > 5) {
        throw new InventoryError(409, "Only blue, purple, or pink B2G skins can enter a Trade Up Contract.");
      }
      for (const item of orderedInputs) {
        const statTrak = item.quality === 9 && item.kill_eater_score_type === 0;
        const normal = item.quality === 4
          && item.kill_eater_score_type === null
          && item.kill_eater_value === null;
        const collection = item.collection_definition_index === null
          ? undefined
          : B2G_CASES.find((entry) => entry.definitionIndex === item.collection_definition_index);
        if (item.state !== "active" || item.item_kind !== "cosmetic"
          || item.paint_index === null || item.paint_wear === null
          || item.rarity !== inputRarity || (!normal && !statTrak)
          || statTrak !== firstStatTrak || !collection
          || !collection.rewards.some((reward) => reward.rarity === inputRarity + 1)) {
          throw new InventoryError(
            409,
            "Trade Up inputs must be ten compatible B2G skins of one rarity and one StatTrak class."
          );
        }
      }

      const collectionRoll = randomInt(10);
      const selectedCollectionDefinition = orderedInputs[collectionRoll]!.collection_definition_index!;
      const selectedCollection = B2G_CASES.find(
        (entry) => entry.definitionIndex === selectedCollectionDefinition
      )!;
      const outputRarity = inputRarity + 1;
      const candidates = selectedCollection.rewards.filter((reward) => reward.rarity === outputRarity);
      const candidateRoll = randomInt(candidates.length);
      const reward = candidates[candidateRoll]!;
      const averageWear = orderedInputs.reduce((total, item) => total + item.paint_wear!, 0) / 10;
      const wear = reward.minWear + averageWear * (reward.maxWear - reward.minWear);
      const recipeIndex = inputRarity - 1 + (firstStatTrak ? 10 : 0);
      const [allocated] = await transaction<{ asset_id: string }[]>`
        select nextval('b2g_inventory_asset_id_seq')::text as asset_id
      `;
      if (!allocated) throw new Error("Could not allocate the B2G trade-up reward.");
      const [created] = await transaction<TradeUpItemRow[]>`
        insert into player_b2g_inventory_items (
          player_id, asset_id, item_kind, definition_index, weapon_key,
          display_name, inventory_position, paint_index, paint_wear, paint_seed,
          quality, rarity, origin, kill_eater_score_type, kill_eater_value,
          loadout_slot, collection_definition_index
        ) values (
          ${playerId}, ${allocated.asset_id}, 'cosmetic', ${reward.definitionIndex},
          ${reward.weaponKey}, ${reward.displayName}, ${1_073_741_841}, ${reward.paintIndex},
          ${wear}, ${randomInt(1, 1_001)}, ${firstStatTrak ? 9 : 4}, ${outputRarity}, 8,
          ${firstStatTrak ? 0 : null}, ${firstStatTrak ? 0 : null}, ${reward.loadoutSlot},
          ${selectedCollectionDefinition}
        )
        returning asset_id, item_kind, state, definition_index, weapon_key,
                  inventory_position::double precision as inventory_position,
                  paint_index, paint_wear, paint_seed, quality, rarity, origin,
                  kill_eater_score_type::double precision as kill_eater_score_type,
                  kill_eater_value::double precision as kill_eater_value,
                  custom_name, stickers, loadout_slot, collection_definition_index
      `;
      if (!created) throw new Error("Could not persist the B2G trade-up reward.");
      await transaction`
        update player_b2g_inventory_items
        set state = 'consumed', consumed_at = now()
        where player_id = ${playerId} and asset_id = any(${inputAssetIds})
      `;
      await transaction`
        insert into player_b2g_trade_ups (
          player_id, input_fingerprint, input_asset_ids, input_rarity, output_rarity,
          stattrak, selected_collection_definition_index, collection_roll,
          candidate_roll, recipe_index, result_asset_id
        ) values (
          ${playerId}, ${inputFingerprint}, ${inputAssetIds}, ${inputRarity}, ${outputRarity},
          ${firstStatTrak}, ${selectedCollectionDefinition}, ${collectionRoll},
          ${candidateRoll}, ${recipeIndex}, ${created.asset_id}
        )
      `;
      return {
        alreadyCompleted: false,
        inputAssetIds,
        recipeIndex,
        item: b2gManifestItem(created)
      };
    });
  }

  private async recordFailure(
    playerId: string,
    status: "private" | "unavailable",
    code: string
  ): Promise<void> {
    await this.sql`
      insert into player_inventory_snapshots (
        player_id, status, last_attempt_at, next_refresh_at, last_error_code, updated_at
      ) values (
        ${playerId}, ${status}, now(),
        now() + ${REFRESH_COOLDOWN_SECONDS} * interval '1 second', ${code}, now()
      )
      on conflict (player_id) do update set
        status = excluded.status, last_attempt_at = excluded.last_attempt_at,
        next_refresh_at = excluded.next_refresh_at, last_error_code = excluded.last_error_code,
        updated_at = now()
    `;
  }
}
