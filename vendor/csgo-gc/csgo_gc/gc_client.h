#pragma once

#include "config.h"
#include "gc_shared.h"
#include "inventory.h"
#include "queue_presentation.h"

class LauncherBridge;

// Owned-only mode permits a deliberately small client-to-GC surface. Keep this
// policy independently testable because legacy case opening is a struct message
// while every other B2G client action currently uses protobuf framing.
bool IsOwnedOnlyClientMessageAllowed(uint32_t messageType, bool protobuf);

class ClientGC final : public SharedGC
{
public:
    ClientGC(uint64_t steamId);
    ~ClientGC();
    uint32_t LocalPlayerMusicKitMVPsForRoundMVPEvent() const;
    std::string RunRconCommand(std::string command);
    static std::string RconCommandUsageList();

private:
    struct RconRequest
    {
        std::string name;
        std::vector<std::string> args;
    };

    struct RconCommandDef
    {
        const char *name;
        const char *usage;
        std::string (ClientGC::*handler)(const RconRequest &request);
    };

    struct PendingStoreLineItem
    {
        uint32_t defIndex;
        uint32_t quantity;
    };

    void HandleEvent(GCEvent type, uint64_t id, const std::vector<uint8_t> &buffer) override;

    // event handlers
    void HandleMessage(uint32_t type, const void *data, uint32_t size);
    void HandleNetMessage(const void *data, uint32_t size);
    void HandleSOCacheRequest();
    void RefreshCachedMusicKitMVPs();
    void SyncLocalPlayerMusicKitState(int userId);
    void SendMusicKitMVPStateToGameServer();
    static const RconCommandDef *RconCommands(size_t &count);
    std::string ExecuteRconCommand(std::string_view command);
    std::string RconHelp(const RconRequest &request);
    std::string RconPing(const RconRequest &request);
    std::string RconStatus(const RconRequest &request);
    std::string RconClients(const RconRequest &request);
    std::string RconListItems(const RconRequest &request);
    std::string RconFindItem(const RconRequest &request);
    std::string RconItemInfo(const RconRequest &request);
    std::string RconGiveItem(const RconRequest &request);
    std::string RconRemoveItem(const RconRequest &request);
    std::string RconRefreshInventory(const RconRequest &request);
    std::string RconSaveInventory(const RconRequest &request);

    // send to the local game and the game server we're connected to (if we're connected)
    void SendMessageToGame(bool sendToGameServer, uint32_t type,
        const google::protobuf::MessageLite &message, uint64_t jobId = JobIdInvalid);

    void OnClientHello(GCMessageRead &messageRead);
    void SOCacheSubscriptionRefresh(GCMessageRead &messageRead);
    void AdjustItemEquippedState(GCMessageRead &messageRead);
    void ClientPlayerDecalSign(GCMessageRead &messageRead);
    void UseItemRequest(GCMessageRead &messageRead);
    void ClientRequestJoinServerData(GCMessageRead &messageRead);
    void ClientRequestPlayersProfile(GCMessageRead &messageRead);
    void SendMinimalPlayerProfiles(
        const CMsgGCCStrike15_v2_ClientRequestPlayersProfile &request);
    void SetEventFavorite(GCMessageRead &messageRead);
    void GetEventFavorites(GCMessageRead &messageRead);
    void SetItemPositions(GCMessageRead &messageRead);
    void IncrementKillCountAttribute(GCMessageRead &messageRead);
    // Increment the equipped StatTrak music kit when the local player receives round MVP.
    void LocalPlayerRoundMVP();
    void ApplySticker(GCMessageRead &messageRead);
    void RequestPrestigeCoin(GCMessageRead &messageRead);
    void StoreGetUserData(GCMessageRead &messageRead);
    void StorePurchaseInit(GCMessageRead &messageRead);
    void StorePurchaseFinalize(GCMessageRead &messageRead);
    void MatchmakingStart(GCMessageRead &messageRead);
    void MatchmakingStop(GCMessageRead &messageRead);
    void HandleLauncherBridgeMessage(uint16_t type, const std::vector<uint8_t> &buffer);
    void SendLauncherLoadoutSnapshot();
    void SendMatchmakingUpdate(std::string_view error = {});

    void DeleteItem(GCMessageRead &messageRead);
    void UnlockCrate(GCMessageRead &messageRead);
    void Craft(GCMessageRead &messageRead);
    void NameItem(GCMessageRead &messageRead);
    void NameBaseItem(GCMessageRead &messageRead);
    void RemoveItemName(GCMessageRead &messageRead);

    void ProcessStorageInspect(GCMessageRead &messageRead);
    void ProcessStorageDeposit(GCMessageRead &messageRead);
    void ProcessStorageWithdraw(GCMessageRead &messageRead);
    void DispatchStorageResult(const Inventory::StorageTransaction &tx);
    void HandleCounterSwapRequest(GCMessageRead &messageRead);
    void HandleRequestSouvenir(GCMessageRead &messageRead);
    void BroadcastSwapOutcome(const Inventory::CounterSwapResult &outcome);

    void BuildMatchmakingHello(CMsgGCCStrike15_v2_MatchmakingGC2ClientHello &message);
    void BuildClientWelcome(CMsgClientWelcome &message, const CMsgClientHello &hello,
        const CMsgCStrike15Welcome &csWelcome,
        const CMsgGCCStrike15_v2_MatchmakingGC2ClientHello &matchmakingHello);
    void SendRankUpdate();

    uint32_t AccountId() const { return m_steamId & 0xffffffff; }

    const uint64_t m_steamId;
    const uint32_t m_buildYear;

    struct LauncherState
    {
        bool valid{};
        uint32_t rankId{};
        uint32_t wins{};
        uint32_t playerLevel{};
        uint32_t playerXp{};
        uint32_t queuePhase{};
        uint32_t playersOnline{};
        uint32_t serversOnline{};
        uint32_t playersSearching{};
        uint32_t ongoingMatches{};
        uint32_t estimatedWaitSeconds{};
    };

    struct PendingCaseOpen
    {
        uint64_t caseAssetId{};
        uint64_t keyAssetId{};
    };

    struct PendingTradeUp
    {
        int16_t recipe{};
        std::array<uint64_t, 10> inputAssetIds{};
    };

    struct PendingSprayUnseal
    {
        uint64_t sealedAssetId{};
    };

    Inventory m_inventory;
    LauncherState m_launcherState;
    QueuePresentation m_queuePresentation;
    bool m_clientWelcomeSent{};
    std::unique_ptr<LauncherBridge> m_launcherBridge;
    std::optional<PendingCaseOpen> m_pendingCaseOpen;
    std::optional<PendingTradeUp> m_pendingTradeUp;
    std::optional<PendingSprayUnseal> m_pendingSprayUnseal;
    struct PendingServiceMedal
    {
        uint64_t requestId;
        uint64_t jobId;
        uint32_t definitionIndex;
    };
    std::optional<PendingServiceMedal> m_pendingServiceMedal;
    uint64_t m_nextServiceMedalRequestId{};
    std::atomic<int32_t> m_localUserId{};
    std::atomic<int32_t> m_cachedMusicKitMVPs{ -1 };

    // microtransactions, we only have one going at a time
    uint64_t m_transactionId{};
    std::vector<PendingStoreLineItem> m_transactionLineItems;
};
