import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function tokenize(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && input[index + 1] === "/") {
      index = input.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "{" || character === "}") {
      tokens.push(character);
      index += 1;
      continue;
    }
    if (character !== '"') throw new Error(`Unexpected items_game token at byte ${index}.`);
    index += 1;
    let value = "";
    while (index < input.length && input[index] !== '"') {
      if (input[index] === "\\" && index + 1 < input.length) {
        index += 1;
        value += input[index];
      } else {
        value += input[index];
      }
      index += 1;
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
      // The shipped schema extends paint_kits/items/sticker_kits in later
      // blocks. Keeping only the first block drops real supported content.
      const previous = result.get(key);
      if (previous instanceof Map) mergeMap(previous, nested);
      else result.set(key, nested);
    } else {
      result.set(key, value);
    }
  }
  return result;
}

function numericKeys(section, label) {
  if (!(section instanceof Map)) throw new Error(`items_game has no ${label} section.`);
  return [...section.keys()]
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .filter((value) => Number.isSafeInteger(value))
    .sort((left, right) => left - right);
}

function loadoutSlot(value) {
  if (typeof value !== "string") return null;
  if (value === "melee") return 0;
  const match = value.match(/^(secondary|smg|rifle|heavy)([0-5])$/);
  if (!match) return null;
  const base = { secondary: 2, smg: 8, rifle: 14, heavy: 20 }[match[1]];
  return base + Number(match[2]);
}

function itemPosition(item, prefabs, visiting = new Set()) {
  const direct = item.get("item_sub_position");
  if (typeof direct === "string") return direct;
  const names = item.get("prefab");
  if (typeof names !== "string") return null;
  const inherited = new Set();
  for (const name of names.split(/\s+/).filter(Boolean)) {
    if (visiting.has(name)) throw new Error(`Cyclic item prefab: ${name}`);
    const parent = prefabs.get(name);
    // Some schema-only items reference engine-provided prefabs (e.g. valve).
    // Without an explicit position, do not invent a loadout slot for them.
    if (!(parent instanceof Map)) return null;
    const position = itemPosition(parent, prefabs, new Set([...visiting, name]));
    if (position !== null) inherited.add(position);
  }
  if (inherited.size > 1) throw new Error("Conflicting inherited item positions.");
  return [...inherited][0] ?? null;
}

export function parseItemSchema(input) {
  const tokens = tokenize(input);
  const cursor = { index: 0 };
  const rootName = tokens[cursor.index++];
  if (rootName !== "items_game" || tokens[cursor.index++] !== "{") {
    throw new Error("Input is not a CS:GO items_game KeyValues file.");
  }
  const root = parseObject(tokens, cursor);
  if (tokens[cursor.index++] !== "}" || cursor.index !== tokens.length) {
    throw new Error("Trailing or unclosed items_game data.");
  }

  const definitions = numericKeys(root.get("items"), "items");
  const paintKits = numericKeys(root.get("paint_kits"), "paint_kits");
  const stickerKits = numericKeys(root.get("sticker_kits"), "sticker_kits");
  const items = root.get("items");
  const prefabs = root.get("prefabs") ?? new Map();
  const loadoutSlots = [...items.entries()].flatMap(([definitionIndex, item]) => {
    if (!/^\d+$/.test(definitionIndex) || !(item instanceof Map)) return [];
    const slot = loadoutSlot(itemPosition(item, prefabs));
    return slot === null ? [] : [[Number(definitionIndex), slot]];
  }).sort((left, right) => left[0] - right[0]);
  const sha256 = createHash("sha256").update(input).digest("hex");
  return { definitions, paintKits, stickerKits, loadoutSlots, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !outputArg) {
    throw new Error("Usage: node scripts/extract-legacy-econ-catalog.mjs <items_game.txt> <output.ts>");
  }
  const inputPath = resolve(inputArg);
  const outputPath = resolve(outputArg);
  const input = await readFile(inputPath, "utf8");
  const { definitions, paintKits, stickerKits, loadoutSlots, sha256 } = parseItemSchema(input);
  const generated = `// Generated from Valve's final September 2023 CS:GO item schema.\n`
    + `// Source SHA-256: ${sha256}\n`
    + `export const LEGACY_ECON_CATALOG = {\n`
    + `  sourceSha256: "${sha256}",\n`
    + `  definitionIndexes: new Set<number>(${JSON.stringify(definitions)}),\n`
    + `  paintKitIndexes: new Set<number>(${JSON.stringify(paintKits)}),\n`
    + `  stickerKitIndexes: new Set<number>(${JSON.stringify(stickerKits)}),\n`
    + `  loadoutSlots: new Map<number, number>(${JSON.stringify(loadoutSlots)})\n`
    + `} as const;\n`;
  await writeFile(outputPath, generated, "utf8");
  console.log(JSON.stringify({ inputPath, outputPath, definitions: definitions.length, paintKits: paintKits.length, stickerKits: stickerKits.length, loadoutSlots: loadoutSlots.length, sha256 }));
}
