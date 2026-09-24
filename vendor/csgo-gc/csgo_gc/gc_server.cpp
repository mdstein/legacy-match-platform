#include "stdafx.h"
#include "gc_server.h"
#include "config.h"
#include "gc_const.h"
#include "gc_const_csgo.h"
#include "graffiti.h"
#include "networking_shared.h"
#include "owned_inventory.h"

// yuck!! needed for CSteamID (construct full id from account id)
#include "steam/steamclientpublic.h"

ServerGC::ServerGC(uint64_t localPracticeSteamId)
    : m_localPracticeSteamId{ localPracticeSteamId }
{
    // also called from ClientGC's constructor
    Graffiti::Initialize();

    StartThread(true);

    Platform::Print("ServerGC spawned\n");
}

ServerGC::~ServerGC()
{
    StopThread();
    Platform::Print("ServerGC destroyed\n");
}

bool ServerGC::RoundMVPMusicKitCountForUserId(int userId, int &musickitmvps) const
{
    std::lock_guard<std::mutex> lock{ m_musicKitMVPStateMutex };

    auto it = m_musicKitMVPStateByUserId.find(userId);
    if (it == m_musicKitMVPStateByUserId.end() || !it->second.hasEquippedStatTrakMusicKit)
    {
        return false;
    }

    musickitmvps = static_cast<int>(it->second.currentMVPs + 1);
    return true;
}

void ServerGC::HandleEvent(GCEvent type, uint64_t id, const std::vector<uint8_t> &buffer)
{
    switch (type)
    {
    case GCEvent::Message:
        HandleMessage(static_cast<uint32_t>(id), buffer.data(), static_cast<uint32_t>(buffer.size()));
        break;

    case GCEvent::NetMessage:
        HandleNetMessage(id, buffer.data(), static_cast<uint32_t>(buffer.size()));
        break;

    case GCEvent::ClientSOCacheUnsubscribe:
        HandleClientSOCacheUnsubscribe(id);
        break;

    case GCEvent::ClientConnected:
        if (GetConfig().OwnedOnly())
        {
            if (m_localPracticeSteamId)
            {
                if (id == m_localPracticeSteamId)
                    Platform::Print("B2G practice inventory enabled for local owner %llu\n", id);
                break;
            }
            m_managedConnections = true;
            // BeginAuthSession repeats must not reset a live cache's version.
            if (m_ownedClients.contains(id) || m_ownedClients.size() >= 16) break;
            m_ownedClients.emplace(id, OwnedClient{});
            RefreshOwnedInventory(true);
        }
        break;

    case GCEvent::RefreshOwnedInventory:
        RefreshOwnedInventory(true);
        break;

    default:
        Platform::Print("ServerGC::HandleEvent: unknown event type %d\n", static_cast<int>(type));
        break;
    }
}

void ServerGC::HandleMessage(uint32_t type, const void *data, uint32_t size)
{
    GCMessageRead messageRead{ type, data, size };
    if (!messageRead.IsValid())
    {
        Platform::Print("ServerGC::HandleMessage: invalid message\n");
        return;
    }

    if (messageRead.IsProtobuf())
    {
        switch (messageRead.TypeUnmasked())
        {
        case k_EMsgGCServerHello:
            SendServerWelcome();
            break;

        case k_EMsgGCCStrike15_v2_Server2GCClientValidate:
            // server doesn't want a response so ignore
            break;

        case k_EMsgGC_IncrementKillCountAttribute:
            // This message originates inside the authoritative game-server
            // process after a real kill. Owned-only mode restricts untrusted
            // client network messages in HandleNetMessage; it must not discard
            // the server engine's own StatTrak notification here.
            IncrementKillCountAttribute(messageRead);
            break;

        default:
            Platform::Print("ServerGC::HandleMessage: unhandled protobuf message %s)\n",
                MessageName(messageRead.TypeUnmasked()));
            break;
        }
    }
}

void ServerGC::HandleClientSOCacheUnsubscribe(uint64_t steamId)
{
    m_ownedClients.erase(steamId);
    Platform::Print("HandleClientSOCacheUnsubscribe: %llu\n", steamId);

    {
        std::lock_guard<std::mutex> lock{ m_musicKitMVPStateMutex };
        auto stateIt = m_musicKitMVPStateBySteamId.find(steamId);
        if (stateIt != m_musicKitMVPStateBySteamId.end())
        {
            m_musicKitMVPStateByUserId.erase(stateIt->second.userId);
            m_musicKitMVPStateBySteamId.erase(stateIt);
        }
    }

    CMsgSOCacheUnsubscribed message;
    message.mutable_owner_soid()->set_type(SoIdTypeSteamId);
    message.mutable_owner_soid()->set_id(steamId);

    GCMessageWrite write{ k_ESOMsg_CacheUnsubscribed, message };
    PostToHost(HostEvent::Message, write.TypeMasked(), write.Data(), write.Size());
}

template<typename T>
static bool ValidateMessageOwnerSOID(GCMessageRead &messageRead, uint64_t steamId, std::optional<GCMessageWrite> &)
{
    T message;
    if (!messageRead.ReadProtobuf(message))
    {
        Platform::Print("ValidateMessageOwnerSOID %llu: parsing failed\n", steamId);
        return false;
    }

    if (message.owner_soid().type() != SoIdTypeSteamId
        || message.owner_soid().id() != steamId)
    {
        Platform::Print("ValidateMessageOwnerSOID %llu: steam id mismatch (message has %llu)\n",
            steamId, message.owner_soid().id());
        return false;
    }

    return true;
}

// FIXME: made up
constexpr int MaxServerSOCacheItems = 64;

static bool ValidateOwner(const CMsgSOIDOwner &owner, uint64_t steamId)
{
    return owner.type() == SoIdTypeSteamId && owner.id() == steamId;
}

static bool TrackOwnedEquipSlots(const CSOEconItem &item,
    std::set<std::pair<uint32_t, uint32_t>> &occupied)
{
    for (const CSOEconItemEquipped &equipped : item.equipped_state())
    {
        if (!occupied.emplace(equipped.new_class(), equipped.new_slot()).second)
        {
            return false;
        }
    }
    return true;
}

static bool ValidateOwnedItemData(std::string_view data, const B2GOwnedItems &owned,
    CSOEconItem &item, bool liveAuthority = false)
{
    if (!item.ParseFromArray(data.data(), static_cast<int>(data.size())))
    {
        return false;
    }
    const auto expected = owned.find(item.id());
    if (expected == owned.end())
    {
        return false;
    }
    // Acknowledging a reward changes its client inventory position/New flag.
    // The match's trusted snapshot can predate that UI operation. This field
    // has no server loadout meaning, so discard it in favor of the snapshot;
    // static item fields remain exact and
    // equip slots still pass the owned-item validator. Never forward the raw
    // candidate after normalization.
    if (expected->second.item.has_inventory())
    {
        item.set_inventory(expected->second.item.inventory());
    }
    else
    {
        item.clear_inventory();
    }
    if (liveAuthority)
    {
        // A client may lag the server's counter/name/spray revision. These are
        // display values, never client authority: overwrite from the policy.
        // Attribute shape stays exact (no adding StatTrak to a normal item).
        const auto &trusted = expected->second.item;
        if (trusted.has_custom_name()) item.set_custom_name(trusted.custom_name());
        else item.clear_custom_name();
        for (auto &attribute : *item.mutable_attribute())
        {
            if (attribute.def_index() != 80
                && attribute.def_index() != ItemSchema::AttributeSpraysRemaining) continue;
            for (const auto &authoritative : trusted.attribute())
            {
                if (attribute.def_index() == authoritative.def_index())
                    attribute = authoritative;
            }
        }
    }
    return IsExactB2GOwnedItem(item, expected->second);
}

static bool SanitizeOwnedCache(GCMessageRead &messageRead, uint64_t steamId,
    const ItemSchema &schema, std::optional<GCMessageWrite> &sanitized,
    const B2GOwnedItems *authority = nullptr)
{
    CMsgSOCacheSubscribed input;
    if (!messageRead.ReadProtobuf(input) || !input.has_owner_soid()
        || !ValidateOwner(input.owner_soid(), steamId))
    {
        return false;
    }
    B2GOwnedItems owned;
    std::string error;
    if (!authority && !LoadB2GOwnedItems(steamId, schema, owned, error))
    {
        Platform::Print("B2G rejected SOCache from %llu: %s\n", steamId, error.c_str());
        return false;
    }

    CMsgSOCacheSubscribed output;
    output.set_version(input.version());
    *output.mutable_owner_soid() = input.owner_soid();
    auto *items = output.add_objects();
    items->set_type_id(SOTypeItem);
    std::set<std::pair<uint32_t, uint32_t>> occupied;
    size_t count = 0;
    for (const auto &type : input.objects())
    {
        if (type.type_id() != SOTypeItem)
        {
            continue;
        }
        for (const std::string &data : type.object_data())
        {
            CSOEconItem item;
            if (!ValidateOwnedItemData(data, authority ? *authority : owned, item, authority != nullptr))
            {
                Platform::Print("B2G rejected fabricated SOCache item from %llu\n", steamId);
                return false;
            }
            if (!item.equipped_state_size())
            {
                continue;
            }
            if (++count > MaxServerSOCacheItems || !TrackOwnedEquipSlots(item, occupied))
            {
                Platform::Print("B2G rejected conflicting owned loadout from %llu\n", steamId);
                return false;
            }
            items->add_object_data(item.SerializeAsString());
        }
    }
    sanitized.emplace(k_ESOMsg_CacheSubscribed, output);
    return true;
}

static bool SanitizeOwnedUpdateMultiple(GCMessageRead &messageRead, uint64_t steamId,
    const ItemSchema &schema, std::optional<GCMessageWrite> &sanitized,
    const B2GOwnedItems *authority = nullptr)
{
    CMsgSOMultipleObjects input;
    if (!messageRead.ReadProtobuf(input) || !input.has_owner_soid()
        || !ValidateOwner(input.owner_soid(), steamId))
    {
        return false;
    }
    B2GOwnedItems owned;
    std::string error;
    if (!authority && !LoadB2GOwnedItems(steamId, schema, owned, error))
    {
        Platform::Print("B2G rejected loadout update from %llu: %s\n", steamId, error.c_str());
        return false;
    }

    CMsgSOMultipleObjects output;
    output.set_version(input.version());
    *output.mutable_owner_soid() = input.owner_soid();
    std::set<std::pair<uint32_t, uint32_t>> occupied;
    for (const auto &object : input.objects_modified())
    {
        // Stock/default loadout objects do not create inventory and are not
        // needed by the game server. Discard them at the trust boundary.
        if (object.type_id() == SOTypeDefaultEquippedDefinitionInstanceClient)
        {
            continue;
        }
        if (object.type_id() != SOTypeItem)
        {
            return false;
        }
        CSOEconItem item;
        if (!ValidateOwnedItemData(object.object_data(), authority ? *authority : owned, item, authority != nullptr)
            || !TrackOwnedEquipSlots(item, occupied))
        {
            Platform::Print("B2G rejected mutated loadout item from %llu\n", steamId);
            return false;
        }
        auto *accepted = output.add_objects_modified();
        accepted->set_type_id(SOTypeItem);
        accepted->set_object_data(item.SerializeAsString());
    }
    if (!output.objects_modified_size())
    {
        return false;
    }
    sanitized.emplace(k_ESOMsg_UpdateMultiple, output);
    return true;
}

static bool SanitizeOwnedUpdate(GCMessageRead &messageRead, uint64_t steamId,
    const ItemSchema &schema, std::optional<GCMessageWrite> &sanitized,
    const B2GOwnedItems *authority = nullptr)
{
    CMsgSOSingleObject input;
    if (!messageRead.ReadProtobuf(input) || !input.has_owner_soid()
        || !ValidateOwner(input.owner_soid(), steamId) || input.type_id() != SOTypeItem)
    {
        return false;
    }
    B2GOwnedItems owned;
    std::string error;
    if (!authority && !LoadB2GOwnedItems(steamId, schema, owned, error))
    {
        return false;
    }
    CSOEconItem item;
    if (!ValidateOwnedItemData(input.object_data(), authority ? *authority : owned, item, authority != nullptr))
    {
        return false;
    }
    input.set_object_data(item.SerializeAsString());
    sanitized.emplace(k_ESOMsg_Update, input);
    return true;
}

static bool RemoveUnequippedItems(CMsgSOCacheSubscribed &message, int &itemCount)
{
    bool modified = false;

    for (auto it = message.mutable_objects()->begin(); it != message.mutable_objects()->end(); it++)
    {
        if (it->type_id() != SOTypeItem)
        {
            continue;
        }

        for (auto obj = it->mutable_object_data()->begin(); obj != it->mutable_object_data()->end(); )
        {
            CSOEconItem item;
            if (!item.ParseFromString(*obj) || !item.equipped_state_size())
            {
                obj = it->mutable_object_data()->erase(obj);
                modified = true;
            }
            else
            {
                obj++;
                itemCount++;
            }
        }
    }

    return modified;
}

template<>
bool ValidateMessageOwnerSOID<CMsgSOCacheSubscribed>(GCMessageRead &messageRead, uint64_t steamId, std::optional<GCMessageWrite> &sanitized)
{
    CMsgSOCacheSubscribed message;
    if (!messageRead.ReadProtobuf(message))
    {
        Platform::Print("ValidateMessageOwnerSOID %llu: parsing failed\n", steamId);
        return false;
    }

    if (message.owner_soid().type() != SoIdTypeSteamId
        || message.owner_soid().id() != steamId)
    {
        Platform::Print("ValidateMessageOwnerSOID %llu: steam id mismatch (message has %llu)\n",
            steamId, message.owner_soid().id());
        return false;
    }

    size_t oldSize = message.ByteSizeLong();

    int itemCount = 0;
    bool modified = RemoveUnequippedItems(message, itemCount);

    if (itemCount > MaxServerSOCacheItems)
    {
        Platform::Print("Client %llu socache has %d items (max allowed %d), ignoring\n", itemCount, MaxServerSOCacheItems);
        return false;
    }

    if (modified)
    {
        Platform::Print("SOCache from %llu had to be cleaned up (%zu -> %zu bytes)\n", steamId, oldSize, message.ByteSizeLong());
        sanitized.emplace(k_ESOMsg_CacheSubscribed, message);
    }

    return true;
}

void ServerGC::HandleNetMessage(uint64_t steamId, const void *data, uint32_t size)
{
    RefreshOwnedInventory();
    const B2GOwnedItems *authority = nullptr;
    B2GOwnedItems localOwned;
    if (GetConfig().OwnedOnly() && m_localPracticeSteamId)
    {
        // A listen server has the launcher's paired inventory, not a leased
        // dedicated-server manifest. Scope this path to its own local account;
        // remote players must never obtain an unversioned-policy fallback.
        std::string error;
        if (steamId != m_localPracticeSteamId
            || !LoadB2GOwnedItems(steamId, m_itemSchema, localOwned, error)) return;
        authority = &localOwned;
    }
    if (GetConfig().OwnedOnly() && m_managedConnections)
    {
        authority = CurrentOwnedItems(steamId);
        if (!authority) return; // no fallback to an unversioned/expired file
    }
    Platform::Print("HandleNetMessage: %llu, %u bytes\n", steamId, size);

    GCMessageRead validate{ 0, data, size };
    if (!validate.IsValid())
    {
        assert(false);
        return;
    }

    if (!validate.IsProtobuf())
    {
        if (!GetConfig().OwnedOnly()
            && validate.TypeUnmasked() == k_EMsgNetworkMusicKitMVPState)
        {
            UpdateMusicKitMVPState(steamId, validate);
            return;
        }

        Platform::Print("ServerGC: ignoring non protobuf message %u from %llu\n",
            validate.TypeUnmasked(), steamId);
        return;
    }

    // validate the type and contents
    bool isValid = false;
    std::optional<GCMessageWrite> sanitized;

    switch (validate.TypeUnmasked())
    {
    case k_ESOMsg_Create:
    case k_ESOMsg_Destroy:
        isValid = !GetConfig().OwnedOnly()
            && ValidateMessageOwnerSOID<CMsgSOSingleObject>(validate, steamId, sanitized);
        break;

    case k_ESOMsg_Update:
        isValid = GetConfig().OwnedOnly()
            ? SanitizeOwnedUpdate(validate, steamId, m_itemSchema, sanitized, authority)
            : ValidateMessageOwnerSOID<CMsgSOSingleObject>(validate, steamId, sanitized);
        break;

    case k_ESOMsg_CacheSubscribed:
        isValid = GetConfig().OwnedOnly()
            ? SanitizeOwnedCache(validate, steamId, m_itemSchema, sanitized, authority)
            : ValidateMessageOwnerSOID<CMsgSOCacheSubscribed>(validate, steamId, sanitized);
        break;

    case k_ESOMsg_UpdateMultiple:
        isValid = GetConfig().OwnedOnly()
            ? SanitizeOwnedUpdateMultiple(validate, steamId, m_itemSchema, sanitized, authority)
            : ValidateMessageOwnerSOID<CMsgSOMultipleObjects>(validate, steamId, sanitized);
        break;

    case k_EMsgGCItemAcknowledged:
        isValid = !GetConfig().OwnedOnly();
        break;
    }

    if (!isValid)
    {
        if (m_managedConnections && authority) RequestOwnedLoadout(steamId);
        Platform::Print("ServerGC: ignoring net message %u from %llu\n",
            validate.TypeUnmasked(), steamId);
        return;
    }

    if (!m_sentWelcome)
    {
        // FIXME: ideally we'd sent this on steam logon, instead of on demand...
        Platform::Print("Sending server welcome due to net message\n");
        SendServerWelcome();
    }

    if (sanitized.has_value())
    {
        if (m_managedConnections && authority)
        {
            if (!PublishOwnedLoadout(steamId, *sanitized)) RequestOwnedLoadout(steamId);
            return;
        }
        // pass the sanitized message
        PostToHost(HostEvent::Message, sanitized->TypeMasked(), sanitized->Data(), sanitized->Size());
    }
    else
    {
        // otherwise the old message was fine
        PostToHost(HostEvent::Message, validate.TypeMasked(), data, size);
    }
}

namespace
{
std::string OwnedLeaseKey(const B2GServerOwnedSnapshot &policy)
{
    return policy.matchId + "/" + policy.leaseId + "/" + std::to_string(policy.fencingToken);
}

bool SameOwnedItems(const B2GOwnedItems &left, const B2GOwnedItems &right)
{
    if (left.size() != right.size()) return false;
    for (const auto &[id, item] : left)
    {
        const auto found = right.find(id);
        if (found == right.end() || item.loadoutSlot != found->second.loadoutSlot
            || item.ownershipGeneration != found->second.ownershipGeneration
            || item.item.SerializeAsString() != found->second.item.SerializeAsString()) return false;
    }
    return true;
}
}

void ServerGC::HandlePeriodicWork()
{
    RefreshOwnedInventory();
}

const B2GOwnedItems *ServerGC::CurrentOwnedItems(uint64_t steamId) const
{
    const auto client = m_ownedClients.find(steamId);
    if (!m_ownedPolicy || client == m_ownedClients.end() || client->second.revoked
        || client->second.leaseKey != OwnedLeaseKey(*m_ownedPolicy)
        || m_ownedPolicy->expiresAt <= std::chrono::system_clock::now()) return nullptr;
    const auto player = m_ownedPolicy->players.find(steamId);
    return player == m_ownedPolicy->players.end() ? nullptr : &player->second;
}

void ServerGC::RequestOwnedLoadout(uint64_t steamId)
{
    const auto client = m_ownedClients.find(steamId);
    const auto now = std::chrono::steady_clock::now();
    if (client == m_ownedClients.end() || !CurrentOwnedItems(steamId)) return;
    client->second.loadoutRequested = true;
    if (now - client->second.lastRequest < std::chrono::seconds{ 2 }) return;
    client->second.lastRequest = now;
    GCMessageWrite request{ k_EMsgNetworkRequestSOCache };
    PostToHost(HostEvent::NetMessage, steamId, request.Data(), request.Size());
}

void ServerGC::RefreshOwnedInventory(bool force)
{
    if (!GetConfig().OwnedOnly() || m_localPracticeSteamId) return;
    const auto now = std::chrono::steady_clock::now();
    if (!force && now - m_lastPolicyPoll < std::chrono::milliseconds{ 100 }) return;
    m_lastPolicyPoll = now;
    std::unordered_set<uint64_t> changedPlayers;
    bool policyChanged = false;
    std::error_code ec;
    const auto modified = std::filesystem::last_write_time(B2GOwnedManifestPath, ec);
    if (!ec && (force || !m_policyWriteTime || modified != *m_policyWriteTime))
    {
        B2GServerOwnedSnapshot next;
        std::string error;
        if (LoadB2GServerOwnedSnapshot(m_itemSchema, next, error))
        {
            const bool sameLease = m_ownedPolicy && next.SameLease(*m_ownedPolicy);
            const bool newer = !m_ownedPolicy
                || (sameLease && next.revision > m_ownedPolicy->revision)
                || (!sameLease && next.fencingToken > m_ownedPolicy->fencingToken);
            if (newer)
            {
                policyChanged = true;
                if (!sameLease) { m_counterSequence = 0; m_counterWriteTime.reset(); }
                for (const auto &[id, items] : next.players)
                {
                    if (!sameLease || !m_ownedPolicy->players.contains(id)
                        || !SameOwnedItems(items, m_ownedPolicy->players.at(id))) changedPlayers.insert(id);
                }
                m_ownedPolicy = std::move(next);
                Platform::Print("B2G server inventory policy activated revision=%llu players=%zu\n",
                    m_ownedPolicy->revision, m_ownedPolicy->players.size());
            }
            else if (!sameLease || next.revision != m_ownedPolicy->revision
                || next.digest != m_ownedPolicy->digest)
            {
                Platform::Print("B2G ignored stale/conflicting server inventory policy\n");
            }
            m_policyWriteTime = modified;
        }
        // A transient read/rename failure retains the last verified policy
        // only until its original expiry. It can never extend the lease.
    }
    if (!m_ownedPolicy) return;
    const auto loadoutChanges = changedPlayers;
    RefreshCommittedCounters(changedPlayers, force || policyChanged);
    for (auto &[id, client] : m_ownedClients)
    {
        if (client.leaseKey.empty() && m_ownedPolicy->players.contains(id))
        {
            client.leaseKey = OwnedLeaseKey(*m_ownedPolicy);
            changedPlayers.insert(id);
        }
        if (!client.leaseKey.empty() && (client.leaseKey != OwnedLeaseKey(*m_ownedPolicy)
            || m_ownedPolicy->expiresAt <= std::chrono::system_clock::now())) client.revoked = true;
        const auto *owned = CurrentOwnedItems(id);
        if (!owned)
        {
            if (!client.published.empty()) PublishOwnedItems(id, {});
            continue;
        }
        // Cheap file metadata checks can run promptly without repeatedly
        // cloning/serializing an unchanged inventory on every worker wake.
        if (client.initialized && !changedPlayers.contains(id) && !client.loadoutRequested) continue;
        auto next = client.published;
        for (auto it = next.begin(); it != next.end();)
        {
            const auto trusted = owned->find(it->first);
            if (trusted == owned->end())
            {
                it = next.erase(it);
                continue;
            }
            // API's equipped boolean is not a team loadout. Preserve the
            // accepted client's actual class/slot, never assign both teams.
            auto item = trusted->second.item;
            item.clear_equipped_state();
            if (HasValidB2GEquippedState(it->second, trusted->second))
                *item.mutable_equipped_state() = it->second.equipped_state();
            it->second = std::move(item);
            ++it;
        }
        if (client.initialized) PublishOwnedItems(id, std::move(next));
        // The signed policy reflects per-kill DB commits, including DM bot
        // kills. Send absolute values, never additive engine events: retries,
        // reconnects and policy refreshes must not double-count a kill.
        for (const auto &[assetId, item] : *owned)
        {
            const auto count = B2GWeaponStatTrakCount(item, m_itemSchema);
            if (!count) continue;
            const auto previous = client.statTrakCounts.find(assetId);
            const auto state = std::make_pair(item.ownershipGeneration, *count);
            if (previous != client.statTrakCounts.end() && previous->second == state) continue;
            GCMessageWrite update{ k_EMsgNetworkStatTrakCount };
            update.WriteUint64(id); update.WriteUint64(assetId); update.WriteUint32(*count);
            if (item.ownershipGeneration) update.WriteUint64(item.ownershipGeneration);
            PostToHost(HostEvent::NetMessage, id, update.Data(), update.Size());
            client.statTrakCounts[assetId] = state;
        }
        std::erase_if(client.statTrakCounts, [owned](const auto &entry) { return !owned->contains(entry.first); });
        if (loadoutChanges.contains(id) || !client.initialized || client.loadoutRequested) RequestOwnedLoadout(id);
    }
}

void ServerGC::RefreshCommittedCounters(std::unordered_set<uint64_t> &changedPlayers, bool force)
{
    if (!m_ownedPolicy || m_ownedPolicy->expiresAt <= std::chrono::system_clock::now()) return;
    std::error_code ec;
    const auto modified = std::filesystem::last_write_time(B2GCommittedCountersPath, ec);
    if (ec || (!force && m_counterWriteTime && modified == *m_counterWriteTime)) return;
    B2GCommittedCounters counters;
    if (!LoadB2GCommittedCounters(*m_ownedPolicy, m_itemSchema, counters)) return;
    if (counters.sequence < m_counterSequence) return;
    m_counterSequence = counters.sequence;
    m_counterWriteTime = modified;
    for (const auto &[owner, items] : counters.players)
    {
        auto &owned = m_ownedPolicy->players.at(owner);
        for (const auto &[asset, count] : items)
        {
            auto &item = owned.at(asset);
            const auto previous = B2GWeaponStatTrakCount(item, m_itemSchema);
            if (!previous || count <= *previous) continue;
            for (auto &attribute : *item.item.mutable_attribute())
                if (attribute.def_index() == ItemSchema::AttributeKillEater)
                    m_itemSchema.SetAttributeUint32(&attribute, count);
            changedPlayers.insert(owner);
        }
    }
}

bool ServerGC::PublishOwnedLoadout(uint64_t steamId, const GCMessageWrite &message)
{
    auto client = m_ownedClients.find(steamId);
    if (client == m_ownedClients.end()) return false;
    GCMessageRead read{ 0, message.Data(), message.Size() };
    auto next = client->second.published;
    std::unordered_set<uint64_t> modified;
    const auto accept = [&](const std::string &data) {
        CSOEconItem item;
        if (!item.ParseFromString(data) || !modified.insert(item.id()).second) return false;
        next[item.id()] = std::move(item);
        return true;
    };
    if (read.TypeUnmasked() == k_ESOMsg_CacheSubscribed)
    {
        CMsgSOCacheSubscribed cache;
        if (!read.ReadProtobuf(cache)) return false;
        next.clear();
        for (const auto &type : cache.objects())
            for (const auto &data : type.object_data()) if (!accept(data)) return false;
    }
    else if (read.TypeUnmasked() == k_ESOMsg_UpdateMultiple)
    {
        CMsgSOMultipleObjects updates;
        if (!read.ReadProtobuf(updates)) return false;
        for (const auto &object : updates.objects_modified())
            if (!accept(object.object_data())) return false;
    }
    else
    {
        CMsgSOSingleObject update;
        if (!read.ReadProtobuf(update) || !accept(update.object_data())) return false;
    }
    // Validate the resulting loadout, not merely individual updates. An
    // overlapping/partial equip is retried using a complete client snapshot.
    if (next.size() > B2GMaxOwnedItems) return false;
    std::set<std::pair<uint32_t, uint32_t>> slots;
    for (const auto &[id, item] : next) if (!TrackOwnedEquipSlots(item, slots)) return false;
    PublishOwnedItems(steamId, std::move(next));
    client->second.loadoutRequested = false;
    return true;
}

void ServerGC::PublishOwnedItems(uint64_t steamId, std::unordered_map<uint64_t, CSOEconItem> items)
{
    auto &client = m_ownedClients.at(steamId);
    const auto send = [&](uint32_t type, const google::protobuf::MessageLite &message) {
        if (!m_sentWelcome) SendServerWelcome();
        GCMessageWrite write{ type, message };
        PostToHost(HostEvent::Message, write.TypeMasked(), write.Data(), write.Size());
    };
    CMsgSOIDOwner owner;
    owner.set_type(SoIdTypeSteamId);
    owner.set_id(steamId);
    if (!client.initialized)
    {
        CMsgSOCacheSubscribed cache;
        *cache.mutable_owner_soid() = owner;
        cache.set_version(++m_ownedVersion);
        auto *objects = cache.add_objects();
        objects->set_type_id(SOTypeItem);
        for (const auto &[id, item] : items) objects->add_object_data(item.SerializeAsString());
        send(k_ESOMsg_CacheSubscribed, cache);
        client.initialized = true;
    }
    else
    {
        for (const auto &[id, item] : client.published)
        {
            if (items.contains(id)) continue;
            CMsgSOSingleObject destroyed;
            *destroyed.mutable_owner_soid() = owner;
            destroyed.set_version(++m_ownedVersion);
            destroyed.set_type_id(SOTypeItem);
            CSOEconItem key;
            key.set_id(id);
            destroyed.set_object_data(key.SerializeAsString());
            send(k_ESOMsg_Destroy, destroyed);
        }
        CMsgSOMultipleObjects updates;
        *updates.mutable_owner_soid() = owner;
        for (const auto &[id, item] : items)
        {
            const auto prior = client.published.find(id);
            if (prior != client.published.end()
                && prior->second.SerializeAsString() == item.SerializeAsString()) continue;
            if (prior == client.published.end())
            {
                CMsgSOSingleObject created;
                *created.mutable_owner_soid() = owner;
                created.set_version(++m_ownedVersion);
                created.set_type_id(SOTypeItem);
                auto unequipped = item;
                unequipped.clear_equipped_state();
                created.set_object_data(unequipped.SerializeAsString());
                send(k_ESOMsg_Create, created);
            }
            auto *object = updates.add_objects_modified();
            object->set_type_id(SOTypeItem);
            object->set_object_data(item.SerializeAsString());
        }
        if (updates.objects_modified_size())
        {
            updates.set_version(++m_ownedVersion);
            send(k_ESOMsg_UpdateMultiple, updates);
        }
    }
    client.published = std::move(items);
}

void ServerGC::UpdateMusicKitMVPState(uint64_t steamId, GCMessageRead &messageRead)
{
    uint32_t userId = messageRead.ReadUint32();
    uint32_t hasEquippedStatTrakMusicKit = messageRead.ReadUint32();
    uint32_t currentMVPs = messageRead.ReadUint32();
    if (!messageRead.IsValid() || !userId || hasEquippedStatTrakMusicKit > 1)
    {
        Platform::Print("ServerGC: ignoring malformed music kit MVP state from %llu\n", steamId);
        return;
    }

    MusicKitMVPState state;
    state.userId = static_cast<int>(userId);
    state.currentMVPs = currentMVPs;
    state.hasEquippedStatTrakMusicKit = hasEquippedStatTrakMusicKit != 0;

    {
        std::lock_guard<std::mutex> lock{ m_musicKitMVPStateMutex };

        auto &slot = m_musicKitMVPStateBySteamId[steamId];
        if (slot.userId > 0 && slot.userId != state.userId)
        {
            m_musicKitMVPStateByUserId.erase(slot.userId);
        }

        slot = state;
        m_musicKitMVPStateByUserId[state.userId] = state;
    }

    Platform::Print("ServerGC: updated music kit MVP state from %llu: userid=%u haskit=%u mvps=%u\n",
        steamId,
        userId,
        hasEquippedStatTrakMusicKit,
        currentMVPs);
}

void ServerGC::SendServerWelcome()
{
    // we don't care about anything in this message, just reply

    CMsgCStrike15Welcome csWelcome;
    csWelcome.set_gscookieid(GameServerCookieId);

    CMsgClientWelcome welcome;
    welcome.set_version(0);
    welcome.set_game_data(csWelcome.SerializeAsString());
    welcome.set_rtime32_gc_welcome_timestamp(static_cast<uint32_t>(time(nullptr)));

    GCMessageWrite write{ k_EMsgGCServerWelcome, welcome };
    PostToHost(HostEvent::Message, write.TypeMasked(), write.Data(), write.Size());

    m_sentWelcome = true;
}

void ServerGC::IncrementKillCountAttribute(GCMessageRead &messageRead)
{
    CMsgIncrementKillCountAttribute message;
    if (!messageRead.ReadProtobuf(message))
    {
        Platform::Print("Parsing CMsgIncrementKillCountAttribute failed, ignoring\n");
        return;
    }

    // just forward it to the killer
    GCMessageWrite messageWrite{ k_EMsgGC_IncrementKillCountAttribute, message };
    CSteamID killerId{ message.killer_account_id(), k_EUniversePublic, k_EAccountTypeIndividual };
    Platform::Print(
        "ServerGC: forwarding StatTrak increment item=%llu amount=%u killer=%llu\n",
        message.item_id(), message.amount(), killerId.ConvertToUint64());
    PostToHost(HostEvent::NetMessage, killerId.ConvertToUint64(), messageWrite.Data(), messageWrite.Size());
}
