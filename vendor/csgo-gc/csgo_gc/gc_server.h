#pragma once

#include "gc_shared.h"
#include "item_schema.h"
#include "owned_inventory.h"
#include <filesystem>

class ServerGC final : public SharedGC
{
public:
    // Nonzero only for the paired owner of an in-process practice server.
    // Dedicated servers always use the versioned, fenced match policy.
    explicit ServerGC(uint64_t localPracticeSteamId = 0);
    ~ServerGC();
    bool RoundMVPMusicKitCountForUserId(int userId, int &musickitmvps) const;

private:
    void HandleEvent(GCEvent type, uint64_t id, const std::vector<uint8_t> &buffer) override;

    // event handlers
    void HandleMessage(uint32_t type, const void *data, uint32_t size);
    void HandleNetMessage(uint64_t steamId, const void *data, uint32_t size);
    void HandleClientSOCacheUnsubscribe(uint64_t steamId);
    void HandlePeriodicWork() override;
    void RefreshOwnedInventory(bool force = false);
    void RefreshCommittedCounters(std::unordered_set<uint64_t> &changedPlayers, bool force);
    void RequestOwnedLoadout(uint64_t steamId);
    const B2GOwnedItems *CurrentOwnedItems(uint64_t steamId) const;
    bool PublishOwnedLoadout(uint64_t steamId, const GCMessageWrite &message);
    void PublishOwnedItems(uint64_t steamId, std::unordered_map<uint64_t, CSOEconItem> items);

    struct OwnedClient
    {
        std::string leaseKey;
        bool initialized{}, revoked{}, loadoutRequested{};
        std::chrono::steady_clock::time_point lastRequest{};
        std::unordered_map<uint64_t, CSOEconItem> published;
        std::unordered_map<uint64_t, std::pair<uint64_t, uint32_t>> statTrakCounts;
    };
    std::unordered_map<uint64_t, OwnedClient> m_ownedClients;
    bool m_managedConnections{};
    const uint64_t m_localPracticeSteamId{};
    // Shared monotonic sequence also survives an owner's disconnect/reconnect.
    uint64_t m_ownedVersion{};
    std::optional<B2GServerOwnedSnapshot> m_ownedPolicy;
    std::optional<std::filesystem::file_time_type> m_policyWriteTime;
    std::chrono::steady_clock::time_point m_lastPolicyPoll{};
    uint64_t m_counterSequence{};
    std::optional<std::filesystem::file_time_type> m_counterWriteTime;

    void SendServerWelcome();
    void IncrementKillCountAttribute(GCMessageRead &messageRead);
    void UpdateMusicKitMVPState(uint64_t steamId, GCMessageRead &messageRead);

    bool m_sentWelcome{};
    ItemSchema m_itemSchema;

    struct MusicKitMVPState
    {
        int userId{};
        uint32_t currentMVPs{};
        bool hasEquippedStatTrakMusicKit{};
    };

    mutable std::mutex m_musicKitMVPStateMutex;
    std::unordered_map<uint64_t, MusicKitMVPState> m_musicKitMVPStateBySteamId;
    std::unordered_map<int, MusicKitMVPState> m_musicKitMVPStateByUserId;
};
