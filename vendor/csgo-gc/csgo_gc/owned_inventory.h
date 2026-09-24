#pragma once

#include "item_schema.h"

// Medals use the shared no-team flair slot; weapon team policy is unchanged.
constexpr bool IsValidB2GLoadoutClass(uint32_t classId, uint32_t slotId)
{
    return classId == 2 || classId == 3 || (classId == 0 && slotId == 55);
}

enum class B2GOwnedItemSource : uint8_t
{
    Steam,
    B2G
};

enum class B2GOwnedItemKind : uint8_t
{
    Cosmetic,
    Case,
    Key
};

struct B2GOwnedItem
{
    CSOEconItem item;
    uint32_t loadoutSlot{};
    uint64_t ownershipGeneration{};
    B2GOwnedItemSource source{ B2GOwnedItemSource::Steam };
    B2GOwnedItemKind kind{ B2GOwnedItemKind::Cosmetic };
};

using B2GOwnedItems = std::unordered_map<uint64_t, B2GOwnedItem>;

constexpr const char *B2GOwnedManifestPath = "csgo_gc/b2g_owned_manifest.txt";
constexpr const char *B2GCommittedCountersPath = "csgo_gc/b2g_committed_counters.txt";
constexpr size_t B2GMaxOwnedItems = 512;

// Read only from the node's signature-verified, atomically replaced policy.
// The digest is a revision watermark, not a signature checked by this library.
struct B2GServerOwnedSnapshot
{
    std::string matchId, leaseId, digest;
    uint64_t fencingToken{}, revision{};
    std::chrono::system_clock::time_point expiresAt{};
    std::unordered_map<uint64_t, B2GOwnedItems> players;

    bool SameLease(const B2GServerOwnedSnapshot &other) const
    {
        return matchId == other.matchId && leaseId == other.leaseId
            && fencingToken == other.fencingToken;
    }
};

bool LoadB2GServerOwnedSnapshot(const ItemSchema &schema,
    B2GServerOwnedSnapshot &snapshot, std::string &error);

// Node verifies the API receipt's HMAC and exact batch binding before writing
// this file. The GC additionally fences it against the current policy and only
// applies counts to that policy's existing owned StatTrak weapons.
struct B2GCommittedCounters
{
    uint64_t sequence{};
    std::unordered_map<uint64_t, std::unordered_map<uint64_t, uint32_t>> players;
};
bool LoadB2GCommittedCounters(const B2GServerOwnedSnapshot &policy,
    const ItemSchema &schema, B2GCommittedCounters &counters);

bool LoadB2GOwnedItems(uint64_t steamId, const ItemSchema &schema,
    B2GOwnedItems &items, std::string &error);
bool IsExactB2GOwnedItem(const CSOEconItem &candidate, const B2GOwnedItem &owned);
std::optional<uint32_t> B2GWeaponStatTrakCount(const B2GOwnedItem &owned, const ItemSchema &schema);
bool HasValidB2GEquippedState(const CSOEconItem &candidate, const B2GOwnedItem &owned);
