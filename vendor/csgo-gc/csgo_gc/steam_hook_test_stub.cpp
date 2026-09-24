#include "steam_hook.h"

bool SteamHookGetLobbyRoster(uint64_t, uint64_t &ownerSteamId,
    std::vector<uint64_t> &memberSteamIds)
{
    ownerSteamId = 0;
    memberSteamIds.clear();
    return false;
}
