import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseItemSchema } from './extract-legacy-econ-catalog.mjs';

test('catalog merges repeated sections and inherits knife loadout positions', () => {
  const schema = parseItemSchema(`"items_game" {
    "prefabs" {
      "melee" { "item_sub_position" "melee" }
      "melee_unusual" { "prefab" "melee" }
      "base_rifle" { "item_sub_position" "rifle1" }
    }
    "items" { "7" { "prefab" "base_rifle" } }
    "paint_kits" { "0" {} "282" {} }
    "sticker_kits" { "1" {} }
    "items" { "507" { "prefab" "melee_unusual" } }
    "paint_kits" { "572" {} }
    "sticker_kits" { "600" {} }
    "items" { "7" { "item_name" "AK-47" } }
  }`);
  assert.deepEqual(schema.definitions, [7, 507]);
  assert.deepEqual(schema.paintKits, [0, 282, 572]);
  assert.deepEqual(schema.stickerKits, [1, 600]);
  assert.deepEqual(schema.loadoutSlots, [[7, 15], [507, 0]]);
});

test('an explicit position overrides a prefab and malformed inheritance fails closed', () => {
  const wrap = (prefabs, item) => `"items_game" {
    "prefabs" { ${prefabs} } "items" { "507" { ${item} } }
    "paint_kits" { "0" {} } "sticker_kits" { "1" {} }
  }`;
  assert.deepEqual(parseItemSchema(wrap('"parent" { "item_sub_position" "rifle1" }',
    '"prefab" "parent" "item_sub_position" "melee"')).loadoutSlots, [[507, 0]]);
  assert.throws(() => parseItemSchema(wrap('"cycle" { "prefab" "cycle" }',
    '"prefab" "cycle"')), /Cyclic/);
  assert.deepEqual(parseItemSchema(wrap('', '"prefab" "missing"')).loadoutSlots, []);
  assert.throws(() => parseItemSchema(wrap(
    '"a" { "item_sub_position" "melee" } "b" { "item_sub_position" "rifle1" }',
    '"prefab" "a b"')), /Conflicting/);
});
