#include "stdafx.h"
#include "inventory.h"
#include "gc_server.h"
#include "gc_client.h"
#include "launcher_bridge.h"
#include "keyvalue.h"
#include "networking_client.h"
#include "networking_server.h"
#include "test_filesystem.h"

#include <cstdio>
#include <fstream>
#include <stdexcept>
#ifdef _WIN32
#include <Windows.h>
#undef SendMessage
#endif

namespace Platform
{

void Print(const char *, ...)
{
}

bool UpdateGraffitiKey(std::string_view, const void *, const void *, size_t)
{
    return true;
}

}

S_API void S_CALLTYPE SteamAPI_RegisterCallback(CCallbackBase *, int)
{
}

S_API void S_CALLTYPE SteamAPI_UnregisterCallback(CCallbackBase *)
{
}

namespace
{

constexpr uint64_t SteamId = 76561198000000077ull;
constexpr uint64_t EquippedAssetId = 8000000000000000001ull;
constexpr uint64_t UnequippedAssetId = 8000000000000000002ull;
constexpr uint64_t StaleAssetId = 8000000000000000003ull;
constexpr uint32_t LoadoutSlot = 15;

bool WriteConfig()
{
    KeyValue config{ "config" };
    config.AddNumber("b2g_owned_only", 1);
    return config.WriteToFile("csgo_gc/config.txt");
}

bool WriteSchema()
{
    KeyValue schemaRoot{ "root" };
    KeyValue &itemsGame = schemaRoot.AddSubkey("items_game");
    auto &attributes = itemsGame.AddSubkey("attributes");
    for (const char *id : { "6", "80", "81", "232" })
        attributes.AddSubkey(id).AddNumber("stored_as_integer", 1);
    itemsGame.AddSubkey("items").AddSubkey("7").AddString("name", "weapon_ak47");
    auto &medal = itemsGame.GetSubkey("items")->AddSubkey("1331");
    medal.AddString("name", "prestige coin 2015");
    medal.AddString("item_type", "prestige_coin");
    medal.AddSubkey("attributes").AddNumber("prestige year", 2015);
    KeyValue unusualLootLists{ "unusual_loot_lists" };
    unusualLootLists.AddNumber("fixture", 1);
    KeyValue gcLootLists{ "gc_loot_lists" };
    gcLootLists.AddNumber("fixture", 1);
    return schemaRoot.WriteToFile("csgo/scripts/items/items_game.txt")
        && unusualLootLists.WriteToFile("csgo_gc/unusual_loot_lists.txt")
        && gcLootLists.WriteToFile("csgo_gc/gc_loot_lists.txt");
}

void AddManifestItem(KeyValue &items, uint64_t assetId, uint32_t classId)
{
    KeyValue &item = items.AddSubkey(std::to_string(assetId));
    item.AddNumber("inventory", 1);
    item.AddNumber("def_index", 7);
    item.AddString("source", "b2g");
    item.AddString("item_kind", "cosmetic");
    item.AddNumber("level", 1);
    item.AddNumber("quality", 3);
    item.AddNumber("flags", 0);
    item.AddNumber("origin", ItemOriginTraded);
    item.AddNumber("in_use", 0);
    item.AddNumber("rarity", ItemSchema::RarityMythical);
    item.AddNumber("loadout_slot", LoadoutSlot);
    item.AddSubkey("attributes").AddNumber("6", 302);
    item.AddSubkey("equipped_state").AddNumber(std::to_string(classId), LoadoutSlot);
}

bool WriteManifest()
{
    KeyValue manifest{ "b2g_owned_manifest" };
    manifest.AddNumber("format_version", 1);
    KeyValue &items = manifest.AddSubkey("players")
        .AddSubkey(std::to_string(SteamId)).AddSubkey("items");
    AddManifestItem(items, EquippedAssetId, 3);
    AddManifestItem(items, UnequippedAssetId, 3);
    return manifest.WriteToFile(B2GOwnedManifestPath);
}

bool WriteLegacyLoadout()
{
    KeyValue loadout{ "b2g_loadout" };
    loadout.AddNumber("format_version", 1);
    KeyValue &items = loadout.AddSubkey("items");
    items.AddSubkey(std::to_string(EquippedAssetId))
        .AddSubkey("equipped_state").AddNumber("2", LoadoutSlot);
    // The previous writer produced exactly this empty item block for every
    // unequipped item.
    items.AddSubkey(std::to_string(UnequippedAssetId)).AddSubkey("equipped_state");
    items.AddSubkey(std::to_string(StaleAssetId))
        .AddSubkey("equipped_state").AddNumber("2", LoadoutSlot);
    return loadout.WriteToFile(
        ("csgo_gc/b2g_loadout_" + std::to_string(SteamId) + ".txt").c_str());
}

int EquippedSlotForClass(const CSOEconItem &item, uint32_t classId)
{
    for (const CSOEconItemEquipped &state : item.equipped_state())
    {
        if (state.new_class() == classId)
        {
            return static_cast<int>(state.new_slot());
        }
    }
    return -1;
}

bool ReconcilesLegacyEmptyAndStaleEntries()
{
    if (!TestFilesystem::MakeDirectory("csgo")
        || !TestFilesystem::MakeDirectory("csgo/scripts")
        || !TestFilesystem::MakeDirectory("csgo/scripts/items")
        || !TestFilesystem::MakeDirectory("csgo_gc")
        || !WriteConfig() || !WriteSchema() || !WriteManifest() || !WriteLegacyLoadout())
    {
        return false;
    }

    bool valid = false;
    {
        Inventory inventory{ SteamId };
        const CSOEconItem *equipped = inventory.GetItem(EquippedAssetId);
        const CSOEconItem *unequipped = inventory.GetItem(UnequippedAssetId);
        valid = equipped && unequipped
            && EquippedSlotForClass(*equipped, 2) == static_cast<int>(LoadoutSlot)
            && EquippedSlotForClass(*equipped, 3) == -1
            && unequipped->equipped_state_size() == 0;
    }

    KeyValue saved{ "b2g_loadout" };
    const std::string path = "csgo_gc/b2g_loadout_" + std::to_string(SteamId) + ".txt";
    const KeyValue *savedItems = nullptr;
    if (saved.ParseFromFileDetailed(path.c_str()) == KeyValueFileResult::Success)
    {
        savedItems = saved.GetSubkey("items");
    }
    return valid && savedItems && savedItems->SubkeyCount() == 1
        && savedItems->GetSubkey(std::to_string(EquippedAssetId))
        && !savedItems->GetSubkey(std::to_string(UnequippedAssetId))
        && !savedItems->GetSubkey(std::to_string(StaleAssetId));
}

constexpr uint64_t CaseAssetId = 8000000000000000010ull;
constexpr uint64_t KeyAssetId = 8000000000000000011ull;
constexpr uint64_t RewardAssetId = 8000000000000000012ull;
constexpr uint32_t NewCrateReward = InventoryUnacknowledged(UnacknowledgedFoundInCrate);

// Models the authenticated API's pre-open, post-open and acknowledged snapshots.
// These fixtures exercise GC state, not the Panorama animation or HTTP transport.
bool WriteCaseManifest(bool opened, bool withKey, uint32_t rewardPosition)
{
    // The generic KeyValue writer intentionally drops empty blocks. The real
    // launcher emits equipped_state {} for unequipped items; preserve those
    // required blocks in this fixture too.
    std::ofstream manifest{ B2GOwnedManifestPath, std::ios::binary | std::ios::trunc };
    manifest << "\"format_version\" \"1\"\n"
        // The node's atomic policy watermark must remain compatible with the
        // native loader. It is node replay metadata, not client item authority.
        << "\"match_id\" \"11111111-1111-4111-8111-111111111111\"\n"
        << "\"lease_id\" \"22222222-2222-4222-8222-222222222222\"\n"
        << "\"fencing_token\" \"42\"\n\"manifest_revision\" \"3\"\n"
        << "\"manifest_sha256\" \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"\n"
        << "\"players\" {\n\"" << SteamId << "\" {\n\"items\" {\n";
    const auto add = [&](uint64_t id, uint32_t position, const char *kind,
        uint32_t definition, ItemOrigin origin, bool equipped)
    {
        manifest << '"' << id << "\" {\n\"inventory\" \"" << position
            << "\"\n\"def_index\" \"" << definition
            << "\"\n\"source\" \"b2g\"\n\"item_kind\" \"" << kind
            << "\"\n\"level\" \"1\"\n\"quality\" \"3\"\n\"flags\" \"0\"\n\"origin\" \"" << origin
            << "\"\n\"in_use\" \"0\"\n\"rarity\" \"4\"\n\"loadout_slot\" \"15\"\n"
            << "\"attributes\" { \"6\" \"302\" }\n\"equipped_state\" { "
            << (equipped ? "\"2\" \"15\"" : "") << " }\n}\n";
    };
    add(EquippedAssetId, 130, "cosmetic", 7, ItemOriginTraded, true);
    if (opened)
    {
        add(RewardAssetId, rewardPosition, "cosmetic", 7, ItemOriginCrate, false);
    }
    else
    {
        add(CaseAssetId, 10, "case", 4288, ItemOriginLevelUpReward, false);
        if (withKey) add(KeyAssetId, 11, "key", 1343, ItemOriginLevelUpReward, false);
    }
    manifest << "}\n}\n}\n";
    manifest.close();
    return !manifest.fail();
}

bool CaseFailure(int line, bool withKey)
{
    std::fprintf(stderr, "Case reward lifecycle failed at line %d (withKey=%d)\n", line, withKey);
    return false;
}

bool CaseRewardRemainsNewUntilAcknowledged(bool withKey)
{
    if (!WriteCaseManifest(false, withKey, NewCrateReward)) return CaseFailure(__LINE__, withKey);
    {
        Inventory inventory{ SteamId };
        // Fetching the result manifest must not replace the local inventory
        // before the case completion has emitted its destroy/create messages.
        if (!WriteCaseManifest(true, withKey, NewCrateReward)) return CaseFailure(__LINE__, withKey);
        B2GOwnedItems owned;
        std::string error;
        if (!LoadB2GOwnedItems(SteamId, inventory.GetItemSchema(), owned, error)
            || !owned.contains(RewardAssetId)) return CaseFailure(__LINE__, withKey);
        CMsgSOSingleObject destroyedCase, destroyedKey, created;
        CMsgGCItemCustomizationNotification notification;
        const uint64_t keyId = withKey ? KeyAssetId : 0;
        if (!inventory.CompleteAuthoritativeCrateOpen(CaseAssetId, keyId,
                owned.at(RewardAssetId), destroyedCase, destroyedKey, created, notification))
            return CaseFailure(__LINE__, withKey);

        CSOEconItem emittedReward, emittedCase, emittedKey;
        if (!emittedReward.ParseFromString(created.object_data())
            || !emittedCase.ParseFromString(destroyedCase.object_data())
            || emittedCase.id() != CaseAssetId
            || emittedReward.id() != RewardAssetId
            || emittedReward.inventory() != NewCrateReward
            || emittedReward.origin() != ItemOriginCrate
            || notification.request() != k_EGCItemCustomizationNotification_UnlockCrate
            || notification.item_id_size() != 1 || notification.item_id(0) != RewardAssetId
            || created.version() <= destroyedCase.version()
            || inventory.GetItem(CaseAssetId) || inventory.GetItem(KeyAssetId)) return CaseFailure(__LINE__, withKey);
        if (withKey && (!emittedKey.ParseFromString(destroyedKey.object_data())
            || emittedKey.id() != KeyAssetId
            || destroyedKey.version() <= destroyedCase.version()
            || created.version() <= destroyedKey.version())) return CaseFailure(__LINE__, withKey);
        if (!withKey && destroyedKey.has_type_id()) return CaseFailure(__LINE__, withKey);

        CMsgSOSingleObject duplicateCase, duplicateKey, duplicateReward;
        CMsgGCItemCustomizationNotification duplicateNotice;
        if (inventory.CompleteAuthoritativeCrateOpen(CaseAssetId, keyId,
                owned.at(RewardAssetId), duplicateCase, duplicateKey,
                duplicateReward, duplicateNotice)
            || duplicateCase.has_type_id() || duplicateReward.has_type_id()
            || duplicateNotice.item_id_size()) return CaseFailure(__LINE__, withKey);
        if (!inventory.ReloadOwnedManifest(error)
            || !inventory.GetItem(RewardAssetId)
            || inventory.GetItem(RewardAssetId)->inventory() != NewCrateReward
            || inventory.GetItem(EquippedAssetId)->inventory() != 130) return CaseFailure(__LINE__, withKey);
    }
    {
        // A restart before acknowledgement must not silently hide the new item.
        Inventory inventory{ SteamId };
        if (!inventory.GetItem(RewardAssetId)
            || inventory.GetItem(RewardAssetId)->inventory() != NewCrateReward) return CaseFailure(__LINE__, withKey);
        CMsgSetItemPositions positions;
        auto *position = positions.add_item_positions();
        position->set_item_id(RewardAssetId);
        position->set_position(42);
        std::vector<CMsgItemAcknowledged> acknowledgements;
        CMsgSOMultipleObjects update;
        if (!inventory.SetItemPositions(positions, acknowledgements, update)
            || acknowledgements.size() != 1
            || acknowledgements[0].iteminfo().itemid() != RewardAssetId
            || inventory.GetItem(RewardAssetId)->inventory() != 42
            || update.objects_modified_size() != 1) return CaseFailure(__LINE__, withKey);
        // The launcher/API persists this acknowledgement before the next
        // signed manifest refresh. No global New-flag reset is simulated.
        if (!WriteCaseManifest(true, withKey, 42)) return CaseFailure(__LINE__, withKey);
        std::string error;
        if (!inventory.ReloadOwnedManifest(error)
            || inventory.GetItem(RewardAssetId)->inventory() != 42) return CaseFailure(__LINE__, withKey);
    }
    Inventory restarted{ SteamId };
    return restarted.GetItem(RewardAssetId)
        && restarted.GetItem(RewardAssetId)->inventory() == 42
        && restarted.GetItem(EquippedAssetId)->inventory() == 130
        && !restarted.GetItem(CaseAssetId) && !restarted.GetItem(KeyAssetId);
}

template<typename T>
bool ServerReply(ServerGC &server, uint64_t steamId, uint32_t type,
    const T &request, T &response)
{
    GCMessageWrite message{ type, request };
    server.PostToGC(GCEvent::NetMessage, steamId, message.Data(), message.Size());
    // A same-thread welcome request is a deterministic processing barrier, so
    // a rejected message need not be inferred from a sleep or timeout.
    CMsgClientHello hello;
    GCMessageWrite barrier{ k_EMsgGCServerHello, hello };
    server.PostToGC(GCEvent::Message, barrier.TypeMasked(), barrier.Data(), barrier.Size());
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 2 };
    bool found = false;
    while (std::chrono::steady_clock::now() < deadline)
    {
        std::vector<EventData> events;
        server.GetHostEvents(events);
        for (const EventData &event : events)
        {
            if (event.type != static_cast<int>(HostEvent::Message)) continue;
            GCMessageRead read{ static_cast<uint32_t>(event.id), event.buffer.data(),
                static_cast<uint32_t>(event.buffer.size()) };
            if (read.TypeUnmasked() == type)
            {
                if (!read.ReadProtobuf(response))
                    throw std::runtime_error("Server forwarded a malformed test response");
                found = true;
            }
            if (read.TypeUnmasked() == k_EMsgGCServerWelcome) return found;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds{ 1 });
    }
    throw std::runtime_error("Server message barrier timed out; rejection was not verified");
}

bool ServerFailure(int line)
{
    std::fprintf(stderr, "Server owned-item normalization failed at line %d\n", line);
    return false;
}

bool ServerAcceptsAcknowledgedOwnedItemWithoutTrustingItsMetadata()
{
    if (!WriteCaseManifest(true, false, NewCrateReward)) return ServerFailure(__LINE__);
    Inventory inventory{ SteamId };
    const CSOEconItem *owned = inventory.GetItem(RewardAssetId);
    if (!owned) return ServerFailure(__LINE__);
    CSOEconItem acknowledged = *owned;
    acknowledged.set_inventory(42);
    auto *equip = acknowledged.add_equipped_state();
    equip->set_new_class(2);
    equip->set_new_slot(LoadoutSlot);
    ServerGC server;
    // Prime the welcome before using it as the processing barrier below.
    CMsgClientHello hello;
    CMsgClientHello unused;
    ServerReply(server, SteamId, k_EMsgGCServerHello, hello, unused);

    auto single = [&](const CSOEconItem &item)
    {
        CMsgSOSingleObject request;
        request.mutable_owner_soid()->set_type(SoIdTypeSteamId);
        request.mutable_owner_soid()->set_id(SteamId);
        request.set_version(100);
        request.set_type_id(SOTypeItem);
        request.set_object_data(item.SerializeAsString());
        return request;
    };
    CMsgSOSingleObject response;
    CSOEconItem result;
    if (!ServerReply(server, SteamId, k_ESOMsg_Update, single(acknowledged), response)
        || !result.ParseFromString(response.object_data())
        || result.id() != RewardAssetId || result.inventory() != NewCrateReward
        || response.version() != 100 || response.owner_soid().id() != SteamId
        || EquippedSlotForClass(result, 2) != static_cast<int>(LoadoutSlot)) return ServerFailure(__LINE__);

    CMsgSOCacheSubscribed subscription, subscriptionResponse;
    subscription.mutable_owner_soid()->set_type(SoIdTypeSteamId);
    subscription.mutable_owner_soid()->set_id(SteamId);
    subscription.set_version(101);
    auto *items = subscription.add_objects();
    items->set_type_id(SOTypeItem);
    items->add_object_data(acknowledged.SerializeAsString());
    if (!ServerReply(server, SteamId, k_ESOMsg_CacheSubscribed, subscription, subscriptionResponse)
        || subscriptionResponse.objects_size() != 1
        || subscriptionResponse.objects(0).object_data_size() != 1
        || !result.ParseFromString(subscriptionResponse.objects(0).object_data(0))
        || subscriptionResponse.version() != 101 || subscriptionResponse.owner_soid().id() != SteamId
        || result.inventory() != NewCrateReward
        || EquippedSlotForClass(result, 2) != static_cast<int>(LoadoutSlot)) return ServerFailure(__LINE__);

    CMsgSOMultipleObjects multiple, multipleResponse;
    *multiple.mutable_owner_soid() = subscription.owner_soid();
    multiple.set_version(102);
    auto *update = multiple.add_objects_modified();
    update->set_type_id(SOTypeItem);
    update->set_object_data(acknowledged.SerializeAsString());
    if (!ServerReply(server, SteamId, k_ESOMsg_UpdateMultiple, multiple, multipleResponse)
        || multipleResponse.objects_modified_size() != 1
        || !result.ParseFromString(multipleResponse.objects_modified(0).object_data())
        || multipleResponse.version() != 102 || multipleResponse.owner_soid().id() != SteamId
        || result.inventory() != NewCrateReward
        || EquippedSlotForClass(result, 2) != static_cast<int>(LoadoutSlot)) return ServerFailure(__LINE__);

    const CSOEconItem *existing = inventory.GetItem(EquippedAssetId);
    if (!existing) return ServerFailure(__LINE__);
    CSOEconItem otherTeamItem = *existing;
    otherTeamItem.clear_equipped_state();
    auto *otherTeamEquip = otherTeamItem.add_equipped_state();
    otherTeamEquip->set_new_class(3);
    otherTeamEquip->set_new_slot(LoadoutSlot);
    CMsgSOCacheSubscribed validTwoItemCache = subscription;
    validTwoItemCache.mutable_objects(0)->add_object_data(otherTeamItem.SerializeAsString());
    if (!ServerReply(server, SteamId, k_ESOMsg_CacheSubscribed, validTwoItemCache, subscriptionResponse)
        || subscriptionResponse.objects(0).object_data_size() != 2)
        return ServerFailure(__LINE__);
    CMsgSOMultipleObjects validTwoItemUpdate = multiple;
    auto *validUpdate = validTwoItemUpdate.add_objects_modified();
    validUpdate->set_type_id(SOTypeItem);
    validUpdate->set_object_data(otherTeamItem.SerializeAsString());
    if (!ServerReply(server, SteamId, k_ESOMsg_UpdateMultiple, validTwoItemUpdate, multipleResponse)
        || multipleResponse.objects_modified_size() != 2)
        return ServerFailure(__LINE__);

    for (int mutation = 0; mutation < 9; ++mutation)
    {
        CSOEconItem fabricated = acknowledged;
        switch (mutation)
        {
        case 0: fabricated.set_id(RewardAssetId + 1); break;
        case 1: fabricated.set_account_id(fabricated.account_id() + 1); break;
        case 2: fabricated.set_quality(fabricated.quality() + 1); break;
        case 3: fabricated.set_rarity(fabricated.rarity() + 1); break;
        case 4: fabricated.mutable_attribute(0)->set_value_bytes("forged finish"); break;
        case 5: fabricated.mutable_equipped_state(0)->set_new_slot(63); break;
        case 6:
        {
            auto *counter = fabricated.add_attribute();
            counter->set_def_index(80);
            counter->set_value_bytes("fake");
            break;
        }
        case 7: fabricated.set_def_index(fabricated.def_index() + 1); break;
        case 8:
        {
            auto *wear = fabricated.add_attribute();
            wear->set_def_index(8);
            wear->set_value_bytes("fake");
            break;
        }
        }
        if (ServerReply(server, SteamId, k_ESOMsg_Update, single(fabricated), response))
            return ServerFailure(__LINE__);
        // Each bulk path must reject the entire message too, not forward a
        // partially validated loadout alongside a mutated item.
        CMsgSOCacheSubscribed forgedCache = subscription;
        forgedCache.mutable_objects(0)->set_object_data(0, otherTeamItem.SerializeAsString());
        forgedCache.mutable_objects(0)->add_object_data(fabricated.SerializeAsString());
        if (ServerReply(server, SteamId, k_ESOMsg_CacheSubscribed, forgedCache, subscriptionResponse))
            return ServerFailure(__LINE__);
        CMsgSOMultipleObjects forgedMultiple = multiple;
        forgedMultiple.mutable_objects_modified(0)->set_object_data(otherTeamItem.SerializeAsString());
        auto *forgedUpdate = forgedMultiple.add_objects_modified();
        forgedUpdate->set_type_id(SOTypeItem);
        forgedUpdate->set_object_data(fabricated.SerializeAsString());
        if (ServerReply(server, SteamId, k_ESOMsg_UpdateMultiple, forgedMultiple, multipleResponse))
            return ServerFailure(__LINE__);
    }
    // A position change must not accidentally authorize creating/destroying
    // an otherwise correctly owned item through the untrusted client channel.
    if (ServerReply(server, SteamId, k_ESOMsg_Create, single(acknowledged), response)
        || ServerReply(server, SteamId, k_ESOMsg_Destroy, single(acknowledged), response))
        return ServerFailure(__LINE__);
    // Socket-authenticated sender identity remains bound to the SO owner.
    if (ServerReply(server, SteamId + 1, k_ESOMsg_Update, single(acknowledged), response)
        || ServerReply(server, SteamId + 1, k_ESOMsg_CacheSubscribed, subscription, subscriptionResponse)
        || ServerReply(server, SteamId + 1, k_ESOMsg_UpdateMultiple, multiple, multipleResponse))
        return ServerFailure(__LINE__);

    // The same normalization works when the client is stale in the opposite
    // direction. It must use the current trusted file, never client New state.
    if (!WriteCaseManifest(true, false, 42)) return ServerFailure(__LINE__);
    acknowledged.set_inventory(NewCrateReward);
    if (!ServerReply(server, SteamId, k_ESOMsg_Update, single(acknowledged), response)
        || !result.ParseFromString(response.object_data()) || result.inventory() != 42)
        return ServerFailure(__LINE__);
    return true;
}

}

// Node-shaped fixture, deliberately independent of the client/full case bundle.
static bool WriteLivePolicy(uint64_t revision, uint32_t counter = 0, bool reward = false,
    bool original = true, const char *expiry = "2099-01-01T00:00:00.000Z", uint64_t fence = 42, uint64_t generation = 0)
{
    std::ofstream out{ B2GOwnedManifestPath, std::ios::binary | std::ios::trunc };
    out << "\"format_version\" \"1\"\n"
        << "\"match_id\" \"11111111-1111-4111-8111-111111111111\"\n"
        << "\"lease_id\" \"22222222-2222-4222-8222-222222222222\"\n"
        << "\"fencing_token\" \"" << fence << "\"\n"
        << "\"manifest_revision\" \"" << revision << "\"\n"
        << "\"manifest_sha256\" \"" << std::string(64, 'a' + revision % 6) << "\"\n"
        << "\"expires_at\" \"" << expiry << "\"\n"
        << "\"players\" { \"" << SteamId << "\" { \"items\" {\n";
    for (const auto id : { EquippedAssetId, RewardAssetId })
    {
        if ((id == EquippedAssetId && !original) || (id == RewardAssetId && !reward)) continue;
        out << '"' << id << "\" {\n"
            << "\"inventory\" \"130\" \"def_index\" \"7\" \"source\" \"b2g\" \"item_kind\" \"cosmetic\"\n"
            << "\"level\" \"1\" \"quality\" \"9\" \"flags\" \"0\" \"origin\" \"8\"\n"
            << "\"in_use\" \"0\" \"rarity\" \"4\" \"loadout_slot\" \"15\"\n"
            << "\"custom_name\" \"Policy " << revision << "\"\n"
            << "\"ownership_generation\" \"" << generation << "\"\n"
            << "\"attributes\" { \"6\" \"302\" \"80\" \"" << counter << "\" \"81\" \"0\" }\n"
            << "\"equipped_state\" { \"2\" \"15\" \"3\" \"15\" }\n}\n";
    }
    out << "} } }\n";
    out.close();
    return !out.fail();
}

static std::vector<EventData> ServerBarrier(ServerGC &server)
{
    CMsgClientHello hello;
    GCMessageWrite barrier{ k_EMsgGCServerHello, hello };
    server.PostToGC(GCEvent::Message, barrier.TypeMasked(), barrier.Data(), barrier.Size());
    std::vector<EventData> result, batch;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 2 };
    while (std::chrono::steady_clock::now() < deadline)
    {
        server.GetHostEvents(batch);
        bool done = false;
        for (auto &event : batch)
        {
            if (event.type == static_cast<int>(HostEvent::Message)
                && (event.id & ~ProtobufMask) == k_EMsgGCServerWelcome) done = true;
            else result.push_back(std::move(event));
        }
        if (done) return result;
        batch.clear();
        std::this_thread::sleep_for(std::chrono::milliseconds{ 1 });
    }
    throw std::runtime_error("Server inventory event barrier timed out");
}

struct ObservedServerCache
{
    uint64_t version{};
    std::unordered_map<uint64_t, CSOEconItem> items;
    int subscriptions{}, creates{}, destroys{}, updates{}, requests{};
    int countMessages{};
    std::unordered_map<uint64_t, uint32_t> statTrakCounts;

    bool Apply(const std::vector<EventData> &events)
    {
        const auto accept = [&](const std::string &data) {
            CSOEconItem item;
            if (!item.ParseFromString(data)) return false;
            items[item.id()] = item;
            return true;
        };
        for (const auto &event : events)
        {
            GCMessageRead read{ 0, event.buffer.data(), static_cast<uint32_t>(event.buffer.size()) };
            if (!read.IsValid()) return false;
            if (event.type == static_cast<int>(HostEvent::NetMessage))
            {
                if (read.TypeUnmasked() == k_EMsgNetworkStatTrakCount)
                {
                    if (event.id != SteamId || read.IsProtobuf() || read.RemainingBytes() != 20
                        || read.ReadUint64() != SteamId) return false;
                    const auto assetId = read.ReadUint64();
                    statTrakCounts[assetId] = read.ReadUint32();
                    ++countMessages;
                    continue;
                }
                if (event.id != SteamId || read.IsProtobuf()
                    || read.TypeUnmasked() != k_EMsgNetworkRequestSOCache || read.RemainingBytes()) return false;
                ++requests;
                continue;
            }
            uint64_t nextVersion{};
            CMsgSOIDOwner owner;
            if (read.TypeUnmasked() == k_ESOMsg_CacheSubscribed)
            {
                CMsgSOCacheSubscribed cache;
                if (!read.ReadProtobuf(cache)) return false;
                nextVersion = cache.version(); owner = cache.owner_soid();
                items.clear(); ++subscriptions;
                for (const auto &type : cache.objects())
                    for (const auto &data : type.object_data()) if (!accept(data)) return false;
            }
            else if (read.TypeUnmasked() == k_ESOMsg_UpdateMultiple)
            {
                CMsgSOMultipleObjects message;
                if (!read.ReadProtobuf(message)) return false;
                nextVersion = message.version(); owner = message.owner_soid();
                ++updates;
                for (const auto &object : message.objects_modified())
                {
                    CSOEconItem item;
                    if (!item.ParseFromString(object.object_data()) || !items.contains(item.id())
                        || !accept(object.object_data())) return false;
                }
            }
            else
            {
                CMsgSOSingleObject message;
                if (!read.ReadProtobuf(message)) return false;
                nextVersion = message.version(); owner = message.owner_soid();
                CSOEconItem item;
                if (!item.ParseFromString(message.object_data())) return false;
                if (read.TypeUnmasked() == k_ESOMsg_Create)
                {
                    if (items.contains(item.id()) || item.equipped_state_size()
                        || !accept(message.object_data())) return false;
                    ++creates;
                }
                else if (read.TypeUnmasked() == k_ESOMsg_Destroy)
                {
                    if (!items.erase(item.id())) return false;
                    ++destroys;
                }
                else return false;
            }
            if (nextVersion <= version || owner.type() != SoIdTypeSteamId || owner.id() != SteamId) return false;
            version = nextVersion;
        }
        return true;
    }
};

static bool LiveServerInventoryRefresh()
{
#define LIVE_CHECK(condition) do { if (!(condition)) return ServerFailure(__LINE__); } while (false)
    LIVE_CHECK(WriteLivePolicy(1));
    ItemSchema schema;
    B2GServerOwnedSnapshot policy;
    std::string error;
    LIVE_CHECK(LoadB2GServerOwnedSnapshot(schema, policy, error));
    LIVE_CHECK(policy.revision == 1 && policy.fencingToken == 42 && policy.players.size() == 1);
    CSOEconItem original = policy.players.at(SteamId).at(EquippedAssetId).item;
    original.clear_equipped_state();
    auto *ct = original.add_equipped_state(); ct->set_new_class(3); ct->set_new_slot(15);
    const auto cacheMessage = [&](const std::vector<CSOEconItem> &items) {
        CMsgSOCacheSubscribed message;
        message.mutable_owner_soid()->set_type(SoIdTypeSteamId);
        message.mutable_owner_soid()->set_id(SteamId);
        message.set_version(UINT64_MAX); // untrusted versions must never poison the server sequence
        auto *objects = message.add_objects(); objects->set_type_id(SOTypeItem);
        for (const auto &item : items) objects->add_object_data(item.SerializeAsString());
        return message;
    };
    ServerGC server;
    ServerBarrier(server); // prime welcome before asynchronous inventory messages
    ObservedServerCache observed;
    const auto sendCache = [&](const std::vector<CSOEconItem> &items, uint64_t sender = SteamId) {
        GCMessageWrite wire{ k_ESOMsg_CacheSubscribed, cacheMessage(items) };
        server.PostToGC(GCEvent::NetMessage, sender, wire.Data(), wire.Size());
        return observed.Apply(ServerBarrier(server));
    };
    const auto refresh = [&] {
        server.PostToGC(GCEvent::RefreshOwnedInventory, 0, nullptr, 0);
        return observed.Apply(ServerBarrier(server));
    };
    server.PostToGC(GCEvent::ClientConnected, SteamId, nullptr, 0);
    LIVE_CHECK(observed.Apply(ServerBarrier(server)) && observed.requests == 1);
    LIVE_CHECK(observed.countMessages == 1 && observed.statTrakCounts.at(EquippedAssetId) == 0);
    LIVE_CHECK(sendCache({ original }) && observed.version == 1 && observed.subscriptions == 1);
    LIVE_CHECK(sendCache({ original }) && observed.version == 1); // unchanged refresh is silent

    auto earlyReward = original;
    earlyReward.set_id(RewardAssetId);
    earlyReward.mutable_equipped_state(0)->set_new_class(2);
    LIVE_CHECK(sendCache({ original, earlyReward }) && observed.version == 1);

    LIVE_CHECK(WriteLivePolicy(2, 17, true) && refresh());
    LIVE_CHECK(observed.countMessages == 3 && observed.statTrakCounts.at(EquippedAssetId) == 17
        && observed.statTrakCounts.at(RewardAssetId) == 17);
    LIVE_CHECK(observed.updates == 1 && observed.items.at(EquippedAssetId).custom_name() == "Policy 2");
    LIVE_CHECK(EquippedSlotForClass(observed.items.at(EquippedAssetId), 3) == 15
        && EquippedSlotForClass(observed.items.at(EquippedAssetId), 2) == -1);
    LIVE_CHECK(LoadB2GServerOwnedSnapshot(schema, policy, error));
    auto expected = policy.players.at(SteamId).at(EquippedAssetId).item;
    *expected.mutable_equipped_state() = original.equipped_state();
    LIVE_CHECK(observed.items.at(EquippedAssetId).SerializeAsString() == expected.SerializeAsString());
    // A refresh request coalesced by the rate limiter must still be retried by
    // the real worker timer, without another client message or forced refresh.
    const auto retryDeadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 4 };
    while (observed.requests < 2 && std::chrono::steady_clock::now() < retryDeadline)
    {
        std::vector<EventData> events;
        server.GetHostEvents(events);
        LIVE_CHECK(observed.Apply(events));
        std::this_thread::sleep_for(std::chrono::milliseconds{ 20 });
    }
    LIVE_CHECK(observed.requests >= 2);
    const auto version2 = observed.version;
    // Stale client counter/name is normalized to the policy, without rollback.
    LIVE_CHECK(sendCache({ original }) && observed.version == version2);
    LIVE_CHECK(observed.countMessages == 3); // policy retry is not another increment
    // An equip of an acquired reward is recovered from a fresh client cache.
    auto reward = policy.players.at(SteamId).at(RewardAssetId).item;
    reward.clear_equipped_state();
    auto *t = reward.add_equipped_state(); t->set_new_class(2); t->set_new_slot(15);
    LIVE_CHECK(sendCache({ original, reward }) && observed.creates == 1 && observed.items.size() == 2);
    LIVE_CHECK(observed.subscriptions == 1); // refreshes use deltas, not full-cache replacement
    const auto acquiredVersion = observed.version;
    LIVE_CHECK(sendCache({ original, reward }, SteamId + 1) && observed.version == acquiredVersion);
    auto fabricated = reward; fabricated.set_def_index(9);
    LIVE_CHECK(sendCache({ original, fabricated }) && observed.version == acquiredVersion);
    // Raw client create/destroy stays forbidden even for an otherwise owned item.
    for (const auto type : { k_ESOMsg_Create, k_ESOMsg_Destroy })
    {
        CMsgSOSingleObject raw;
        raw.mutable_owner_soid()->set_type(SoIdTypeSteamId); raw.mutable_owner_soid()->set_id(SteamId);
        raw.set_type_id(SOTypeItem); raw.set_object_data(reward.SerializeAsString());
        GCMessageWrite wire{ static_cast<uint32_t>(type), raw };
        server.PostToGC(GCEvent::NetMessage, SteamId, wire.Data(), wire.Size());
        LIVE_CHECK(observed.Apply(ServerBarrier(server)) && observed.version == acquiredVersion);
    }
    // Older and conflicting equal revisions cannot replace the current authority.
    LIVE_CHECK(WriteLivePolicy(1) && refresh() && observed.version == acquiredVersion);
    LIVE_CHECK(WriteLivePolicy(2, 999) && refresh() && observed.version == acquiredVersion);
    LIVE_CHECK(WriteLivePolicy(3, 20, true, false));
    const auto watchDeadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 4 };
    while (!observed.destroys && std::chrono::steady_clock::now() < watchDeadline)
    {
        std::vector<EventData> events;
        server.GetHostEvents(events);
        LIVE_CHECK(observed.Apply(events));
        std::this_thread::sleep_for(std::chrono::milliseconds{ 20 });
    }
    LIVE_CHECK(observed.destroys == 1 && observed.items.size() == 1 && observed.items.contains(RewardAssetId));
    const auto removedVersion = observed.version;
    LIVE_CHECK(sendCache({ original, reward }) && observed.version == removedVersion); // removed item cannot return
    LIVE_CHECK(WriteLivePolicy(4, 20, true, false, "2000-01-01T00:00:00.000Z") && refresh());
    LIVE_CHECK(observed.items.empty() && observed.destroys == 2);
    const auto expiredVersion = observed.version;
    LIVE_CHECK(sendCache({ reward }) && observed.version == expiredVersion);
    // A new fenced lease does not authorize old connected players; reconnect is required.
    LIVE_CHECK(WriteLivePolicy(1, 0, true, true, "2099-01-01T00:00:00.000Z", 43) && refresh());
    LIVE_CHECK(sendCache({ reward }) && observed.version == expiredVersion);
    server.PostToGC(GCEvent::ClientSOCacheUnsubscribe, SteamId, nullptr, 0);
    ServerBarrier(server); // unsubscribe is tested separately, discard its notification
    observed = {};
    server.PostToGC(GCEvent::ClientConnected, SteamId, nullptr, 0);
    LIVE_CHECK(observed.Apply(ServerBarrier(server)));
    LIVE_CHECK(LoadB2GServerOwnedSnapshot(schema, policy, error));
    reward = policy.players.at(SteamId).at(RewardAssetId).item;
    reward.mutable_equipped_state()->RemoveLast();
    LIVE_CHECK(sendCache({ reward }) && observed.items.size() == 1 && observed.version > expiredVersion);

    // Parser rejects malformed authority/expiry instead of accidentally using
    // the permissive client bundle reader for a managed server connection.
    LIVE_CHECK(WriteLivePolicy(0) && !LoadB2GServerOwnedSnapshot(schema, policy, error));
    LIVE_CHECK(WriteLivePolicy(1, 0, false, true, "2099-02-30T00:00:00.000Z")
        && !LoadB2GServerOwnedSnapshot(schema, policy, error));
    LIVE_CHECK(WriteLivePolicy(1, 0, false, true, "2099-01-01T24:00:00.000Z")
        && !LoadB2GServerOwnedSnapshot(schema, policy, error));
    LIVE_CHECK(WriteLivePolicy(1, 0, false, true, "2099-01-01T00:00:00Z")
        && !LoadB2GServerOwnedSnapshot(schema, policy, error));
    LIVE_CHECK(WriteLivePolicy(1));
    const auto valid = LoadFile(B2GOwnedManifestPath);
    std::ofstream duplicate{ B2GOwnedManifestPath, std::ios::binary | std::ios::trunc };
    duplicate << valid << "\"manifest_revision\" \"9\"\n";
    duplicate.close();
    LIVE_CHECK(!LoadB2GServerOwnedSnapshot(schema, policy, error));
    return true;
#undef LIVE_CHECK
}

static bool LiveSprayAndEscapedNameRefresh()
{
    const auto writePolicy = [](uint64_t revision, uint32_t remaining, bool present = true) {
        if (!WriteLivePolicy(revision, remaining, false, present)) return false;
        auto data = LoadFile(B2GOwnedManifestPath);
        const auto replace = [&](const std::string &from, const std::string &to) {
            size_t offset = 0;
            while ((offset = data.find(from, offset)) != std::string::npos)
            {
                data.replace(offset, from.size(), to);
                offset += to.size();
            }
        };
        replace("\"def_index\" \"7\"", "\"def_index\" \"1348\"");
        replace("\"quality\" \"9\"", "\"quality\" \"3\"");
        replace("\"15\"", "\"56\"");
        replace("\"80\"", "\"232\"");
        replace("\"6\" \"302\" ", "");
        replace(" \"81\" \"0\"", "");
        replace("\"Policy " + std::to_string(revision) + "\"", R"kv("a \"quoted\" \\ name")kv");
        std::ofstream out{ B2GOwnedManifestPath, std::ios::binary | std::ios::trunc };
        out << data; out.close();
        return !out.fail();
    };
    if (!writePolicy(1, 50)) return ServerFailure(__LINE__);
    ItemSchema schema;
    B2GServerOwnedSnapshot policy;
    B2GOwnedItems clientItems;
    std::string error;
    if (!LoadB2GServerOwnedSnapshot(schema, policy, error)
        || !LoadB2GOwnedItems(SteamId, schema, clientItems, error)) return ServerFailure(__LINE__);
    auto spray = clientItems.at(EquippedAssetId).item;
    if (spray.custom_name() != "a \"quoted\" \\ name"
        || spray.SerializeAsString() != policy.players.at(SteamId).at(EquippedAssetId).item.SerializeAsString())
        return ServerFailure(__LINE__);
    spray.mutable_equipped_state()->RemoveLast();
    ServerGC server;
    ServerBarrier(server);
    server.PostToGC(GCEvent::ClientConnected, SteamId, nullptr, 0);
    ObservedServerCache observed;
    if (!observed.Apply(ServerBarrier(server))) return ServerFailure(__LINE__);
    CMsgSOCacheSubscribed cache;
    cache.mutable_owner_soid()->set_type(SoIdTypeSteamId); cache.mutable_owner_soid()->set_id(SteamId);
    auto *objects = cache.add_objects(); objects->set_type_id(SOTypeItem);
    objects->add_object_data(spray.SerializeAsString());
    GCMessageWrite wire{ k_ESOMsg_CacheSubscribed, cache };
    server.PostToGC(GCEvent::NetMessage, SteamId, wire.Data(), wire.Size());
    if (!observed.Apply(ServerBarrier(server)) || observed.items.size() != 1) return ServerFailure(__LINE__);
    if (!writePolicy(2, 1)) return ServerFailure(__LINE__);
    server.PostToGC(GCEvent::RefreshOwnedInventory, 0, nullptr, 0);
    if (!observed.Apply(ServerBarrier(server)) || observed.updates != 1
        || !LoadB2GServerOwnedSnapshot(schema, policy, error)) return ServerFailure(__LINE__);
    auto expected = policy.players.at(SteamId).at(EquippedAssetId).item;
    *expected.mutable_equipped_state() = spray.equipped_state();
    if (observed.items.at(EquippedAssetId).SerializeAsString() != expected.SerializeAsString())
        return ServerFailure(__LINE__);
    // Replaying the client's old 50-use value cannot refill the spray.
    const auto version = observed.version;
    server.PostToGC(GCEvent::NetMessage, SteamId, wire.Data(), wire.Size());
    if (!observed.Apply(ServerBarrier(server)) || observed.version != version) return ServerFailure(__LINE__);
    if (!writePolicy(3, 0, false)) return ServerFailure(__LINE__);
    server.PostToGC(GCEvent::RefreshOwnedInventory, 0, nullptr, 0);
    return observed.Apply(ServerBarrier(server)) && observed.items.empty() && observed.destroys == 1;
}

// A real ClientGC worker behind the real ticket/peer gate; the transport alone
// is fake. No Steam client, GUI, game process or production inventory is used.
class CounterTestTransport final : public ISteamNetworkingMessages
{
    struct Message : SteamNetworkingMessage_t { Message() : SteamNetworkingMessage_t() {} };
    std::queue<SteamNetworkingMessage_t *> incoming;
public:
    ~CounterTestTransport() { while (!incoming.empty()) { incoming.front()->Release(); incoming.pop(); } }
    std::vector<uint64_t> recipients;
    void Enqueue(uint64_t sender, const GCMessageWrite &wire)
    {
        auto *message = new Message;
        message->m_identityPeer.SetSteamID64(sender);
        message->m_cbSize = wire.Size();
        message->m_pData = new uint8_t[wire.Size()];
        memcpy(message->m_pData, wire.Data(), wire.Size());
        message->m_pfnRelease = [](SteamNetworkingMessage_t *value) {
            delete[] static_cast<uint8_t *>(value->m_pData); delete static_cast<Message *>(value);
        };
        incoming.push(message);
    }
    EResult SendMessageToUser(const SteamNetworkingIdentity &identity, const void *, uint32, int, int) override
    { recipients.push_back(identity.GetSteamID64()); return k_EResultOK; }
    int ReceiveMessagesOnChannel(int, SteamNetworkingMessage_t **message, int) override
    {
        if (incoming.empty()) return 0;
        *message = incoming.front(); incoming.pop(); return 1;
    }
    bool AcceptSessionWithUser(const SteamNetworkingIdentity &) override { return true; }
    bool CloseSessionWithUser(const SteamNetworkingIdentity &) override { return true; }
    bool CloseChannelWithUser(const SteamNetworkingIdentity &, int) override { return true; }
    ESteamNetworkingConnectionState GetSessionConnectionInfo(const SteamNetworkingIdentity &,
        SteamNetConnectionInfo_t *, SteamNetworkingQuickConnectionStatus *) override { return k_ESteamNetworkingConnectionState_None; }
};

static uint32_t Counter(const CSOEconItem &item, const ItemSchema &schema)
{
    for (const auto &attribute : item.attribute())
        if (attribute.def_index() == ItemSchema::AttributeKillEater) return schema.AttributeUint32(&attribute);
    throw std::runtime_error("Test item is missing its counter");
}

static bool LiveStatTrakClientUpdatesAreNarrowAndIdempotent()
{
#define COUNTER_CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "Live counter failed at line %d\n", __LINE__); return false; } } while (false)
    COUNTER_CHECK(WriteLivePolicy(1, 4, true));
    ItemSchema schema;
    B2GOwnedItems owned;
    std::string error;
    COUNTER_CHECK(LoadB2GOwnedItems(SteamId, schema, owned, error));
    const auto original = owned.at(EquippedAssetId);
    COUNTER_CHECK(B2GWeaponStatTrakCount(original, schema) == 4);
    auto rejected = original; rejected.source = B2GOwnedItemSource::Steam;
    COUNTER_CHECK(!B2GWeaponStatTrakCount(rejected, schema));
    rejected = original; rejected.kind = B2GOwnedItemKind::Case;
    COUNTER_CHECK(!B2GWeaponStatTrakCount(rejected, schema));
    rejected = original; rejected.item.set_quality(3);
    COUNTER_CHECK(!B2GWeaponStatTrakCount(rejected, schema));
    rejected = original; rejected.item.set_def_index(1348);
    COUNTER_CHECK(!B2GWeaponStatTrakCount(rejected, schema));
    rejected = original;
    for (auto &attribute : *rejected.item.mutable_attribute())
        if (attribute.def_index() == ItemSchema::AttributeKillEaterScoreType) schema.SetAttributeUint32(&attribute, 1);
    COUNTER_CHECK(!B2GWeaponStatTrakCount(rejected, schema));
    rejected = original; rejected.item.clear_attribute();
    COUNTER_CHECK(!B2GWeaponStatTrakCount(rejected, schema));

    // Concurrent inventory refresh cannot roll the number back, change loadout,
    // or turn a known item into a new acquisition. A restart uses persisted data.
    {
        Inventory inventory{ SteamId };
        auto before = *inventory.GetItem(EquippedAssetId);
        CMsgSOSingleObject update;
        COUNTER_CHECK(inventory.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 5, update));
        auto expected = before;
        for (auto &attribute : *expected.mutable_attribute())
            if (attribute.def_index() == ItemSchema::AttributeKillEater) schema.SetAttributeUint32(&attribute, 5);
        COUNTER_CHECK(update.object_data() == expected.SerializeAsString());
        COUNTER_CHECK(!inventory.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 5, update));
        COUNTER_CHECK(!inventory.ApplyAuthoritativeStatTrakCount(StaleAssetId, 999, update));
        COUNTER_CHECK(inventory.ReloadOwnedManifest(error));
        COUNTER_CHECK(inventory.GetItem(EquippedAssetId)->SerializeAsString() == expected.SerializeAsString());
        COUNTER_CHECK(WriteLivePolicy(2, 6, true) && inventory.ReloadOwnedManifest(error));
        COUNTER_CHECK(Counter(*inventory.GetItem(EquippedAssetId), schema) == 6);
    }
    { Inventory persisted{ SteamId }; COUNTER_CHECK(Counter(*persisted.GetItem(EquippedAssetId), schema) == 6); }

    CounterTestTransport transport;
    NetworkingClient networking{ &transport };
    ClientGC gc{ SteamId };
    constexpr uint64_t serverId = 90000000000000001ull;
    const uint8_t ticket[]{ 1, 2, 3, 4 };
    networking.SetAuthTicket(1, ticket, sizeof(ticket));
    const auto wireCount = [](uint32_t count, uint64_t owner = SteamId, uint64_t item = EquippedAssetId) {
        GCMessageWrite wire{ k_EMsgNetworkStatTrakCount };
        wire.WriteUint64(owner); wire.WriteUint64(item); wire.WriteUint32(count); return wire;
    };
    const auto drain = [&](std::optional<uint32_t> expectedCount = std::nullopt, int expectedCaches = 0) {
        GCMessageWrite barrier{ k_EMsgGCCraft }; barrier.WriteUint16(static_cast<uint16_t>(-3));
        gc.PostToGC(GCEvent::Message, barrier.TypeMasked(), barrier.Data(), barrier.Size());
        int updates = 0, caches = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 2 };
        while (std::chrono::steady_clock::now() < deadline)
        {
            std::vector<EventData> events; gc.GetHostEvents(events);
            for (const auto &event : events)
            {
                if (event.type == static_cast<int>(HostEvent::Message) && event.id == k_EMsgGCCraftResponse)
                    return updates == (expectedCount ? 1 : 0) && caches == expectedCaches;
                GCMessageRead read{ 0, event.buffer.data(), static_cast<uint32_t>(event.buffer.size()) };
                if (event.type == static_cast<int>(HostEvent::NetMessage))
                {
                    if (read.TypeUnmasked() != k_ESOMsg_CacheSubscribed) return false; // never echo a counter back
                    ++caches; continue;
                }
                CMsgSOSingleObject update;
                CSOEconItem item;
                if (!expectedCount || event.type != static_cast<int>(HostEvent::Message)
                    || read.TypeUnmasked() != k_ESOMsg_Update || !read.ReadProtobuf(update)
                    || update.type_id() != SOTypeItem || update.owner_soid().id() != SteamId
                    || !item.ParseFromString(update.object_data()) || item.id() != EquippedAssetId
                    || item.inventory() != original.item.inventory() || Counter(item, schema) != *expectedCount) return false;
                ++updates;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds{ 1 });
        }
        return false;
    };
    transport.Enqueue(serverId, wireCount(7)); networking.Update(&gc);
    COUNTER_CHECK(drain()); // no authenticated server yet
    GCMessageWrite connect{ k_EMsgNetworkConnect };
    connect.WriteUint32(sizeof(ticket)); connect.WriteData(ticket, sizeof(ticket));
    transport.Enqueue(serverId, connect); networking.Update(&gc);
    COUNTER_CHECK(drain(std::nullopt, 1));
    transport.Enqueue(serverId + 1, wireCount(7)); networking.Update(&gc);
    COUNTER_CHECK(drain());
    transport.Enqueue(serverId, wireCount(7)); networking.Update(&gc);
    COUNTER_CHECK(drain(7));
    transport.Enqueue(serverId, wireCount(7));
    transport.Enqueue(serverId, wireCount(6));
    transport.Enqueue(serverId, wireCount(8, SteamId + 1));
    transport.Enqueue(serverId, wireCount(8, SteamId, StaleAssetId));
    auto extra = wireCount(8); extra.WriteUint32(1); transport.Enqueue(serverId, extra);
    GCMessageWrite truncated{ k_EMsgNetworkStatTrakCount }; truncated.WriteUint64(SteamId);
    transport.Enqueue(serverId, truncated);
    CMsgIncrementKillCountAttribute increment;
    increment.set_killer_account_id(static_cast<uint32_t>(SteamId)); increment.set_item_id(EquippedAssetId);
    increment.set_amount(1); increment.set_event_type(0);
    GCMessageWrite additive{ k_EMsgGC_IncrementKillCountAttribute, increment };
    transport.Enqueue(serverId, additive); // engine event plus absolute state must not count twice
    networking.Update(&gc);
    auto forged = wireCount(999);
    gc.PostToGC(GCEvent::Message, forged.TypeMasked(), forged.Data(), forged.Size());
    gc.PostToGC(GCEvent::Message, additive.TypeMasked(), additive.Data(), additive.Size());
    COUNTER_CHECK(drain());
    transport.Enqueue(serverId, wireCount(UINT32_MAX)); networking.Update(&gc);
    COUNTER_CHECK(drain(UINT32_MAX));
    transport.Enqueue(serverId, wireCount(UINT32_MAX)); networking.Update(&gc);
    COUNTER_CHECK(drain());
    networking.ClearAuthTicket(1);
    transport.Enqueue(serverId, wireCount(8, SteamId, RewardAssetId)); networking.Update(&gc);
    COUNTER_CHECK(drain());
    return true;
#undef COUNTER_CHECK
}

static std::vector<EventData> ClientRefreshBarrier(ClientGC &gc)
{
    gc.PostToGC(GCEvent::LauncherBridgeMessage,
        static_cast<uint16_t>(LauncherBridge::MessageType::InventoryRefresh), nullptr, 0);
    GCMessageWrite barrier{ k_EMsgGCCraft }; barrier.WriteUint16(static_cast<uint16_t>(-3));
    gc.PostToGC(GCEvent::Message, barrier.TypeMasked(), barrier.Data(), barrier.Size());
    std::vector<EventData> result;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 2 };
    while (std::chrono::steady_clock::now() < deadline)
    {
        std::vector<EventData> batch; gc.GetHostEvents(batch);
        for (auto &event : batch)
        {
            if (event.type == static_cast<int>(HostEvent::Message) && event.id == k_EMsgGCCraftResponse)
                return result;
            result.push_back(std::move(event));
        }
        std::this_thread::sleep_for(std::chrono::milliseconds{ 1 });
    }
    throw std::runtime_error("Client inventory refresh barrier timed out");
}

static bool PeriodicInventoryRefreshEmitsOnlyDeltas()
{
#define DELTA_CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "Inventory delta failed at line %d\n", __LINE__); return false; } } while (false)
    DELTA_CHECK(WriteLivePolicy(1, 4));
    ItemSchema schema;
    {
        ClientGC gc{ SteamId };
        DELTA_CHECK(ClientRefreshBarrier(gc).empty());
        // Same content/name/position, only the persisted weapon count changed.
        DELTA_CHECK(WriteLivePolicy(1, 5));
        auto messages = ClientRefreshBarrier(gc);
        DELTA_CHECK(messages.size() == 1 && messages[0].type == static_cast<int>(HostEvent::Message));
        GCMessageRead read{ 0, messages[0].buffer.data(), static_cast<uint32_t>(messages[0].buffer.size()) };
        CMsgSOMultipleObjects update;
        CSOEconItem item;
        DELTA_CHECK(read.TypeUnmasked() == k_ESOMsg_UpdateMultiple && read.ReadProtobuf(update));
        DELTA_CHECK(update.owner_soid().id() == SteamId && update.owner_soid().type() == SoIdTypeSteamId
            && update.objects_modified_size() == 1 && update.objects_modified(0).type_id() == SOTypeItem
            && item.ParseFromString(update.objects_modified(0).object_data())
            && item.id() == EquippedAssetId && Counter(item, schema) == 5 && item.inventory() == 130);
        DELTA_CHECK(ClientRefreshBarrier(gc).empty());
        // Failed file publication cannot empty the inventory. Once the file
        // recovers, the unchanged snapshot must remain silent as well.
        { std::ofstream broken{ B2GOwnedManifestPath, std::ios::trunc }; broken << "\"format_version\" {"; }
        DELTA_CHECK(ClientRefreshBarrier(gc).empty());
        DELTA_CHECK(WriteLivePolicy(1, 5) && ClientRefreshBarrier(gc).empty());
    }
    DELTA_CHECK(WriteCaseManifest(false, false, NewCrateReward));
    {
        ClientGC gc{ SteamId };
        DELTA_CHECK(WriteCaseManifest(true, false, NewCrateReward));
        auto messages = ClientRefreshBarrier(gc);
        DELTA_CHECK(messages.size() == 2); // remove consumed case, add reward; no reset/reveal replay
        uint64_t version = 0;
        for (size_t index = 0; index < messages.size(); ++index)
        {
            const auto &event = messages[index];
            DELTA_CHECK(event.type == static_cast<int>(HostEvent::Message));
            GCMessageRead read{ 0, event.buffer.data(), static_cast<uint32_t>(event.buffer.size()) };
            CMsgSOSingleObject change; CSOEconItem item;
            DELTA_CHECK(read.TypeUnmasked() == static_cast<uint32_t>(index == 0 ? k_ESOMsg_Destroy : k_ESOMsg_Create)
                && read.ReadProtobuf(change) && change.type_id() == SOTypeItem
                && change.owner_soid().id() == SteamId && change.version() > version
                && item.ParseFromString(change.object_data()));
            version = change.version();
            DELTA_CHECK(item.id() == (index == 0 ? CaseAssetId : RewardAssetId));
            if (index == 1) DELTA_CHECK(item.inventory() == NewCrateReward);
        }
        DELTA_CHECK(ClientRefreshBarrier(gc).empty()); // New remains New, but is never re-created
        DELTA_CHECK(WriteCaseManifest(true, false, 42));
        messages = ClientRefreshBarrier(gc);
        DELTA_CHECK(messages.size() == 1);
        GCMessageRead read{ 0, messages[0].buffer.data(), static_cast<uint32_t>(messages[0].buffer.size()) };
        CMsgSOMultipleObjects update; CSOEconItem acknowledged;
        DELTA_CHECK(read.TypeUnmasked() == k_ESOMsg_UpdateMultiple && read.ReadProtobuf(update)
            && update.objects_modified_size() == 1
            && acknowledged.ParseFromString(update.objects_modified(0).object_data())
            && acknowledged.id() == RewardAssetId && acknowledged.inventory() == 42);
        DELTA_CHECK(ClientRefreshBarrier(gc).empty());
    }
    return true;
#undef DELTA_CHECK
}

static bool LocalPracticeKeepsOwnedSkinsWithoutDedicatedFallback()
{
#define PRACTICE_CHECK(value) do { if (!(value)) { std::fprintf(stderr, "Practice inventory failed at line %d\n", __LINE__); return false; } } while (false)
    PRACTICE_CHECK(WriteManifest());
    ItemSchema schema;
    B2GOwnedItems items;
    std::string error;
    PRACTICE_CHECK(LoadB2GOwnedItems(SteamId, schema, items, error));
    auto skin = items.at(EquippedAssetId).item;
    skin.clear_equipped_state();
    auto *equipped = skin.add_equipped_state();
    equipped->set_new_class(2); equipped->set_new_slot(LoadoutSlot);
    CMsgSOCacheSubscribed request, reply;
    request.mutable_owner_soid()->set_type(SoIdTypeSteamId);
    request.mutable_owner_soid()->set_id(SteamId);
    request.set_version(400);
    auto *objects = request.add_objects();
    objects->set_type_id(SOTypeItem);
    objects->add_object_data(skin.SerializeAsString());
    ServerGC dedicated;
    dedicated.PostToGC(GCEvent::ClientConnected, SteamId, nullptr, 0);
    ServerBarrier(dedicated);
    PRACTICE_CHECK(!ServerReply(dedicated, SteamId, k_ESOMsg_CacheSubscribed, request, reply));
    ServerGC practice{ SteamId };
    practice.PostToGC(GCEvent::ClientConnected, SteamId, nullptr, 0);
    ServerBarrier(practice);
    PRACTICE_CHECK(ServerReply(practice, SteamId, k_ESOMsg_CacheSubscribed, request, reply));
    CSOEconItem visible;
    PRACTICE_CHECK(reply.objects_size() == 1 && reply.objects(0).object_data_size() == 1
        && visible.ParseFromString(reply.objects(0).object_data(0))
        && visible.id() == EquippedAssetId && visible.attribute_size() == skin.attribute_size()
        && EquippedSlotForClass(visible, 2) == static_cast<int>(LoadoutSlot));
    request.mutable_owner_soid()->set_id(SteamId + 1);
    PRACTICE_CHECK(!ServerReply(practice, SteamId + 1, k_ESOMsg_CacheSubscribed, request, reply));
    // A local session receives no dedicated-server committed-count messages.
    for (const auto &event : ServerBarrier(practice))
        PRACTICE_CHECK(event.type != static_cast<int>(HostEvent::NetMessage));
    return true;
#undef PRACTICE_CHECK
}

static bool CommittedCountersAreFencedAndSurviveStaleSnapshots()
{
#define RECEIPT_CHECK(value) do { if (!(value)) { std::fprintf(stderr, "Committed counters failed at line %d\n", __LINE__); return false; } } while (false)
    RECEIPT_CHECK(WriteLivePolicy(1, 4, true));
    KeyValue policy{ "policy" };
    RECEIPT_CHECK(policy.ParseFromFile(B2GOwnedManifestPath));
    const auto writeReceipt = [&](uint64_t sequence, uint32_t count, uint64_t fence = 42,
        std::optional<uint64_t> generation = std::nullopt) {
        KeyValue file{ "counters" };
        file.AddNumber("format_version", 1);
        file.AddString("match_id", policy.GetString("match_id"));
        file.AddString("lease_id", policy.GetString("lease_id"));
        file.AddNumber("fencing_token", fence);
        file.AddNumber("sequence", sequence);
        file.AddSubkey("counts").AddNumber(std::to_string(SteamId) + ":" + std::to_string(EquippedAssetId), count);
        if (generation) file.AddSubkey("ownership_generations")
            .AddNumber(std::to_string(SteamId) + ":" + std::to_string(EquippedAssetId), *generation);
        return file.WriteToFile(B2GCommittedCountersPath);
    };
    // Start with a receipt from an unrelated lease/fence: it cannot be used.
    RECEIPT_CHECK(writeReceipt(1, 999, 41));
    ServerGC server;
    server.PostToGC(GCEvent::ClientConnected, SteamId, nullptr, 0);
    ObservedServerCache observed;
    RECEIPT_CHECK(observed.Apply(ServerBarrier(server)));
    RECEIPT_CHECK(observed.statTrakCounts.at(EquippedAssetId) == 4);
    RECEIPT_CHECK(writeReceipt(2, 5));
    server.PostToGC(GCEvent::RefreshOwnedInventory, 0, nullptr, 0);
    RECEIPT_CHECK(observed.Apply(ServerBarrier(server)));
    RECEIPT_CHECK(observed.statTrakCounts.at(EquippedAssetId) == 5);
    const auto messages = observed.countMessages;
    // The full inventory heartbeat can race an earlier committed receipt.
    RECEIPT_CHECK(WriteLivePolicy(2, 4, true));
    server.PostToGC(GCEvent::RefreshOwnedInventory, 0, nullptr, 0);
    RECEIPT_CHECK(observed.Apply(ServerBarrier(server)) && observed.countMessages == messages);
    RECEIPT_CHECK(writeReceipt(1, 999));
    server.PostToGC(GCEvent::RefreshOwnedInventory, 0, nullptr, 0);
    RECEIPT_CHECK(observed.Apply(ServerBarrier(server)) && observed.statTrakCounts.at(EquippedAssetId) == 5);
    // A round trip to this same Steam account advances ownership twice. An
    // old, higher-count receipt cannot override the new owner's reset.
    RECEIPT_CHECK(writeReceipt(3, 999));
    RECEIPT_CHECK(WriteLivePolicy(3, 0, true, true, "2099-01-01T00:00:00.000Z", 42, 2));
    ItemSchema schema;
    B2GServerOwnedSnapshot returned;
    std::string error;
    RECEIPT_CHECK(LoadB2GServerOwnedSnapshot(schema, returned, error));
    B2GCommittedCounters counters;
    RECEIPT_CHECK(LoadB2GCommittedCounters(returned, schema, counters) && counters.players.empty());
    RECEIPT_CHECK(writeReceipt(4, 1, 42, 2));
    RECEIPT_CHECK(LoadB2GCommittedCounters(returned, schema, counters)
        && counters.players.at(SteamId).at(EquippedAssetId) == 1);
    RECEIPT_CHECK(writeReceipt(5, 999, 42, 0));
    RECEIPT_CHECK(LoadB2GCommittedCounters(returned, schema, counters) && counters.players.empty());
    std::error_code ec;
    std::filesystem::remove(B2GCommittedCountersPath, ec);
    RECEIPT_CHECK(!ec);
    return true;
#undef RECEIPT_CHECK
}

static bool ServerHostEventsKeepTheFullRecipientIdentity()
{
    CounterTestTransport transport;
    NetworkingServer network{ &transport };
    const uint8_t ticket[] = { 1, 2, 3, 4 };
    network.ClientConnected(SteamId, ticket, sizeof(ticket));
    transport.recipients.clear();
    GCMessageWrite count{ k_EMsgNetworkStatTrakCount };
    count.WriteUint64(SteamId); count.WriteUint64(EquippedAssetId); count.WriteUint32(5);
    EventData event{ static_cast<int>(HostEvent::NetMessage), SteamId,
        std::vector<uint8_t>(static_cast<const uint8_t *>(count.Data()), static_cast<const uint8_t *>(count.Data()) + count.Size()) };
    network.SendMessage(event);
    return transport.recipients == std::vector<uint64_t>{ SteamId };
}

static bool OwnershipRoundTripResetsClientCounter()
{
#define OWNER_CHECK(value) do { if (!(value)) { std::fprintf(stderr, "Ownership counter failed at line %d\n", __LINE__); return false; } } while (false)
    OWNER_CHECK(WriteLivePolicy(1, 100));
    OWNER_CHECK(WriteLegacyLoadout());
    ItemSchema schema;
    Inventory inventory{ SteamId };
    OWNER_CHECK(inventory.GetItem(EquippedAssetId)->equipped_state_size() != 0);
    OWNER_CHECK(inventory.Save());
    const std::string loadoutPath = "csgo_gc/b2g_loadout_" + std::to_string(SteamId) + ".txt";
    KeyValue oldLoadout{ "b2g_loadout" };
    OWNER_CHECK(oldLoadout.ParseFromFileDetailed(loadoutPath.c_str()) == KeyValueFileResult::Success);
    CMsgSOSingleObject update;
    std::string error;
    OWNER_CHECK(inventory.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 101, update));
    // No intermediate absent snapshot: the gun can trade away and back while
    // this client is disconnected. The epoch alone must evict its high count.
    OWNER_CHECK(WriteLivePolicy(2, 0, false, true, "2099-01-01T00:00:00.000Z", 42, 2));
    OWNER_CHECK(!inventory.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 999, update));
    OWNER_CHECK(inventory.ReloadOwnedManifest(error));
    OWNER_CHECK(Counter(*inventory.GetItem(EquippedAssetId), schema) == 0);
    OWNER_CHECK(inventory.GetItem(EquippedAssetId)->equipped_state_size() == 0);
    OWNER_CHECK(!inventory.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 999, update, 1));
    OWNER_CHECK(inventory.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 1, update, 2));
    OWNER_CHECK(inventory.ReloadOwnedManifest(error));
    OWNER_CHECK(Counter(*inventory.GetItem(EquippedAssetId), schema) == 1);
    OWNER_CHECK(oldLoadout.WriteToFile(loadoutPath.c_str()));
    Inventory restart{ SteamId };
    OWNER_CHECK(restart.GetItem(EquippedAssetId)->equipped_state_size() == 0);
    OWNER_CHECK(restart.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 2, update, 2));
    OWNER_CHECK(!restart.ApplyAuthoritativeStatTrakCount(EquippedAssetId, 999, update));
    CounterTestTransport transport;
    NetworkingClient networking{ &transport };
    ClientGC gc{ SteamId };
    constexpr uint64_t serverId = 90000000000000001ull;
    const uint8_t ticket[]{ 1, 2, 3, 4 };
    networking.SetAuthTicket(1, ticket, sizeof(ticket));
    GCMessageWrite connect{ k_EMsgNetworkConnect };
    connect.WriteUint32(sizeof(ticket)); connect.WriteData(ticket, sizeof(ticket));
    transport.Enqueue(serverId, connect); networking.Update(&gc);
    ClientRefreshBarrier(gc);
    const auto send = [&](uint32_t count, std::optional<uint64_t> generation) {
        GCMessageWrite wire{ k_EMsgNetworkStatTrakCount };
        wire.WriteUint64(SteamId); wire.WriteUint64(EquippedAssetId); wire.WriteUint32(count);
        if (generation) wire.WriteUint64(*generation);
        transport.Enqueue(serverId, wire); networking.Update(&gc);
        return ClientRefreshBarrier(gc);
    };
    OWNER_CHECK(send(999, std::nullopt).empty());
    OWNER_CHECK(send(999, 1).empty());
    const auto events = send(2, 2);
    OWNER_CHECK(events.size() == 1);
    GCMessageRead read{ 0, events.front().buffer.data(), static_cast<uint32_t>(events.front().buffer.size()) };
    CSOEconItem item;
    OWNER_CHECK(read.TypeUnmasked() == k_ESOMsg_Update && read.ReadProtobuf(update)
        && item.ParseFromString(update.object_data()) && Counter(item, schema) == 2);
    OWNER_CHECK(send(900, 0).empty());
    return true;
#undef OWNER_CHECK
}

#ifdef _WIN32
static bool OwnedMedalRequiresLauncherReceiptAndSavedInventory()
{
#define MEDAL_CHECK(value) do { if (!(value)) { std::fprintf(stderr, "Owned medal failed at line %d\n", __LINE__); return false; } } while (false)
    // This target alone uses the process-specific test pipe. It cannot contact
    // an actual launcher or the user's running game.
    const auto name = L"\\\\.\\pipe\\B2G.Launcher.Tests." + std::to_wstring(GetCurrentProcessId());
    struct Pipe { HANDLE handle; ~Pipe() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); } } pipe{
        CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT, 1, 65536, 65536, 0, nullptr) };
    MEDAL_CHECK(pipe.handle != INVALID_HANDLE_VALUE && WriteSchema() && WriteManifest());
    ClientGC gc{ SteamId };
    struct Header { uint32_t magic; uint16_t version; uint16_t type; uint32_t size; };
    static_assert(sizeof(Header) == 12);
    const auto readFrame = [&](uint16_t type, void *payload, uint32_t size) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 3 };
        while (std::chrono::steady_clock::now() < deadline)
        {
            ConnectNamedPipe(pipe.handle, nullptr);
            DWORD available = 0;
            if (PeekNamedPipe(pipe.handle, nullptr, 0, nullptr, &available, nullptr)
                && available >= sizeof(Header) + size)
            {
                Header header{}; DWORD bytes = 0;
                return ReadFile(pipe.handle, &header, sizeof(header), &bytes, nullptr)
                    && bytes == sizeof(header) && header.magic == 0x31473242 && header.version == 1
                    && header.type == type && header.size == size
                    && ReadFile(pipe.handle, payload, size, &bytes, nullptr) && bytes == size;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds{ 1 });
        }
        return false;
    };
    uint64_t hello = 0;
    MEDAL_CHECK(readFrame(1, &hello, sizeof(hello)) && hello == SteamId);
    const uint32_t state[10]{ 10, 1, 40, 0 };
    gc.PostToGC(GCEvent::LauncherBridgeMessage, 101, state, sizeof(state));
    ClientRefreshBarrier(gc); // drain the level 40 update before requesting a preview
    const auto request = [&](uint32_t definition) {
        CMsgGCCStrike15_v2_Client2GCRequestPrestigeCoin message;
        if (definition) message.set_defindex(definition);
        GCMessageWrite wire{ k_EMsgGCCStrike15_v2_Client2GCRequestPrestigeCoin, message };
        gc.PostToGC(GCEvent::Message, wire.TypeMasked(), wire.Data(), wire.Size());
    };
    const auto complete = [&](const LauncherBridge::ServiceMedalResultWire &result) {
        Header header{ 0x31473242, 1, 110, sizeof(result) }; DWORD bytes = 0;
        return WriteFile(pipe.handle, &header, sizeof(header), &bytes, nullptr) && bytes == sizeof(header)
            && WriteFile(pipe.handle, &result, sizeof(result), &bytes, nullptr) && bytes == sizeof(result);
    };
    const auto response = [&](uint32_t definition, bool claimed, uint32_t failureReason = 0) {
        bool itemSeen = false, levelReset = false;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{ 3 };
        while (std::chrono::steady_clock::now() < deadline)
        {
            std::vector<EventData> events; gc.GetHostEvents(events);
            for (const auto &event : events)
            {
                if (event.type != static_cast<int>(HostEvent::Message)) continue;
                GCMessageRead read{ 0, event.buffer.data(), static_cast<uint32_t>(event.buffer.size()) };
                if (read.TypeUnmasked() == k_ESOMsg_Create)
                {
                    CMsgSOSingleObject object; CSOEconItem item;
                    if (!read.ReadProtobuf(object) || object.type_id() != SOTypeItem
                        || !item.ParseFromString(object.object_data()) || item.def_index() != 1331
                        || item.id() != RewardAssetId || item.origin() != ItemOriginLevelUpReward) return false;
                    itemSeen = true;
                }
                if (read.TypeUnmasked() == k_EMsgGCCStrike15_v2_MatchmakingGC2ClientHello)
                {
                    CMsgGCCStrike15_v2_MatchmakingGC2ClientHello profile;
                    if (!read.ReadProtobuf(profile) || profile.player_level() != 1 || profile.player_cur_xp() != 0) return false;
                    levelReset = true;
                }
                if (read.TypeUnmasked() == k_EMsgGCCStrike15_v2_Client2GCRequestPrestigeCoin)
                {
                    CMsgGCCStrike15_v2_Client2GCRequestPrestigeCoin reply;
                    return read.ReadProtobuf(reply) && reply.defindex() == definition
                        && reply.hours() == failureReason
                        && itemSeen == claimed && levelReset == claimed
                        && (claimed ? reply.upgradeid() == RewardAssetId && reply.prestigetime() != 0 : !reply.prestigetime());
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds{ 1 });
        }
        return false;
    };
    LauncherBridge::ServiceMedalRequestWire wire{};
    request(0);
    MEDAL_CHECK(readFrame(15, &wire, sizeof(wire)) && wire.requestId && !wire.definitionIndex);
    const LauncherBridge::ServiceMedalResultWire fullInventory{ wire.requestId, 0, 0, 0, 0, 0, 0, 0, 2 };
    MEDAL_CHECK(complete(fullInventory) && response(0, false, 2));
    request(0);
    MEDAL_CHECK(readFrame(15, &wire, sizeof(wire)) && wire.requestId && !wire.definitionIndex);
    LauncherBridge::ServiceMedalResultWire receipt{ wire.requestId, 0, 1331, 0, 40, 0, 1, 0, 0 };
    MEDAL_CHECK(complete(receipt) && response(1331, false));
    request(1331);
    MEDAL_CHECK(readFrame(15, &wire, sizeof(wire)) && wire.definitionIndex == 1331);
    receipt = { wire.requestId, RewardAssetId, 1331, 1788750000, 1, 0, 1, 1, 0 };
    // Even a matching receipt cannot mint an item absent from the saved API snapshot.
    MEDAL_CHECK(complete(receipt) && response(0, false));
    request(1331);
    MEDAL_CHECK(readFrame(15, &wire, sizeof(wire)) && wire.definitionIndex == 1331);
    receipt.requestId = wire.requestId;
    {
        KeyValue saved{ "manifest" };
        MEDAL_CHECK(saved.ParseFromFile(B2GOwnedManifestPath));
        auto &medal = saved.GetSubkey("players")->GetSubkey(std::to_string(SteamId))->GetSubkey("items")
            ->AddSubkey(std::to_string(RewardAssetId));
        medal.AddString("source", "b2g"); medal.AddString("item_kind", "cosmetic");
        medal.AddNumber("def_index", 1331); medal.AddNumber("inventory", InventoryUnacknowledged(UnacknowledgedLevelUpReward));
        medal.AddNumber("level", 1); medal.AddNumber("quality", 4); medal.AddNumber("rarity", 6);
        medal.AddNumber("flags", 0); medal.AddNumber("in_use", 0);
        medal.AddNumber("origin", ItemOriginLevelUpReward); medal.AddNumber("loadout_slot", 55);
        medal.AddSubkey("equipped_state").AddNumber("0", 55);
        MEDAL_CHECK(saved.WriteToFile(B2GOwnedManifestPath));
        // The API emits a present, empty attributes block for medals. The
        // generic KeyValue writer drops empty blocks, so preserve it explicitly.
        auto text = LoadFile(B2GOwnedManifestPath);
        const auto equipped = text.rfind("\"equipped_state\"");
        MEDAL_CHECK(equipped != std::string::npos);
        text.insert(equipped, "\"attributes\" {}\n\t\t\t\t");
        std::ofstream file{ B2GOwnedManifestPath, std::ios::binary | std::ios::trunc };
        file << text;
        MEDAL_CHECK(file.good());
    }
    {
        ItemSchema schema; B2GOwnedItems owned; std::string error;
        if (!LoadB2GOwnedItems(SteamId, schema, owned, error))
        { std::fprintf(stderr, "Medal fixture rejected: %s\n", error.c_str()); return false; }
        MEDAL_CHECK(owned.count(RewardAssetId) == 1);
        MEDAL_CHECK(HasValidB2GEquippedState(owned.at(RewardAssetId).item, owned.at(RewardAssetId)));
        auto forged = owned.at(EquippedAssetId).item;
        forged.mutable_equipped_state(0)->set_new_class(0);
        MEDAL_CHECK(!HasValidB2GEquippedState(forged, owned.at(EquippedAssetId)));
    }
    MEDAL_CHECK(complete(receipt) && response(1331, true));
    // A repeated receipt produces no extra SO award or profile reset.
    gc.PostToGC(GCEvent::LauncherBridgeMessage, 110, &receipt, sizeof(receipt));
    MEDAL_CHECK(ClientRefreshBarrier(gc).empty());
    // The next claim is rejected at the newly reset level, before any API request.
    request(1331);
    MEDAL_CHECK(response(0, false));
    {
        Inventory inventory{ SteamId }; CMsgSOMultipleObjects update;
        MEDAL_CHECK(inventory.EquipItem(RewardAssetId, 0, 55, false, update));
        MEDAL_CHECK(!inventory.EquipItem(EquippedAssetId, 0, LoadoutSlot, false, update));
        MEDAL_CHECK(EquippedSlotForClass(*inventory.GetItem(RewardAssetId), 0) == 55);
    }
    {
        Inventory reloaded{ SteamId };
        MEDAL_CHECK(EquippedSlotForClass(*reloaded.GetItem(RewardAssetId), 0) == 55);
    }
    return true;
#undef MEDAL_CHECK
}
#endif

static bool RestoredLoadoutResolvesTeamAndSlotConflicts()
{
#define RESTORE_CHECK(value) do { if (!(value)) { std::fprintf(stderr, "Restored loadout failed at line %d\n", __LINE__); return false; } } while (false)
    RESTORE_CHECK(WriteSchema());
    KeyValue schema{ "schema" };
    RESTORE_CHECK(schema.ParseFromFile("csgo/scripts/items/items_game.txt"));
    auto *definitions = schema.GetSubkey("items_game")->GetSubkey("items");
    definitions->GetSubkey("7")->AddSubkey("used_by_classes").AddNumber("terrorists", 1);
    auto &m4 = definitions->AddSubkey("60");
    m4.AddString("name", "weapon_m4a1_silencer");
    m4.AddString("prefab", "ct_weapon");
    schema.GetSubkey("items_game")->AddSubkey("prefabs").AddSubkey("ct_weapon")
        .AddSubkey("used_by_classes").AddNumber("counter-terrorists", 1);
    definitions = schema.GetSubkey("items_game")->GetSubkey("items");
    definitions->AddSubkey("508").AddString("name", "weapon_knife_m9_bayonet");
    definitions->AddSubkey("523").AddString("name", "weapon_knife_widowmaker");
    definitions->AddSubkey("9").AddString("name", "weapon_awp");
    RESTORE_CHECK(schema.WriteToFile("csgo/scripts/items/items_game.txt"));
    RESTORE_CHECK(WriteLivePolicy(10, 4, false, true));
    KeyValue manifest{ "manifest" };
    RESTORE_CHECK(manifest.ParseFromFile(B2GOwnedManifestPath));
    auto *items = manifest.GetSubkey("players")->GetSubkey(std::to_string(SteamId))->GetSubkey("items");
    const uint64_t ak = EquippedAssetId, m4Id = UnequippedAssetId;
    const uint64_t olderKnife = StaleAssetId, newerKnife = StaleAssetId + 1, awp = StaleAssetId + 2;
    for (const auto [id, definition, slot] : {
        std::tuple{ m4Id, 60u, 15u }, { olderKnife, 508u, 0u },
        { newerKnife, 523u, 0u }, { awp, 9u, 18u } })
    {
        AddManifestItem(*items, id, 2);
        auto *item = items->GetSubkey(std::to_string(id));
        item->SetString("def_index", std::to_string(definition));
        item->SetString("loadout_slot", std::to_string(slot));
        item->GetSubkey("equipped_state")->SetString("2", std::to_string(slot));
        item->GetSubkey("equipped_state")->AddNumber("3", slot);
    }
    RESTORE_CHECK(manifest.WriteToFile(B2GOwnedManifestPath));
    const auto loadoutPath = "csgo_gc/b2g_loadout_" + std::to_string(SteamId) + ".txt";
    // Fresh installs use the web's weapon-level preferences, historically
    // expanded to both teams even for AK/M4 and competing knife definitions.
    TestFilesystem::RemoveFile(loadoutPath.c_str());
    {
        ItemSchema authoritySchema;
        B2GOwnedItems owned;
        std::string error;
        RESTORE_CHECK(LoadB2GOwnedItems(SteamId, authoritySchema, owned, error));
        CMsgSOCacheSubscribed broken, reply;
        broken.mutable_owner_soid()->set_type(SoIdTypeSteamId);
        broken.mutable_owner_soid()->set_id(SteamId);
        broken.set_version(1);
        auto *objects = broken.add_objects(); objects->set_type_id(SOTypeItem);
        for (const auto &[id, item] : owned) objects->add_object_data(item.item.SerializeAsString());
        ServerGC practice{ SteamId };
        ServerBarrier(practice);
        RESTORE_CHECK(!ServerReply(practice, SteamId, k_ESOMsg_CacheSubscribed, broken, reply));
    }
    const auto verify = [&](Inventory &inventory) {
        return EquippedSlotForClass(*inventory.GetItem(ak), 2) == 15
            && EquippedSlotForClass(*inventory.GetItem(ak), 3) == -1
            && EquippedSlotForClass(*inventory.GetItem(m4Id), 2) == -1
            && EquippedSlotForClass(*inventory.GetItem(m4Id), 3) == 15
            && inventory.GetItem(olderKnife)->equipped_state_size() == 0
            && EquippedSlotForClass(*inventory.GetItem(newerKnife), 2) == 0
            && EquippedSlotForClass(*inventory.GetItem(newerKnife), 3) == 0
            && EquippedSlotForClass(*inventory.GetItem(awp), 2) == 18
            && EquippedSlotForClass(*inventory.GetItem(awp), 3) == 18;
    };
    {
        Inventory inventory{ SteamId };
        RESTORE_CHECK(verify(inventory));
        CMsgSOCacheSubscribed request, reply;
        inventory.BuildCacheSubscription(request, true);
        ServerGC practice{ SteamId }, dedicated;
        ServerBarrier(practice);
        dedicated.PostToGC(GCEvent::ClientConnected, SteamId, nullptr, 0);
        ServerBarrier(dedicated);
        RESTORE_CHECK(ServerReply(practice, SteamId, k_ESOMsg_CacheSubscribed, request, reply));
        RESTORE_CHECK(reply.objects_size() == 1 && reply.objects(0).object_data_size() == 4);
        RESTORE_CHECK(ServerReply(dedicated, SteamId, k_ESOMsg_CacheSubscribed, request, reply));
        RESTORE_CHECK(reply.objects_size() == 1 && reply.objects(0).object_data_size() == 4);
        CMsgSOMultipleObjects update;
        RESTORE_CHECK(!inventory.EquipItem(ak, 3, 15, false, update));
        RESTORE_CHECK(update.objects_modified_size() == 0 && verify(inventory));
    }
    // Existing installations can have the same invalid state saved locally.
    KeyValue saved{ "loadout" };
    saved.AddNumber("format_version", 1);
    auto &savedItems = saved.AddSubkey("items");
    for (const auto &item : *items) {
        auto &states = savedItems.AddSubkey(item.Name()).AddSubkey("equipped_state");
        for (const auto &state : *item.GetSubkey("equipped_state")) states.AddString(state.Name(), state.String());
    }
    RESTORE_CHECK(saved.WriteToFile(loadoutPath.c_str()));
    {
        Inventory restored{ SteamId };
        RESTORE_CHECK(verify(restored));
        std::string error;
        RESTORE_CHECK(restored.ReloadOwnedManifest(error) && verify(restored));
        CMsgSOMultipleObjects update;
        RESTORE_CHECK(restored.EquipItem(olderKnife, 2, 0, false, update));
    }
    Inventory restarted{ SteamId };
    RESTORE_CHECK(EquippedSlotForClass(*restarted.GetItem(olderKnife), 2) == 0);
    RESTORE_CHECK(EquippedSlotForClass(*restarted.GetItem(newerKnife), 2) == -1);
    RESTORE_CHECK(EquippedSlotForClass(*restarted.GetItem(newerKnife), 3) == 0);
    return true;
#undef RESTORE_CHECK
}

// Run only in a copied fixture directory: Inventory persists its local loadout.
static int CheckCopiedLoadout()
{
    ItemSchema schema;
    B2GOwnedItems owned;
    std::string error;
    if (!LoadB2GOwnedItems(SteamId, schema, owned, error)) return 1;
    CMsgSOCacheSubscribed raw, rawReply;
    raw.mutable_owner_soid()->set_type(SoIdTypeSteamId);
    raw.mutable_owner_soid()->set_id(SteamId);
    raw.set_version(1);
    auto *objects = raw.add_objects(); objects->set_type_id(SOTypeItem);
    for (const auto &[id, item] : owned)
        if (item.item.equipped_state_size()) objects->add_object_data(item.item.SerializeAsString());
    ServerGC rawServer{ SteamId };
    ServerBarrier(rawServer);
    const bool rawAccepted = ServerReply(rawServer, SteamId, k_ESOMsg_CacheSubscribed, raw, rawReply);
    Inventory inventory{ SteamId };
    CMsgSOCacheSubscribed request, reply;
    inventory.BuildCacheSubscription(request, true);
    ServerGC practice{ SteamId }, server;
    ServerBarrier(practice);
    ServerBarrier(server);
    const bool practiceAccepted = ServerReply(practice, SteamId, k_ESOMsg_CacheSubscribed, request, reply);
    const bool serverAccepted = ServerReply(server, SteamId, k_ESOMsg_CacheSubscribed, request, reply);
    int equipped = 0;
    for (const auto &type : request.objects())
        if (type.type_id() == SOTypeItem) equipped += type.object_data_size();
    std::printf("Copied loadout: owned=%zu manifestEquipped=%d rawAccepted=%d repairedEquipped=%d practiceAccepted=%d serverAccepted=%d\n",
        owned.size(), objects->object_data_size(), rawAccepted, equipped, practiceAccepted, serverAccepted);
    return equipped > 0 && practiceAccepted && serverAccepted ? 0 : 1;
}

int main(int argc, char **argv)
{
    if (argc == 2 && std::string_view{ argv[1] } == "--check-copied-loadout") return CheckCopiedLoadout();
    if (!ReconcilesLegacyEmptyAndStaleEntries()) return 1;
    if (!CaseRewardRemainsNewUntilAcknowledged(false)) return 2;
    if (!CaseRewardRemainsNewUntilAcknowledged(true)) return 3;
    if (!ServerAcceptsAcknowledgedOwnedItemWithoutTrustingItsMetadata()) return 4;
    if (!LiveServerInventoryRefresh()) return 5;
    if (!LiveSprayAndEscapedNameRefresh()) return 6;
    if (!LiveStatTrakClientUpdatesAreNarrowAndIdempotent()) return 7;
    if (!PeriodicInventoryRefreshEmitsOnlyDeltas()) return 8;
    if (!LocalPracticeKeepsOwnedSkinsWithoutDedicatedFallback()) return 9;
    if (!CommittedCountersAreFencedAndSurviveStaleSnapshots()) return 10;
    if (!ServerHostEventsKeepTheFullRecipientIdentity()) return 11;
    if (!OwnershipRoundTripResetsClientCounter()) return 13;
#ifdef _WIN32
    if (!OwnedMedalRequiresLauncherReceiptAndSavedInventory()) return 12;
#endif
    if (!RestoredLoadoutResolvesTeamAndSlotConflicts()) return 14;
    return 0;
}
