#pragma once

#include <steam/isteamnetworkingmessages.h>

constexpr int NetMessageSendFlags = k_nSteamNetworkingSend_Reliable;
constexpr int NetMessageChannel = 7;

// NOTE: these are used as gc message types!
// if they overlap with the game's gc messages, we're doomed
enum ENetworkMsg : uint32_t
{
    // sent by the server to client when they connect, data is the auth ticket
    k_EMsgNetworkConnect = (1u << 31) - 1,
    // sent by the client to server to keep round_mvp musickitmvps injectable
    k_EMsgNetworkMusicKitMVPState = (1u << 31) - 2,
    // Server requests the current equipped loadout after a trusted policy refresh.
    // Empty struct payload; this must not trigger a local inventory/UI reset.
    k_EMsgNetworkRequestSOCache = (1u << 31) - 3,
    // Server -> owner only, from the signed live inventory policy. Absolute
    // counts are idempotent; engine increment events must not also be applied.
    // Struct payload: uint64 owner Steam ID, uint64 asset ID, uint32 count.
    k_EMsgNetworkStatTrakCount = (1u << 31) - 4,
};
