#pragma once

#include "gc_shared.h"

// Small, local-only bridge between the compatibility GC and the long-running
// B2G launcher. The launcher owns all account credentials; this client only
// sends native Panorama intent and receives non-secret presentation state.
class LauncherBridge final
{
public:
    enum class MessageType : uint16_t
    {
        ClientHello = 1,
        QueueStart = 2,
        QueueStop = 3,
        ReadyAccept = 4,
        PlayerProfilesRequest = 5,
        CaseOpenRequest = 6,
        TradeUpRequest = 7,
        LoadoutSync = 8,
        InventoryAcknowledge = 9,
        ItemRename = 10,
        SprayUnsealRequest = 11,
        SprayUseRequest = 12,
        QueueStartCorrelated = 13,
        QueueStopCorrelated = 14,
        ServiceMedalRequest = 15,
        State = 101,
        Error = 102,
        ReadyCheck = 103,
        PlayerProfiles = 104,
        CaseOpenResult = 105,
        InventoryRefresh = 106,
        TradeUpResult = 107,
        SprayUnsealResult = 108,
        QueueCommandResult = 109,
        ServiceMedalResult = 110,
    };

#pragma pack(push, 1)
    struct ServiceMedalRequestWire
    {
        uint64_t requestId;
        uint32_t definitionIndex; // zero previews; a nonzero definition redeems
        uint32_t reserved;
    };
    struct ServiceMedalResultWire
    {
        uint64_t requestId;
        uint64_t assetId; // preview: current same-year medal, or zero
        uint32_t definitionIndex;
        uint32_t prestigeTime;
        uint32_t playerLevel;
        uint32_t playerXp;
        uint8_t succeeded;
        uint8_t redeemed;
        uint16_t failureReason; // 0 transport/unknown, 1 level, 2 capacity, 3 exhausted
    };
    struct ReadyCheckWire
    {
        uint8_t visible;
        uint8_t localAccepted;
        uint16_t announcementOnly; // 1 = native non-competitive auto-connect notice
        uint32_t acceptedPlayers;
        uint32_t totalPlayers;
        uint32_t secondsRemaining;
        char matchId[36];
        char map[32];
    };

    struct QueueCommandResultWire
    {
        uint64_t requestId;
        uint32_t queuePhase;
        // Followed by at most 512 UTF-8 bytes of an optional error.
    };

    struct PlayerProfilesHeader
    {
        uint8_t hasRequestId;
        uint8_t reserved[3];
        uint32_t requestId;
        uint32_t count;
    };

    struct PlayerProfileWire
    {
        uint32_t accountId;
        uint32_t rankId;
        uint32_t wins;
        uint32_t playerLevel;
        uint32_t playerXp;
    };

    struct CaseOpenWire
    {
        uint64_t caseAssetId;
        uint64_t keyAssetId;
    };

    struct CaseOpenResultWire
    {
        uint8_t succeeded;
        uint8_t reservedByte;
        uint16_t itemNameBytes;
        uint32_t reserved;
        uint64_t caseAssetId;
        uint64_t keyAssetId;
        uint64_t resultAssetId;
        char itemName[160];
    };

    struct TradeUpWire
    {
        int16_t recipe;
        uint16_t itemCount;
        uint32_t reserved;
        uint64_t inputAssetIds[10];
    };

    struct TradeUpResultWire
    {
        uint8_t succeeded;
        uint8_t reservedByte;
        int16_t recipeIndex;
        uint32_t reserved;
        uint64_t resultAssetId;
        uint64_t inputAssetIds[10];
    };

    struct ListHeaderWire
    {
        uint16_t count;
        // LoadoutSync/InventoryAcknowledge: 1 appends a uint64 ownership
        // generation to each entry; 0 is the legacy untraded-item shape.
        uint16_t reserved;
    };

    struct InventoryPositionWire
    {
        uint64_t assetId;
        uint32_t position;
    };

    struct ItemRenameHeaderWire
    {
        uint64_t assetId;
        uint16_t nameBytes;
        uint16_t reserved;
    };

    struct SprayRequestWire
    {
        uint64_t assetId;
    };

    struct SprayUnsealResultWire
    {
        uint8_t succeeded;
        uint8_t reserved[7];
        uint64_t sealedAssetId;
        uint64_t resultAssetId;
    };
#pragma pack(pop)

    static_assert(sizeof(ReadyCheckWire) == 84);
    static_assert(sizeof(ServiceMedalRequestWire) == 16);
    static_assert(sizeof(ServiceMedalResultWire) == 36);
    static_assert(sizeof(QueueCommandResultWire) == 12);
    static_assert(sizeof(PlayerProfilesHeader) == 12);
    static_assert(sizeof(PlayerProfileWire) == 20);
    static_assert(sizeof(CaseOpenWire) == 16);
    static_assert(sizeof(CaseOpenResultWire) == 192);
    static_assert(sizeof(TradeUpWire) == 88);
    static_assert(sizeof(TradeUpResultWire) == 96);
    static_assert(sizeof(ListHeaderWire) == 4);
    static_assert(sizeof(InventoryPositionWire) == 12);
    static_assert(sizeof(ItemRenameHeaderWire) == 12);
    static_assert(sizeof(SprayRequestWire) == 8);
    static_assert(sizeof(SprayUnsealResultWire) == 24);

    LauncherBridge(SharedGC &gc, uint64_t steamId);
    ~LauncherBridge();

    bool Send(MessageType type, const void *data, uint32_t size);

private:
    struct OutboundMessage
    {
        MessageType type;
        std::vector<uint8_t> payload;
    };

    void Worker();

    SharedGC &m_gc;
    const uint64_t m_steamId;
    std::atomic<bool> m_stopping{ false };
    std::atomic<bool> m_connected{ false };
    std::mutex m_outboundMutex;
    std::vector<OutboundMessage> m_outbound;
    std::thread m_thread;
};
