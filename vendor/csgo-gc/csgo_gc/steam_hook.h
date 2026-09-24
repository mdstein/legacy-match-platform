#pragma once

#include <cstdint>
#include <vector>

void SteamHookInstall(bool dedicated);

// Reads the current roster from Valve's authenticated Steam lobby service.
// This is used only while handling a native matchmaking request on the game
// thread; the caller still validates the local player and lobby owner.
bool SteamHookGetLobbyRoster(uint64_t lobbyId, uint64_t &ownerSteamId,
    std::vector<uint64_t> &memberSteamIds);
