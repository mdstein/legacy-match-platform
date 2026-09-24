#include "stdafx.h"
#include "owned_inventory.h"
#include "keyvalue.h"

#include <cmath>
#include <filesystem>

namespace
{

template<typename T>
bool TryNumber(std::string_view text, T &value)
{
    T parsed{};
    const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (result.ec != std::errc{} || result.ptr != text.data() + text.size())
    {
        return false;
    }
    value = parsed;
    return true;
}

bool RequiredUint32(const KeyValue &key, std::string_view name, uint32_t &value)
{
    const KeyValue *field = key.GetSubkey(name);
    return field && TryNumber(field->String(), value);
}

bool IsAllowedAttribute(uint32_t definitionIndex)
{
    if (definitionIndex == 6 || definitionIndex == 7 || definitionIndex == 8
        || definitionIndex == 80 || definitionIndex == 81)
    {
        return true;
    }
    return (definitionIndex >= 113 && definitionIndex <= 136)
        || definitionIndex == ItemSchema::AttributeSpraysRemaining
        || definitionIndex == ItemSchema::AttributeSprayTintId;
}

bool ReadOwnedItem(const KeyValue &key, uint64_t steamId, uint64_t assetId,
    const ItemSchema &schema, B2GOwnedItem &owned)
{
    const std::string_view source = key.GetString("source", "steam");
    const std::string_view kind = key.GetString("item_kind", "cosmetic");
    const auto generation = key.GetString("ownership_generation", "0");
    if (!TryNumber(generation, owned.ownershipGeneration)
        || owned.ownershipGeneration > 9223372036854775807ULL
        || generation != std::to_string(owned.ownershipGeneration)) return false;
    if (source == "steam")
    {
        owned.source = B2GOwnedItemSource::Steam;
    }
    else if (source == "b2g")
    {
        owned.source = B2GOwnedItemSource::B2G;
    }
    else
    {
        return false;
    }
    if (kind == "cosmetic")
    {
        owned.kind = B2GOwnedItemKind::Cosmetic;
    }
    else if (kind == "case")
    {
        owned.kind = B2GOwnedItemKind::Case;
    }
    else if (kind == "key")
    {
        owned.kind = B2GOwnedItemKind::Key;
    }
    else
    {
        return false;
    }
    if (owned.source == B2GOwnedItemSource::Steam
        && owned.kind != B2GOwnedItemKind::Cosmetic)
    {
        return false;
    }
    uint32_t inventory = 0;
    uint32_t definitionIndex = 0;
    uint32_t level = 0;
    uint32_t quality = 0;
    uint32_t flags = 0;
    uint32_t origin = 0;
    uint32_t inUse = 0;
    uint32_t rarity = 0;
    if (!RequiredUint32(key, "inventory", inventory)
        || !RequiredUint32(key, "def_index", definitionIndex)
        || !RequiredUint32(key, "level", level)
        || !RequiredUint32(key, "quality", quality)
        || !RequiredUint32(key, "flags", flags)
        || !RequiredUint32(key, "origin", origin)
        || !RequiredUint32(key, "in_use", inUse)
        || !RequiredUint32(key, "rarity", rarity)
        || !RequiredUint32(key, "loadout_slot", owned.loadoutSlot)
        || !definitionIndex || definitionIndex > 65535 || owned.loadoutSlot > 63)
    {
        return false;
    }

    owned.item.set_id(assetId);
    owned.item.set_account_id(static_cast<uint32_t>(steamId));
    owned.item.set_inventory(inventory);
    owned.item.set_def_index(definitionIndex);
    owned.item.set_quantity(1);
    owned.item.set_level(level);
    owned.item.set_quality(quality);
    owned.item.set_flags(flags);
    owned.item.set_origin(origin);
    owned.item.set_in_use(inUse != 0);
    owned.item.set_rarity(rarity);

    const std::string_view customName = key.GetString("custom_name");
    if (customName.size() > 100
        || std::any_of(customName.begin(), customName.end(), [](unsigned char character) {
            return character < 0x20 || character == 0x7f;
        }))
    {
        return false;
    }
    if (!customName.empty())
    {
        owned.item.set_custom_name(std::string{ customName });
    }

    const KeyValue *attributes = key.GetSubkey("attributes");
    if (!attributes || attributes->SubkeyCount() > 32)
    {
        return false;
    }
    std::unordered_set<uint32_t> seenAttributes;
    for (const KeyValue &attributeKey : *attributes)
    {
        uint32_t attributeDefinition = 0;
        if (!TryNumber(attributeKey.Name(), attributeDefinition)
            || !IsAllowedAttribute(attributeDefinition)
            || !seenAttributes.insert(attributeDefinition).second)
        {
            return false;
        }
        CSOEconItemAttribute *attribute = owned.item.add_attribute();
        attribute->set_def_index(attributeDefinition);
        if (!schema.SetAttributeString(attribute, attributeKey.String()))
        {
            return false;
        }
    }

    const KeyValue *equippedStates = key.GetSubkey("equipped_state");
    if (!equippedStates || equippedStates->SubkeyCount() > 2)
    {
        return false;
    }
    std::unordered_set<uint32_t> seenClasses;
    for (const KeyValue &equippedKey : *equippedStates)
    {
        uint32_t classId = 0;
        uint32_t slotId = 0;
        if (!TryNumber(equippedKey.Name(), classId)
            || !TryNumber(equippedKey.String(), slotId)
            || !IsValidB2GLoadoutClass(classId, slotId)
            || slotId != owned.loadoutSlot
            || !seenClasses.insert(classId).second)
        {
            return false;
        }
        CSOEconItemEquipped *equipped = owned.item.add_equipped_state();
        equipped->set_new_class(classId);
        equipped->set_new_slot(slotId);
    }
    return true;
}

}

bool LoadB2GCommittedCounters(const B2GServerOwnedSnapshot &policy,
    const ItemSchema &schema, B2GCommittedCounters &counters)
{
    KeyValue file{ "b2g_committed_counters" };
    if (file.ParseFromFileDetailed(B2GCommittedCountersPath, true, 1024 * 1024)
        != KeyValueFileResult::Success || (file.SubkeyCount() != 6 && file.SubkeyCount() != 7)) return false;
    std::unordered_set<std::string> headers;
    for (const auto &entry : file) if (!headers.emplace(entry.Name()).second) return false;
    B2GCommittedCounters parsed;
    uint64_t fence{};
    if (file.GetString("format_version") != "1"
        || file.GetString("match_id") != policy.matchId || file.GetString("lease_id") != policy.leaseId
        || !TryNumber(file.GetString("fencing_token"), fence) || fence != policy.fencingToken
        || !TryNumber(file.GetString("sequence"), parsed.sequence)
        || !parsed.sequence || parsed.sequence > 9007199254740991ULL) return false;
    const auto *counts = file.GetSubkey("counts");
    const auto *generations = file.GetSubkey("ownership_generations");
    if (!counts || counts->SubkeyCount() > 16 * B2GMaxOwnedItems) return false;
    if (generations && generations->SubkeyCount() != counts->SubkeyCount()) return false;
    std::unordered_set<std::string> seen;
    for (const auto &entry : *counts)
    {
        const auto name = entry.Name();
        const auto separator = name.find(':');
        uint64_t owner{}, asset{};
        uint32_t count{};
        if (separator == std::string_view::npos || !seen.emplace(name).second
            || entry.SubkeyCount() || !TryNumber(name.substr(0, separator), owner)
            || !TryNumber(name.substr(separator + 1), asset) || !asset
            || (owner >> 32) != 0x01100001 || !static_cast<uint32_t>(owner)
            || !TryNumber(entry.String(), count)) return false;
        const auto player = policy.players.find(owner);
        if (player == policy.players.end()) continue;
        const auto item = player->second.find(asset);
        uint64_t generation{};
        if (generations && (!TryNumber(generations->GetString(name), generation)
            || generation > 9223372036854775807ULL)) return false;
        // Inventory removals can precede the next counter receipt. Never
        // resurrect those items or attach attributes to an ordinary weapon.
        if (item == player->second.end() || item->second.ownershipGeneration != generation
            || !B2GWeaponStatTrakCount(item->second, schema)) continue;
        parsed.players[owner][asset] = count;
    }
    counters = std::move(parsed);
    return true;
}

bool LoadB2GOwnedItems(uint64_t steamId, const ItemSchema &schema,
    B2GOwnedItems &items, std::string &error)
{
    items.clear();
    KeyValue manifest{ "b2g_owned_manifest" };
    const KeyValueFileResult result = manifest.ParseFromFileDetailed(B2GOwnedManifestPath, true, 16 * 1024 * 1024);
    if (result != KeyValueFileResult::Success)
    {
        error = result == KeyValueFileResult::NotFound ? "manifest not found"
            : result == KeyValueFileResult::Empty ? "manifest is empty"
            : result == KeyValueFileResult::ReadError ? "manifest could not be read"
            : "manifest has invalid KeyValues syntax";
        return false;
    }
    if (manifest.GetNumber<uint32_t>("format_version") != 1)
    {
        error = "unsupported manifest version";
        return false;
    }
    const KeyValue *players = manifest.GetSubkey("players");
    const std::string steamText = std::to_string(steamId);
    const KeyValue *player = players ? players->GetSubkey(steamText) : nullptr;
    const KeyValue *itemKeys = player ? player->GetSubkey("items") : nullptr;
    if (!itemKeys)
    {
        error = "player is not present in the manifest";
        return false;
    }
    if (itemKeys->SubkeyCount() > B2GMaxOwnedItems)
    {
        error = "manifest item limit exceeded";
        return false;
    }
    items.reserve(itemKeys->SubkeyCount());
    for (const KeyValue &itemKey : *itemKeys)
    {
        uint64_t assetId = 0;
        B2GOwnedItem owned;
        if (!TryNumber(itemKey.Name(), assetId) || !assetId
            || !ReadOwnedItem(itemKey, steamId, assetId, schema, owned)
            || !items.emplace(assetId, std::move(owned)).second)
        {
            items.clear();
            error = "manifest contains an invalid or duplicate item";
            return false;
        }
    }
    return true;
}

bool LoadB2GServerOwnedSnapshot(const ItemSchema &schema,
    B2GServerOwnedSnapshot &snapshot, std::string &error)
{
    // Bound the trusted-file reader too: a broken deployment must not cause
    // unbounded allocation in the server's GC worker.
    std::error_code ec;
    const auto size = std::filesystem::file_size(B2GOwnedManifestPath, ec);
    if (ec || size > 16 * 1024 * 1024)
    {
        error = "server inventory policy is unavailable or too large";
        return false;
    }
    KeyValue manifest{ "b2g_owned_manifest" };
    if (manifest.ParseFromFileDetailed(B2GOwnedManifestPath, true, 16 * 1024 * 1024)
        != KeyValueFileResult::Success)
    {
        error = "invalid server inventory policy syntax";
        return false;
    }
    // Reject duplicate headers rather than depending on first/last-key behavior.
    std::unordered_set<std::string> headers;
    for (const auto &field : manifest)
    {
        if (!headers.emplace(field.Name()).second)
        {
            error = "duplicate server policy header";
            return false;
        }
    }
    const auto hex = [](std::string_view value) {
        return std::all_of(value.begin(), value.end(), [](char c) {
            return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        });
    };
    const auto uuid = [&hex](std::string_view value) {
        if (value.size() != 36) return false;
        for (size_t i = 0; i < value.size(); ++i)
        {
            if (i == 8 || i == 13 || i == 18 || i == 23)
            {
                if (value[i] != '-') return false;
            }
            else if (!hex(value.substr(i, 1))) return false;
        }
        return true;
    };
    B2GServerOwnedSnapshot parsed;
    parsed.matchId = manifest.GetString("match_id");
    parsed.leaseId = manifest.GetString("lease_id");
    parsed.digest = manifest.GetString("manifest_sha256");
    if (manifest.GetString("format_version") != "1"
        || !uuid(parsed.matchId) || !uuid(parsed.leaseId)
        || parsed.digest.size() != 64 || !hex(parsed.digest)
        || !TryNumber(manifest.GetString("fencing_token"), parsed.fencingToken)
        || !parsed.fencingToken
        || !TryNumber(manifest.GetString("manifest_revision"), parsed.revision)
        || !parsed.revision || parsed.revision > 9007199254740991ULL)
    {
        error = "invalid server inventory policy authority";
        return false;
    }
    const auto expiry = manifest.GetString("expires_at");
    unsigned year{}, month{}, day{}, hour{}, minute{}, second{}, millis{};
    if (expiry.size() != 24 || expiry[4] != '-' || expiry[7] != '-'
        || expiry[10] != 'T' || expiry[13] != ':' || expiry[16] != ':'
        || expiry[19] != '.' || expiry[23] != 'Z'
        || !TryNumber(expiry.substr(0, 4), year) || year < 1970 || year > 2200
        || !TryNumber(expiry.substr(5, 2), month) || !TryNumber(expiry.substr(8, 2), day)
        || !TryNumber(expiry.substr(11, 2), hour) || hour > 23
        || !TryNumber(expiry.substr(14, 2), minute) || minute > 59
        || !TryNumber(expiry.substr(17, 2), second) || second > 59
        || !TryNumber(expiry.substr(20, 3), millis))
    {
        error = "invalid server inventory policy expiry";
        return false;
    }
    const std::chrono::year_month_day date{ std::chrono::year{ static_cast<int>(year) },
        std::chrono::month{ month }, std::chrono::day{ day } };
    if (!date.ok())
    {
        error = "invalid server inventory policy date";
        return false;
    }
    parsed.expiresAt = std::chrono::sys_days{ date } + std::chrono::hours{ hour }
        + std::chrono::minutes{ minute } + std::chrono::seconds{ second }
        + std::chrono::milliseconds{ millis };
    const auto *players = manifest.GetSubkey("players");
    if (!players || players->SubkeyCount() > 16)
    {
        error = "invalid server inventory player list";
        return false;
    }
    for (const auto &player : *players)
    {
        uint64_t steamId{};
        const auto *items = player.GetSubkey("items");
        if (!TryNumber(player.Name(), steamId) || (steamId >> 32) != 0x01100001
            || !static_cast<uint32_t>(steamId) || !items || player.SubkeyCount() != 1
            || items->SubkeyCount() > B2GMaxOwnedItems || parsed.players.contains(steamId))
        {
            error = "invalid or duplicate server inventory owner";
            return false;
        }
        auto &owned = parsed.players[steamId];
        for (const auto &key : *items)
        {
            uint64_t id{};
            B2GOwnedItem item;
            if (!TryNumber(key.Name(), id) || !id
                || !ReadOwnedItem(key, steamId, id, schema, item)
                || item.kind != B2GOwnedItemKind::Cosmetic
                || !owned.emplace(id, std::move(item)).second)
            {
                error = "invalid or duplicate server cosmetic";
                return false;
            }
        }
    }
    snapshot = std::move(parsed);
    return true;
}

bool HasValidB2GEquippedState(const CSOEconItem &candidate, const B2GOwnedItem &owned)
{
    if (owned.kind != B2GOwnedItemKind::Cosmetic)
    {
        return candidate.equipped_state_size() == 0;
    }
    if (candidate.equipped_state_size() > 2)
    {
        return false;
    }
    std::unordered_set<uint32_t> classes;
    for (const CSOEconItemEquipped &equipped : candidate.equipped_state())
    {
        if (!IsValidB2GLoadoutClass(equipped.new_class(), equipped.new_slot())
            || equipped.new_slot() != owned.loadoutSlot
            || !classes.insert(equipped.new_class()).second)
        {
            return false;
        }
    }
    return true;
}

bool IsExactB2GOwnedItem(const CSOEconItem &candidate, const B2GOwnedItem &owned)
{
    if (!HasValidB2GEquippedState(candidate, owned))
    {
        return false;
    }
    CSOEconItem candidateImmutable = candidate;
    CSOEconItem ownedImmutable = owned.item;
    candidateImmutable.clear_equipped_state();
    ownedImmutable.clear_equipped_state();
    return candidateImmutable.SerializeAsString() == ownedImmutable.SerializeAsString();
}

std::optional<uint32_t> B2GWeaponStatTrakCount(const B2GOwnedItem &owned, const ItemSchema &schema)
{
    if (owned.source != B2GOwnedItemSource::B2G || owned.kind != B2GOwnedItemKind::Cosmetic
        || owned.item.quality() != ItemSchema::QualityStrange) return std::nullopt;
    const auto *definition = schema.ItemInfoByDefIndex(owned.item.def_index());
    if (!definition || !definition->m_name.starts_with("weapon_")) return std::nullopt;
    std::optional<uint32_t> count, scoreType;
    for (const auto &attribute : owned.item.attribute())
    {
        if (attribute.def_index() == ItemSchema::AttributeKillEater)
            count = schema.AttributeUint32(&attribute);
        if (attribute.def_index() == ItemSchema::AttributeKillEaterScoreType)
            scoreType = schema.AttributeUint32(&attribute);
    }
    return scoreType == 0 ? count : std::nullopt;
}
