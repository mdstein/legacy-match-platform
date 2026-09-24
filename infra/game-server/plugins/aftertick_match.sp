#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <cstrike>

public Plugin myinfo =
{
    name = "Aftertick Match",
    author = "Aftertick",
    description = "Roster-gated lifecycle and append-only event bridge",
    version = "0.1.7",
    url = ""
};

enum AftertickMatchState
{
    MatchState_Idle = 0,
    MatchState_Warmup,
    MatchState_Live,
    MatchState_Ended,
    MatchState_Aborted
}

ConVar g_MatchId;
ConVar g_Mode;
ConVar g_RosterT;
ConVar g_RosterCt;
ConVar g_RosterFfa;
ConVar g_AutoStart;
ConVar g_NoShowSeconds;
ConVar g_AbandonSeconds;
ConVar g_DeathmatchEmptySeconds;
ConVar g_AntiCheatSelfTestEnabled;
AftertickMatchState g_State = MatchState_Idle;
char g_EventPath[PLATFORM_MAX_PATH];
#define AFTERTICK_COMPETITIVE_SIZE 10
#define AFTERTICK_DEATHMATCH_SIZE 14
#define AFTERTICK_ROSTER_SIZE 14
#define AFTERTICK_DEATHMATCH_FRAG_LIMIT 40
#define AFTERTICK_DEATHMATCH_TIME_LIMIT 600
char g_SteamIds[AFTERTICK_ROSTER_SIZE][32];
int g_Kills[AFTERTICK_ROSTER_SIZE];
int g_Deaths[AFTERTICK_ROSTER_SIZE];
int g_Assists[AFTERTICK_ROSTER_SIZE];
int g_Damage[AFTERTICK_ROSTER_SIZE];
int g_RoundsPlayed[AFTERTICK_ROSTER_SIZE];
int g_KastRounds[AFTERTICK_ROSTER_SIZE];
int g_OpeningKills[AFTERTICK_ROSTER_SIZE];
int g_OpeningDeaths[AFTERTICK_ROSTER_SIZE];
int g_FlashAssists[AFTERTICK_ROSTER_SIZE];
int g_UtilityDamage[AFTERTICK_ROSTER_SIZE];
bool g_RoundContribution[AFTERTICK_ROSTER_SIZE];
bool g_WasAdmitted[AFTERTICK_ROSTER_SIZE];
bool g_XpPresented[AFTERTICK_ROSTER_SIZE];
bool g_DropPresented[AFTERTICK_ROSTER_SIZE];
int g_DisconnectedAt[AFTERTICK_ROSTER_SIZE];
bool g_RoundHasOpeningKill = false;
int g_WarmupStartedAt = 0;
int g_DeathmatchEmptyGeneration = 0;
StringMap g_OwnershipGenerations;
char g_OwnershipPath[PLATFORM_MAX_PATH];
char g_OwnershipWatermark[80];
char g_OwnershipMatch[64];
int g_OwnershipExpiresAt;

public void OnPluginStart()
{
    g_MatchId = CreateConVar("aftertick_match_id", "", "Platform match UUID.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
    g_Mode = CreateConVar("aftertick_mode", "competitive", "Match mode: competitive or deathmatch.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
    g_RosterT = CreateConVar("aftertick_roster_t", "", "Comma-separated Terrorist SteamID64 roster.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
    g_RosterCt = CreateConVar("aftertick_roster_ct", "", "Comma-separated Counter-Terrorist SteamID64 roster.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
    g_RosterFfa = CreateConVar("aftertick_roster_ffa", "", "Comma-separated Deathmatch SteamID64 roster.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
    g_AutoStart = CreateConVar("aftertick_auto_start", "1", "End warmup when all ten rostered players are present.", _, true, 0.0, true, 1.0);
    g_NoShowSeconds = CreateConVar("aftertick_no_show_seconds", "300", "Cancel warmup when the full roster has not arrived in time.", _, true, 30.0, true, 900.0);
    g_AbandonSeconds = CreateConVar("aftertick_abandon_seconds", "300", "Forfeit a live match when a disconnected roster player does not return in time.", _, true, 30.0, true, 900.0);
    g_DeathmatchEmptySeconds = CreateConVar("aftertick_deathmatch_empty_seconds", "60", "Abort an empty Deathmatch after this reconnect grace period.", _, true, 15.0, true, 300.0);
    g_AntiCheatSelfTestEnabled = CreateConVar("aftertick_anticheat_self_test_enabled", "0", "Allow a root operator to emit a synthetic anti-cheat pipeline test for a connected roster player.", _, true, 0.0, true, 1.0);

    RegAdminCmd("sm_aftertick_prepare", CommandPrepare, ADMFLAG_ROOT, "Prepare a configured Aftertick match on a warm server.");
    RegAdminCmd("sm_aftertick_sync_roster", CommandSyncRoster, ADMFLAG_ROOT, "Apply an append-only Deathmatch roster update.");
    RegAdminCmd("sm_aftertick_begin", CommandBegin, ADMFLAG_ROOT, "Begin the configured Aftertick match.");
    RegAdminCmd("sm_aftertick_abort", CommandAbort, ADMFLAG_ROOT, "Abort the active Aftertick match.");
    RegAdminCmd("sm_aftertick_pause", CommandPause, ADMFLAG_ROOT, "Pause the active Aftertick match.");
    RegAdminCmd("sm_aftertick_resume", CommandResume, ADMFLAG_ROOT, "Resume the active Aftertick match.");
    RegAdminCmd("sm_aftertick_surrender", CommandSurrender, ADMFLAG_ROOT, "End by surrender: alpha or bravo.");
    RegAdminCmd("sm_aftertick_test_anticheat", CommandAntiCheatSelfTest, ADMFLAG_ROOT, "Emit a non-punitive synthetic anti-cheat signal for a connected roster SteamID64.");
    RegAdminCmd("sm_aftertick_present_xp", CommandPresentXp, ADMFLAG_ROOT, "Present an authoritative post-match XP receipt to one rostered client.");
    RegAdminCmd("sm_aftertick_announce_drop", CommandAnnounceDrop, ADMFLAG_ROOT, "Broadcast an authoritative B2G container result to the active roster.");
    HookEvent("round_start", EventRoundStart, EventHookMode_PostNoCopy);
    HookEvent("round_end", EventRoundEnd, EventHookMode_PostNoCopy);
    HookEvent("player_hurt", EventPlayerHurt, EventHookMode_Post);
    HookEvent("player_death", EventPlayerDeath, EventHookMode_Post);
    HookEvent("cs_win_panel_match", EventMatchEnd, EventHookMode_PostNoCopy);

    BuildPath(Path_SM, g_EventPath, sizeof(g_EventPath), "logs/aftertick-events.jsonl");
    BuildPath(Path_SM, g_OwnershipPath, sizeof(g_OwnershipPath), "configs/aftertick-owned-generations.txt");
    g_OwnershipGenerations = new StringMap();
    CreateTimer(0.25, TimerRefreshOwnership, _, TIMER_REPEAT);
    AutoExecConfig(true, "aftertick_match");
}

// No file reads or inventory parsing in the kill hook. A tiny header poll
// notices ownership changes even when two trades share the same file mtime.
public Action TimerRefreshOwnership(Handle timer)
{
    RefreshOwnershipGenerations();
    return Plugin_Continue;
}

void RefreshOwnershipGenerations()
{
    File file = OpenFile(g_OwnershipPath, "r");
    if (file == null)
    {
        g_OwnershipExpiresAt = 0;
        g_OwnershipWatermark[0] = '\0';
        return;
    }
    char watermark[80];
    bool read = file.ReadLine(watermark, sizeof(watermark));
    delete file;
    TrimString(watermark);
    if (!read || strlen(watermark) != 67 || strncmp(watermark, "// ", 3) != 0) return;
    if (StrEqual(watermark, g_OwnershipWatermark)) return;

    KeyValues policy = new KeyValues("ownership");
    if (!policy.ImportFromFile(g_OwnershipPath))
    {
        delete policy;
        return;
    }
    char matchId[64];
    policy.GetString("match_id", matchId, sizeof(matchId));
    int expiresAt = policy.GetNum("expires_at", 0);
    StringMap next = new StringMap();
    bool valid = strlen(matchId) == 36 && expiresAt > GetTime() && policy.JumpToKey("items");
    int entries;
    if (valid && policy.GotoFirstSubKey(false))
    {
        do
        {
            char key[64], generation[24];
            policy.GetSectionName(key, sizeof(key));
            policy.GetString(NULL_STRING, generation, sizeof(generation));
            int length = strlen(generation);
            if (++entries > AFTERTICK_ROSTER_SIZE * 512 || length < 1 || length > 19
                || (length > 1 && generation[0] == '0') || FindCharInString(key, ':') != 17)
            {
                valid = false;
                break;
            }
            for (int index = 0; index < length; index++)
                if (generation[index] < '0' || generation[index] > '9') valid = false;
            if (!valid || !next.SetString(key, generation, false))
            {
                valid = false;
                break;
            }
        } while (policy.GotoNextKey(false));
    }
    delete policy;
    if (!valid)
    {
        delete next;
        return;
    }
    delete g_OwnershipGenerations;
    g_OwnershipGenerations = next;
    strcopy(g_OwnershipWatermark, sizeof(g_OwnershipWatermark), watermark);
    strcopy(g_OwnershipMatch, sizeof(g_OwnershipMatch), matchId);
    g_OwnershipExpiresAt = expiresAt;
}

void OwnershipGenerationForKill(const char[] owner, const char[] asset, char[] generation, int length)
{
    // Unknown is deliberately not zero: absence of verified ownership cannot
    // authorize a new counter after an item was transferred away and back.
    strcopy(generation, length, "-1");
    char matchId[64];
    g_MatchId.GetString(matchId, sizeof(matchId));
    if (g_OwnershipExpiresAt <= GetTime() || !StrEqual(matchId, g_OwnershipMatch)) return;
    char key[64];
    Format(key, sizeof(key), "%s:%s", owner, asset);
    g_OwnershipGenerations.GetString(key, generation, length);
}

public void OnMapStart()
{
    char matchId[64];
    g_MatchId.GetString(matchId, sizeof(matchId));
    if (matchId[0] == '\0')
    {
        g_State = MatchState_Idle;
        return;
    }

    PrepareMatch();
}

public void OnClientAuthorized(int client, const char[] auth)
{
    if (IsFakeClient(client) || g_State == MatchState_Idle)
    {
        return;
    }
    CreateTimer(0.2, TimerValidateClient, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public void OnClientDisconnect(int client)
{
    if (IsFakeClient(client) || (g_State != MatchState_Warmup && g_State != MatchState_Live))
    {
        return;
    }
    char steamId[32];
    if (GetClientAuthId(client, AuthId_SteamID64, steamId, sizeof(steamId), true)
        && RosterSlot(steamId) >= 0)
    {
        EmitClientEvent("roster.disconnected", steamId);
        if (g_State == MatchState_Live && !IsDeathmatch())
        {
            int slot = RosterSlot(steamId);
            g_DisconnectedAt[slot] = GetTime();
            CreateTimer(float(g_AbandonSeconds.IntValue), TimerCheckAbandon, slot, TIMER_FLAG_NO_MAPCHANGE);
        }
    }
    if (IsDeathmatch())
    {
        g_DeathmatchEmptyGeneration++;
        CreateTimer(0.2, TimerRebalanceDeathmatchBots, _, TIMER_FLAG_NO_MAPCHANGE);
        if (CountConnectedRoster(CS_TEAM_T) == 0)
        {
            CreateTimer(
                float(g_DeathmatchEmptySeconds.IntValue),
                TimerAbortEmptyDeathmatch,
                g_DeathmatchEmptyGeneration,
                TIMER_FLAG_NO_MAPCHANGE
            );
        }
    }
}

public Action TimerValidateClient(Handle timer, int userId)
{
    int client = GetClientOfUserId(userId);
    if (client == 0 || !IsClientConnected(client) || IsFakeClient(client))
    {
        return Plugin_Stop;
    }

    char steamId[32];
    if (!GetClientAuthId(client, AuthId_SteamID64, steamId, sizeof(steamId), true)
        || RosterTeam(steamId) == CS_TEAM_NONE)
    {
        EmitClientEvent("roster.rejected", steamId);
        KickClient(client, "You are not assigned to this Aftertick match.");
        return Plugin_Stop;
    }

    int slot = RosterSlot(steamId);
    EmitClientEvent(g_WasAdmitted[slot] ? "roster.reconnected" : "roster.admitted", steamId);
    g_DisconnectedAt[slot] = 0;
    g_WasAdmitted[slot] = true;
    if (IsDeathmatch())
    {
        // Invalidate any pending empty-session timer before rebalancing bots.
        g_DeathmatchEmptyGeneration++;
        RebalanceDeathmatchBots();
    }
    return Plugin_Stop;
}

public Action TimerAbortEmptyDeathmatch(Handle timer, int generation)
{
    if (
        generation != g_DeathmatchEmptyGeneration
        || !IsDeathmatch()
        || (g_State != MatchState_Warmup && g_State != MatchState_Live)
        || CountConnectedRoster(CS_TEAM_T) > 0
    )
    {
        return Plugin_Stop;
    }

    g_State = MatchState_Aborted;
    EmitEvent("match.aborted", "{\"reason\":\"deathmatch_empty\"}");
    ServerCommand("mp_pause_match");
    return Plugin_Stop;
}

public Action TimerRebalanceDeathmatchBots(Handle timer)
{
    if (!IsDeathmatch() || (g_State != MatchState_Warmup && g_State != MatchState_Live))
    {
        return Plugin_Stop;
    }
    RebalanceDeathmatchBots();
    return Plugin_Continue;
}

void RebalanceDeathmatchBots()
{
    int desiredBots = AFTERTICK_DEATHMATCH_SIZE - CountConnectedRoster(CS_TEAM_T);
    int bots = CountDeathmatchBots();
    if (bots > desiredBots)
    {
        for (int client = 1; client <= MaxClients; client++)
        {
            if (IsClientInGame(client) && IsFakeClient(client)
                && !IsClientSourceTV(client) && !IsClientReplay(client))
            {
                KickClient(client, "A human player joined the Deathmatch.");
                break;
            }
        }
    }
    else if (bots < desiredBots)
    {
        // Add one per pass so overlapping connects/disconnects cannot overshoot.
        // The native bot_add command increments bot_quota, so restore the fixed
        // fill target immediately afterward.
        ServerCommand("bot_add");
        ServerCommand("bot_quota %d", AFTERTICK_DEATHMATCH_SIZE);
    }
}

int CountDeathmatchBots()
{
    int count = 0;
    for (int client = 1; client <= MaxClients; client++)
    {
        if (IsClientInGame(client) && IsFakeClient(client)
            && !IsClientSourceTV(client) && !IsClientReplay(client))
        {
            count++;
        }
    }
    return count;
}

public Action TimerCheckAbandon(Handle timer, int slot)
{
    if (g_State != MatchState_Live || slot < 0 || slot >= AFTERTICK_ROSTER_SIZE)
    {
        return Plugin_Stop;
    }
    int disconnectedAt = g_DisconnectedAt[slot];
    if (disconnectedAt == 0 || ClientForRosterSlot(slot) > 0)
    {
        g_DisconnectedAt[slot] = 0;
        return Plugin_Stop;
    }
    if (GetTime() - disconnectedAt < g_AbandonSeconds.IntValue)
    {
        return Plugin_Stop;
    }

    EmitParticipationViolation("roster.abandoned", slot, disconnectedAt, g_AbandonSeconds.IntValue);
    g_State = MatchState_Ended;
    int alphaScore = CS_GetTeamScore(CS_TEAM_T);
    int bravoScore = CS_GetTeamScore(CS_TEAM_CT);
    if (slot < 5 && bravoScore <= alphaScore)
    {
        bravoScore = alphaScore + 1;
    }
    else if (slot >= 5 && alphaScore <= bravoScore)
    {
        alphaScore = bravoScore + 1;
    }
    EmitTerminalEvent("match.forfeited", alphaScore, bravoScore);
    ServerCommand("mp_pause_match");
    return Plugin_Stop;
}

public Action TimerCheckRoster(Handle timer)
{
    if (g_State != MatchState_Warmup)
    {
        return Plugin_Stop;
    }
    bool fullRoster = IsDeathmatch()
        ? CountConnectedRoster(CS_TEAM_T) >= 1
        : CountConnectedRoster(CS_TEAM_T) == 5 && CountConnectedRoster(CS_TEAM_CT) == 5;
    if (g_AutoStart.BoolValue && fullRoster)
    {
        BeginMatch();
        return Plugin_Stop;
    }
    // Deathmatch is drop-in and bot-filled. The empty-session timer owns its
    // pre-connect lifecycle; fixed-roster no-show enforcement is competitive-only.
    if (IsDeathmatch())
    {
        return Plugin_Continue;
    }
    if (GetTime() - g_WarmupStartedAt >= g_NoShowSeconds.IntValue)
    {
        for (int slot = 0; slot < ActiveRosterSize(); slot++)
        {
            if (ClientForRosterSlot(slot) == 0)
            {
                EmitParticipationViolation(
                    "roster.no_show",
                    slot,
                    g_WarmupStartedAt,
                    g_NoShowSeconds.IntValue
                );
            }
        }
        char payload[128];
        Format(payload, sizeof(payload), "{\"mode\":\"%s\",\"alphaConnected\":%d,\"bravoConnected\":%d,\"ffaConnected\":%d}",
            IsDeathmatch() ? "deathmatch" : "competitive",
            IsDeathmatch() ? 0 : CountConnectedRoster(CS_TEAM_T),
            CountConnectedRoster(CS_TEAM_CT),
            IsDeathmatch() ? CountConnectedRoster(CS_TEAM_T) : 0);
        EmitEvent("match.no_show", payload);
        g_State = MatchState_Aborted;
        EmitEvent("match.aborted", "{\"reason\":\"no_show\"}");
        ServerCommand("mp_pause_match");
        return Plugin_Stop;
    }
    return Plugin_Continue;
}

public Action CommandBegin(int client, int args)
{
    if (!ConfiguredRosterIsValid())
    {
        ReplyToCommand(client, "[B2G] The configured roster does not match the selected mode.");
        return Plugin_Handled;
    }
    if (g_State != MatchState_Warmup)
    {
        ReplyToCommand(client, "[Aftertick] Match is not in warmup.");
        return Plugin_Handled;
    }

    BeginMatch();
    ReplyToCommand(client, "[Aftertick] Match is live.");
    return Plugin_Handled;
}

public Action CommandPrepare(int client, int args)
{
    if (!ConfiguredRosterIsValid())
    {
        ReplyToCommand(client, "[B2G] The configured roster does not match the selected mode.");
        return Plugin_Handled;
    }
    if (g_State == MatchState_Warmup || g_State == MatchState_Live)
    {
        ReplyToCommand(client, "[Aftertick] Match is already active.");
        return Plugin_Handled;
    }

    PrepareMatch();
    ReplyToCommand(client, "[Aftertick] Match prepared for warmup.");
    return Plugin_Handled;
}

public Action CommandSyncRoster(int client, int args)
{
    if (!IsDeathmatch() || (g_State != MatchState_Warmup && g_State != MatchState_Live))
    {
        ReplyToCommand(client, "[B2G] Roster synchronization requires an active Deathmatch.");
        return Plugin_Handled;
    }

    int configured = CountRosterEntries(g_RosterFfa);
    int loaded = LoadedRosterSize();
    if (configured < 1 || configured > AFTERTICK_DEATHMATCH_SIZE || configured < loaded)
    {
        ReplyToCommand(client, "[B2G] Deathmatch roster updates must contain 1-14 players and may only append.");
        return Plugin_Handled;
    }

    char roster[512];
    char ffa[AFTERTICK_DEATHMATCH_SIZE][32];
    g_RosterFfa.GetString(roster, sizeof(roster));
    ExplodeString(roster, ",", ffa, sizeof(ffa), sizeof(ffa[]));
    for (int slot = 0; slot < configured; slot++)
    {
        TrimString(ffa[slot]);
        if (slot < loaded && !StrEqual(g_SteamIds[slot], ffa[slot], false))
        {
            ReplyToCommand(client, "[B2G] Deathmatch roster updates cannot replace an existing human.");
            return Plugin_Handled;
        }
    }
    for (int slot = loaded; slot < configured; slot++)
    {
        strcopy(g_SteamIds[slot], sizeof(g_SteamIds[]), ffa[slot]);
        g_Kills[slot] = 0;
        g_Deaths[slot] = 0;
        g_Assists[slot] = 0;
        g_Damage[slot] = 0;
        g_RoundsPlayed[slot] = 0;
        g_KastRounds[slot] = 0;
        g_OpeningKills[slot] = 0;
        g_OpeningDeaths[slot] = 0;
        g_FlashAssists[slot] = 0;
        g_UtilityDamage[slot] = 0;
        g_RoundContribution[slot] = false;
        g_WasAdmitted[slot] = false;
        g_XpPresented[slot] = false;
        g_DropPresented[slot] = false;
        g_DisconnectedAt[slot] = 0;
    }

    char payload[64];
    Format(payload, sizeof(payload), "{\"humanPlayers\":%d,\"botPlayers\":%d}",
        configured, AFTERTICK_DEATHMATCH_SIZE - configured);
    EmitEvent("roster.synced", payload);
    ReplyToCommand(client, "[B2G] Deathmatch roster synchronized.");
    return Plugin_Handled;
}

public Action CommandAbort(int client, int args)
{
    if (g_State == MatchState_Idle || g_State == MatchState_Ended || g_State == MatchState_Aborted)
    {
        ReplyToCommand(client, "[Aftertick] No active match to abort.");
        return Plugin_Handled;
    }

    g_State = MatchState_Aborted;
    EmitEvent("match.aborted", "{}");
    ServerCommand("mp_pause_match");
    ReplyToCommand(client, "[Aftertick] Match aborted.");
    return Plugin_Handled;
}

public Action CommandPause(int client, int args)
{
    if (g_State != MatchState_Live)
    {
        ReplyToCommand(client, "[Aftertick] Match is not live.");
        return Plugin_Handled;
    }
    EmitEvent("match.paused", "{}");
    ServerCommand("mp_pause_match");
    return Plugin_Handled;
}

public Action CommandResume(int client, int args)
{
    if (g_State != MatchState_Live)
    {
        ReplyToCommand(client, "[Aftertick] Match is not live.");
        return Plugin_Handled;
    }
    EmitEvent("match.resumed", "{}");
    ServerCommand("mp_unpause_match");
    return Plugin_Handled;
}

public Action CommandSurrender(int client, int args)
{
    if (g_State != MatchState_Live || args != 1)
    {
        ReplyToCommand(client, "[Aftertick] Usage while live: sm_aftertick_surrender alpha|bravo");
        return Plugin_Handled;
    }
    char team[16];
    GetCmdArg(1, team, sizeof(team));
    int alphaScore = CS_GetTeamScore(CS_TEAM_T);
    int bravoScore = CS_GetTeamScore(CS_TEAM_CT);
    if (StrEqual(team, "alpha", false))
    {
        if (bravoScore <= alphaScore)
        {
            bravoScore = alphaScore + 1;
        }
    }
    else if (StrEqual(team, "bravo", false))
    {
        if (alphaScore <= bravoScore)
        {
            alphaScore = bravoScore + 1;
        }
    }
    else
    {
        ReplyToCommand(client, "[Aftertick] Team must be alpha or bravo.");
        return Plugin_Handled;
    }
    g_State = MatchState_Ended;
    EmitTerminalEvent("match.surrendered", alphaScore, bravoScore);
    ServerCommand("mp_pause_match");
    return Plugin_Handled;
}

public Action CommandAntiCheatSelfTest(int client, int args)
{
    if (!g_AntiCheatSelfTestEnabled.BoolValue)
    {
        ReplyToCommand(client, "[B2G] Anti-cheat self-test is disabled. Enable it only for a controlled pipeline check.");
        return Plugin_Handled;
    }
    if ((g_State != MatchState_Warmup && g_State != MatchState_Live) || args != 1)
    {
        ReplyToCommand(client, "[B2G] Usage during an active match: sm_aftertick_test_anticheat <connected SteamID64>");
        return Plugin_Handled;
    }

    char steamId[32];
    GetCmdArg(1, steamId, sizeof(steamId));
    int slot = RosterSlot(steamId);
    if (slot < 0 || ClientForRosterSlot(slot) == 0)
    {
        ReplyToCommand(client, "[B2G] Self-test target must be a connected human on the active roster.");
        return Plugin_Handled;
    }

    EmitAntiCheatSignal(steamId, "b2g_pipeline_self_test", 0, true);
    ReplyToCommand(client, "[B2G] Synthetic anti-cheat pipeline signal emitted; disable the self-test ConVar now.");
    return Plugin_Handled;
}

public Action CommandAnnounceDrop(int client, int args)
{
    if ((g_State != MatchState_Warmup && g_State != MatchState_Live) || args != 4)
    {
        ReplyToCommand(client, "[B2G] Usage during an active match: sm_aftertick_announce_drop <SteamID64> <rarity> <quality> <item name>");
        return Plugin_Handled;
    }

    char steamId[32];
    char itemName[161];
    GetCmdArg(1, steamId, sizeof(steamId));
    int rarity = GetCmdArgInt(2);
    int quality = GetCmdArgInt(3);
    GetCmdArg(4, itemName, sizeof(itemName));
    int slot = RosterSlot(steamId);
    int target = slot < 0 ? 0 : ClientForRosterSlot(slot);
    if (target == 0 || rarity < 1 || rarity > 7 || quality < 0 || quality > 12
        || itemName[0] == '\0')
    {
        ReplyToCommand(client, "[B2G] Rejected invalid or disconnected drop recipient.");
        return Plugin_Handled;
    }

    // Final 2023 Panorama client: 0x0A..0x10 resolve schema rarities 1..7.
    // Restricted is 0x0D (#8847ff); neutral/team-name 0x03 is lighter #ba81f0.
    // Verified against the pinned legacy client, not old Multi-Colors aliases.
    // See docs/drop-chat-palette.md for the binary/schema evidence.
    int rarityColor = 0x01;
    switch (rarity)
    {
        case 1: rarityColor = 0x0A;
        case 2: rarityColor = 0x0B;
        case 3: rarityColor = 0x0C;
        case 4: rarityColor = 0x0D;
        case 5: rarityColor = 0x0E;
        case 6: rarityColor = 0x0F;
        case 7: rarityColor = 0x10;
    }
    char announcement[256];
    if (quality == 9)
    {
        Format(announcement, sizeof(announcement), " \x01%N\x01 has opened a container and found: %cStatTrak™ %s\x01", target, rarityColor, itemName);
    }
    else if (quality == 12)
    {
        Format(announcement, sizeof(announcement), " \x01%N\x01 has opened a container and found: %cSouvenir %s\x01", target, rarityColor, itemName);
    }
    else
    {
        Format(announcement, sizeof(announcement), " \x01%N\x01 has opened a container and found: %c%s\x01", target, rarityColor, itemName);
    }
    if (GetUserMessageType() != UM_Protobuf || GetUserMessageId("SayText2") == INVALID_MESSAGE_ID)
    {
        ReplyToCommand(client, "[B2G] The server does not expose CS:GO colored chat.");
        return Plugin_Handled;
    }
    Handle message = StartMessageAll("SayText2", USERMSG_RELIABLE);
    if (message == null)
    {
        ReplyToCommand(client, "[B2G] Could not start the drop chat announcement.");
        return Plugin_Handled;
    }
    Protobuf text = UserMessageToProtobuf(message);
    text.SetInt("ent_idx", 0);
    text.SetBool("chat", true);
    text.SetString("msg_name", announcement);
    for (int index = 0; index < 4; index++) text.AddString("params", "");
    EndMessage();
    ReplyToCommand(client, "[B2G] Drop result announced.");
    return Plugin_Handled;
}

public Action CommandPresentXp(int client, int args)
{
    if (g_State != MatchState_Ended || args != 10)
    {
        ReplyToCommand(client, "[B2G_XP_ERROR] Usage after match end: sm_aftertick_present_xp <SteamID64> <account_id> <previous_level> <previous_xp> <earned_xp> <category> <next_level> <next_xp> <has_service_drop> <service_drop_level>");
        return Plugin_Handled;
    }

    char steamId[32];
    GetCmdArg(1, steamId, sizeof(steamId));
    int slot = RosterSlot(steamId);
    int accountId = GetCmdArgInt(2);
    int previousLevel = GetCmdArgInt(3);
    int previousXp = GetCmdArgInt(4);
    int earnedXp = GetCmdArgInt(5);
    int category = GetCmdArgInt(6);
    int nextLevel = GetCmdArgInt(7);
    int nextXp = GetCmdArgInt(8);
    int hasServiceDrop = GetCmdArgInt(9);
    int serviceDropLevel = GetCmdArgInt(10);
    int expectedCategory = IsDeathmatch() ? 1 : 2;
    if (
        slot < 0
        || previousLevel < 1 || previousLevel > 40
        || previousXp < 0 || previousXp >= 1000
        || earnedXp < 1 || earnedXp > 1000
        || category != expectedCategory
        || nextLevel < 1 || nextLevel > 40
        || nextXp < 0 || nextXp >= 1000
        || (hasServiceDrop != 0 && hasServiceDrop != 1)
        || (hasServiceDrop == 1 && serviceDropLevel != nextLevel)
        || (hasServiceDrop == 0 && serviceDropLevel != 0)
    )
    {
        ReplyToCommand(client, "[B2G_XP_ERROR] Rejected invalid or non-roster progression data.");
        return Plugin_Handled;
    }

    int computedLevel = previousLevel;
    int computedXp = previousXp + earnedXp;
    while (computedLevel < 40 && computedXp >= 1000)
    {
        computedLevel++;
        computedXp -= 1000;
    }
    if (computedLevel == 40 && computedXp >= 1000)
    {
        computedXp = 999;
    }
    if (computedLevel != nextLevel || computedXp != nextXp)
    {
        ReplyToCommand(client, "[B2G_XP_ERROR] Rejected an inconsistent progression transition.");
        return Plugin_Handled;
    }
    if ((nextLevel > previousLevel) != (hasServiceDrop == 1))
    {
        ReplyToCommand(client, "[B2G_XP_ERROR] Rejected an inconsistent service-drop transition.");
        return Plugin_Handled;
    }
    if (g_XpPresented[slot] && (hasServiceDrop == 0 || g_DropPresented[slot]))
    {
        ReplyToCommand(client, "[B2G_XP_OK] duplicate");
        return Plugin_Handled;
    }

    int target = ClientForRosterSlot(slot);
    if (target == 0 || !IsClientInGame(target))
    {
        ReplyToCommand(client, "[B2G_XP_ABSENT] disconnected");
        return Plugin_Handled;
    }
    if (GetSteamAccountID(target, true) != accountId)
    {
        ReplyToCommand(client, "[B2G_XP_ERROR] Steam account identity mismatch.");
        return Plugin_Handled;
    }
    if (GetUserMessageType() != UM_Protobuf
        || (!g_XpPresented[slot] && GetUserMessageId("XpUpdate") == INVALID_MESSAGE_ID)
        || (hasServiceDrop == 1 && !g_DropPresented[slot]
            && GetUserMessageId("SendPlayerItemDrops") == INVALID_MESSAGE_ID))
    {
        ReplyToCommand(client, "[B2G_XP_ERROR] The server does not expose the required CS:GO progression protobuf messages.");
        return Plugin_Handled;
    }

    if (!g_XpPresented[slot])
    {
        Handle message = StartMessageOne("XpUpdate", target, USERMSG_RELIABLE | USERMSG_BLOCKHOOKS);
        if (message == null)
        {
            ReplyToCommand(client, "[B2G_XP_ERROR] Could not start the CS:GO XP message.");
            return Plugin_Handled;
        }
        Protobuf root = UserMessageToProtobuf(message);
        Protobuf data = root.ReadMessage("data");
        if (data == null)
        {
            EndMessage();
            ReplyToCommand(client, "[B2G_XP_ERROR] Could not open the CS:GO XP payload.");
            return Plugin_Handled;
        }
        data.SetInt("account_id", accountId);
        data.SetInt("current_xp", previousXp);
        data.SetInt("current_level", previousLevel);
        Protobuf progress = data.AddMessage("xp_progress_data");
        if (progress == null)
        {
            delete data;
            EndMessage();
            ReplyToCommand(client, "[B2G_XP_ERROR] Could not append the CS:GO XP category.");
            return Plugin_Handled;
        }
        progress.SetInt("xp_points", earnedXp);
        progress.SetInt("xp_category", category);
        delete progress;
        delete data;
        EndMessage();
        g_XpPresented[slot] = true;
    }

    if (hasServiceDrop == 1 && !g_DropPresented[slot])
    {
        Handle message = StartMessageOne("SendPlayerItemDrops", target, USERMSG_RELIABLE | USERMSG_BLOCKHOOKS);
        if (message == null)
        {
            ReplyToCommand(client, "[B2G_XP_ERROR] Could not start the CS:GO service-drop message.");
            return Plugin_Handled;
        }
        Protobuf root = UserMessageToProtobuf(message);
        Protobuf reward = root.AddMessage("entity_updates");
        if (reward == null)
        {
            EndMessage();
            ReplyToCommand(client, "[B2G_XP_ERROR] Could not append the CS:GO service drop.");
            return Plugin_Handled;
        }
        reward.SetInt("accountid", accountId);
        reward.SetInt("origin", 24);
        reward.SetInt("dropreason", 3);
        delete reward;
        EndMessage();
        g_DropPresented[slot] = true;
    }
    ReplyToCommand(client, "[B2G_XP_OK] sent drop=%d", hasServiceDrop);
    return Plugin_Handled;
}

public void EventRoundStart(Event event, const char[] name, bool dontBroadcast)
{
    if (g_State != MatchState_Live)
    {
        return;
    }
    g_RoundHasOpeningKill = false;
    for (int slot = 0; slot < ActiveRosterSize(); slot++)
    {
        g_RoundContribution[slot] = false;
    }
    char payload[128];
    Format(payload, sizeof(payload), "{\"tScore\":%d,\"ctScore\":%d}",
        CS_GetTeamScore(CS_TEAM_T), CS_GetTeamScore(CS_TEAM_CT));
    EmitEvent("round.started", payload);
}

public void EventPlayerHurt(Event event, const char[] name, bool dontBroadcast)
{
    if (g_State != MatchState_Live)
    {
        return;
    }
    int attacker = GetClientOfUserId(event.GetInt("attacker"));
    int victim = GetClientOfUserId(event.GetInt("userid"));
    if (attacker <= 0 || victim <= 0 || attacker == victim)
    {
        return;
    }
    int slot = ClientRosterSlot(attacker);
    if (slot >= 0)
    {
        int damage = event.GetInt("dmg_health");
        g_Damage[slot] += damage;
        char weapon[64];
        event.GetString("weapon", weapon, sizeof(weapon));
        JsonSafeToken(weapon, sizeof(weapon));
        if (IsUtilityWeapon(weapon))
        {
            g_UtilityDamage[slot] += damage;
        }
        char attackerSteamId[32];
        char victimSteamId[32];
        SteamIdForClient(attacker, attackerSteamId, sizeof(attackerSteamId));
        SteamIdForClient(victim, victimSteamId, sizeof(victimSteamId));
        char payload[384];
        Format(payload, sizeof(payload),
            "{\"attackerSteamId\":\"%s\",\"victimSteamId\":\"%s\",\"damage\":%d,\"health\":%d,\"weapon\":\"%s\"}",
            attackerSteamId, victimSteamId, damage, event.GetInt("health"), weapon);
        EmitEvent("player.damaged", payload);
    }
}

public void EventPlayerDeath(Event event, const char[] name, bool dontBroadcast)
{
    if (g_State != MatchState_Live)
    {
        return;
    }
    int victimSlot = ClientRosterSlot(GetClientOfUserId(event.GetInt("userid")));
    int attackerSlot = ClientRosterSlot(GetClientOfUserId(event.GetInt("attacker")));
    int assisterSlot = ClientRosterSlot(GetClientOfUserId(event.GetInt("assister")));
    if (victimSlot < 0 && attackerSlot < 0 && assisterSlot < 0)
    {
        return;
    }
    if (victimSlot >= 0)
    {
        g_Deaths[victimSlot]++;
        if (!g_RoundHasOpeningKill)
        {
            g_OpeningDeaths[victimSlot]++;
        }
    }
    if (attackerSlot >= 0 && attackerSlot != victimSlot)
    {
        g_Kills[attackerSlot]++;
        g_RoundContribution[attackerSlot] = true;
        if (!g_RoundHasOpeningKill)
        {
            g_OpeningKills[attackerSlot]++;
        }
    }
    if (assisterSlot >= 0 && assisterSlot != attackerSlot)
    {
        g_Assists[assisterSlot]++;
        g_RoundContribution[assisterSlot] = true;
        if (event.GetBool("assistedflash"))
        {
            g_FlashAssists[assisterSlot]++;
        }
    }
    g_RoundHasOpeningKill = true;

    char victimSteamId[32];
    char attackerSteamId[32];
    char assisterSteamId[32];
    SteamIdForClient(GetClientOfUserId(event.GetInt("userid")), victimSteamId, sizeof(victimSteamId));
    SteamIdForClient(GetClientOfUserId(event.GetInt("attacker")), attackerSteamId, sizeof(attackerSteamId));
    SteamIdForClient(GetClientOfUserId(event.GetInt("assister")), assisterSteamId, sizeof(assisterSteamId));
    char weapon[64];
    event.GetString("weapon", weapon, sizeof(weapon));
    JsonSafeToken(weapon, sizeof(weapon));
    // Read the inventory identity from the kill itself. The active weapon can
    // already have changed by this post hook, and loadout slots are not proof
    // of which item was used (especially after pickups or team-side changes).
    char weaponItemId[32];
    char weaponOriginalOwnerSteamId[32];
    event.GetString("weapon_itemid", weaponItemId, sizeof(weaponItemId));
    event.GetString("weapon_originalowner_xuid", weaponOriginalOwnerSteamId, sizeof(weaponOriginalOwnerSteamId));
    DecimalEventIdentity(weaponItemId, 20);
    DecimalEventIdentity(weaponOriginalOwnerSteamId, 17);
    char weaponOwnershipGeneration[24];
    OwnershipGenerationForKill(weaponOriginalOwnerSteamId, weaponItemId, weaponOwnershipGeneration, sizeof(weaponOwnershipGeneration));
    char payload[640];
    Format(payload, sizeof(payload),
        "{\"attackerSteamId\":\"%s\",\"victimSteamId\":\"%s\",\"assisterSteamId\":\"%s\",\"weapon\":\"%s\",\"weaponItemId\":\"%s\",\"weaponOriginalOwnerSteamId\":\"%s\",\"weaponOwnershipGeneration\":\"%s\",\"headshot\":%s,\"flashAssist\":%s}",
        attackerSteamId, victimSteamId, assisterSteamId, weapon,
        weaponItemId, weaponOriginalOwnerSteamId, weaponOwnershipGeneration,
        event.GetBool("headshot") ? "true" : "false",
        event.GetBool("assistedflash") ? "true" : "false");
    EmitEvent("player.killed", payload);
    if (IsDeathmatch() && attackerSlot >= 0 && g_Kills[attackerSlot] >= AFTERTICK_DEATHMATCH_FRAG_LIMIT)
    {
        EndDeathmatch();
    }
}

public void EventRoundEnd(Event event, const char[] name, bool dontBroadcast)
{
    if (g_State != MatchState_Live || IsDeathmatch())
    {
        return;
    }

    char payload[128];
    Format(payload, sizeof(payload), "{\"tScore\":%d,\"ctScore\":%d}",
        CS_GetTeamScore(CS_TEAM_T), CS_GetTeamScore(CS_TEAM_CT));
    EmitEvent("round.ended", payload);
    for (int slot = 0; slot < ActiveRosterSize(); slot++)
    {
        g_RoundsPlayed[slot]++;
        int client = ClientForRosterSlot(slot);
        if (g_RoundContribution[slot] || (client > 0 && IsPlayerAlive(client)))
        {
            g_KastRounds[slot]++;
        }
    }
}

public void EventMatchEnd(Event event, const char[] name, bool dontBroadcast)
{
    if (g_State != MatchState_Live)
    {
        return;
    }

    if (IsDeathmatch())
    {
        EndDeathmatch();
    }
    else
    {
        g_State = MatchState_Ended;
        EmitTerminalEvent("match.ended", CS_GetTeamScore(CS_TEAM_T), CS_GetTeamScore(CS_TEAM_CT));
    }
}

void BeginMatch()
{
    g_State = MatchState_Live;
    EmitEvent("match.live", "{}");
    if (IsDeathmatch())
    {
        ServerCommand("mp_teammates_are_enemies 1");
        ServerCommand("mp_respawn_on_death_t 1");
        ServerCommand("mp_respawn_on_death_ct 1");
        ServerCommand("mp_respawn_immunitytime 2");
        ServerCommand("mp_ignore_round_win_conditions 1");
        // The plugin ends the session when a human reaches 40. Engine fraglimit
        // stays disabled so a backfill bot cannot end a platform match.
        ServerCommand("mp_fraglimit 0");
        ServerCommand("mp_timelimit 10");
        ServerCommand("mp_roundtime 10");
        ServerCommand("mp_roundtime_defuse 10");
        ServerCommand("bot_quota_mode fill");
        ServerCommand("bot_quota %d", AFTERTICK_DEATHMATCH_SIZE);
        ServerCommand("bot_auto_vacate 1");
        ServerCommand("bot_join_after_player 0");
        CreateTimer(float(AFTERTICK_DEATHMATCH_TIME_LIMIT), TimerDeathmatchLimit, _, TIMER_FLAG_NO_MAPCHANGE);
    }
    else
    {
        ServerCommand("mp_teammates_are_enemies 0");
        ServerCommand("mp_respawn_on_death_t 0");
        ServerCommand("mp_respawn_on_death_ct 0");
        ServerCommand("mp_ignore_round_win_conditions 0");
        ServerCommand("mp_fraglimit 0");
        ServerCommand("mp_timelimit 0");
    }
    ServerCommand("mp_warmup_end");
    ServerCommand("mp_restartgame 1");
}

public Action TimerDeathmatchLimit(Handle timer)
{
    if (g_State == MatchState_Live && IsDeathmatch())
    {
        EndDeathmatch();
    }
    return Plugin_Stop;
}

void EndDeathmatch()
{
    if (g_State != MatchState_Live)
    {
        return;
    }
    int top = 0;
    int second = 0;
    for (int slot = 0; slot < ActiveRosterSize(); slot++)
    {
        if (g_Kills[slot] >= top)
        {
            second = top;
            top = g_Kills[slot];
        }
        else if (g_Kills[slot] > second)
        {
            second = g_Kills[slot];
        }
    }
    g_State = MatchState_Ended;
    EmitTerminalEvent("match.ended", top, second);
    ServerCommand("mp_pause_match");
}

void PrepareMatch()
{
    RefreshOwnershipGenerations();
    g_DeathmatchEmptyGeneration++;
    LoadRosterAndResetStats();
    g_State = MatchState_Warmup;
    g_WarmupStartedAt = GetTime();
    EmitEvent("match.warmup", "{}");
    CreateTimer(1.0, TimerCheckRoster, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
    if (IsDeathmatch())
    {
        CreateTimer(1.0, TimerRebalanceDeathmatchBots, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
        CreateTimer(
            float(g_DeathmatchEmptySeconds.IntValue),
            TimerAbortEmptyDeathmatch,
            g_DeathmatchEmptyGeneration,
            TIMER_FLAG_NO_MAPCHANGE
        );
    }
}

void LoadRosterAndResetStats()
{
    char alpha[5][32];
    char bravo[5][32];
    char ffa[AFTERTICK_DEATHMATCH_SIZE][32];
    char roster[512];
    if (IsDeathmatch())
    {
        g_RosterFfa.GetString(roster, sizeof(roster));
        ExplodeString(roster, ",", ffa, sizeof(ffa), sizeof(ffa[]));
    }
    else
    {
        g_RosterT.GetString(roster, sizeof(roster));
        ExplodeString(roster, ",", alpha, sizeof(alpha), sizeof(alpha[]));
        g_RosterCt.GetString(roster, sizeof(roster));
        ExplodeString(roster, ",", bravo, sizeof(bravo), sizeof(bravo[]));
    }
    for (int slot = 0; slot < AFTERTICK_ROSTER_SIZE; slot++)
    {
        if (IsDeathmatch())
        {
            strcopy(g_SteamIds[slot], sizeof(g_SteamIds[]), slot < AFTERTICK_DEATHMATCH_SIZE ? ffa[slot] : "");
        }
        else if (slot < 5)
        {
            strcopy(g_SteamIds[slot], sizeof(g_SteamIds[]), alpha[slot]);
        }
        else if (slot < AFTERTICK_COMPETITIVE_SIZE)
        {
            strcopy(g_SteamIds[slot], sizeof(g_SteamIds[]), bravo[slot - 5]);
        }
        else
        {
            g_SteamIds[slot][0] = '\0';
        }
        TrimString(g_SteamIds[slot]);
        g_Kills[slot] = 0;
        g_Deaths[slot] = 0;
        g_Assists[slot] = 0;
        g_Damage[slot] = 0;
        g_RoundsPlayed[slot] = 0;
        g_KastRounds[slot] = 0;
        g_OpeningKills[slot] = 0;
        g_OpeningDeaths[slot] = 0;
        g_FlashAssists[slot] = 0;
        g_UtilityDamage[slot] = 0;
        g_RoundContribution[slot] = false;
        g_WasAdmitted[slot] = false;
        g_XpPresented[slot] = false;
        g_DropPresented[slot] = false;
        g_DisconnectedAt[slot] = 0;
    }
}

int RosterSlot(const char[] steamId)
{
    for (int slot = 0; slot < AFTERTICK_ROSTER_SIZE; slot++)
    {
        if (StrEqual(g_SteamIds[slot], steamId, false))
        {
            return slot;
        }
    }
    return -1;
}

int ClientRosterSlot(int client)
{
    if (client <= 0 || !IsClientConnected(client) || IsFakeClient(client))
    {
        return -1;
    }
    char steamId[32];
    return GetClientAuthId(client, AuthId_SteamID64, steamId, sizeof(steamId), true)
        ? RosterSlot(steamId) : -1;
}

int ClientForRosterSlot(int rosterSlot)
{
    for (int client = 1; client <= MaxClients; client++)
    {
        if (ClientRosterSlot(client) == rosterSlot)
        {
            return client;
        }
    }
    return 0;
}

bool SteamIdForClient(int client, char[] output, int maxLength)
{
    output[0] = '\0';
    if (client <= 0 || !IsClientConnected(client) || IsFakeClient(client))
    {
        return false;
    }
    return GetClientAuthId(client, AuthId_SteamID64, output, maxLength, true);
}

void JsonSafeToken(char[] value, int maxLength)
{
    ReplaceString(value, maxLength, "\"", "");
}

void DecimalEventIdentity(char[] value, int maxDigits)
{
    int length = strlen(value);
    if (length < 1 || length > maxDigits || value[0] == '0')
    {
        value[0] = '\0';
        return;
    }
    for (int index = 0; index < length; index++)
    {
        if (value[index] < '0' || value[index] > '9')
        {
            value[0] = '\0';
            return;
        }
    }
}

bool IsUtilityWeapon(const char[] weapon)
{
    return StrEqual(weapon, "hegrenade", false)
        || StrEqual(weapon, "inferno", false)
        || StrEqual(weapon, "molotov", false)
        || StrEqual(weapon, "incgrenade", false);
}

void EmitTerminalEvent(const char[] eventName, int alphaScore, int bravoScore)
{
    // SourceMod's formatted file writes have a practical line-size ceiling.
    // Use a versioned positional tuple to keep every stat line in one valid
    // JSON record: steam, K, D, A, damage, rounds, KAST rounds, OK, OD,
    // trades, clutches, flash assists, utility damage.
    char payload[4096];
    Format(payload, sizeof(payload), "{\"tScore\":%d,\"ctScore\":%d,\"stats\":[", alphaScore, bravoScore);
    for (int slot = 0; slot < ActiveRosterSize(); slot++)
    {
        char entry[256];
        Format(entry, sizeof(entry),
            "%s[\"%s\",%d,%d,%d,%d,%d,%d,%d,%d,0,0,%d,%d]",
            slot == 0 ? "" : ",", g_SteamIds[slot], g_Kills[slot], g_Deaths[slot],
            g_Assists[slot], g_Damage[slot], g_RoundsPlayed[slot], g_KastRounds[slot],
            g_OpeningKills[slot], g_OpeningDeaths[slot],
            g_FlashAssists[slot], g_UtilityDamage[slot]);
        StrCat(payload, sizeof(payload), entry);
    }
    StrCat(payload, sizeof(payload), "]}");
    EmitEvent(eventName, payload);
}

bool ConfiguredRosterIsValid()
{
    char matchId[64];
    g_MatchId.GetString(matchId, sizeof(matchId));
    if (matchId[0] == '\0')
    {
        return false;
    }
    return IsDeathmatch()
        ? CountRosterEntries(g_RosterFfa) >= 1
            && CountRosterEntries(g_RosterFfa) <= AFTERTICK_DEATHMATCH_SIZE
        : CountRosterEntries(g_RosterT) == 5 && CountRosterEntries(g_RosterCt) == 5;
}

int CountRosterEntries(ConVar rosterConVar)
{
    char roster[512];
    char entries[AFTERTICK_DEATHMATCH_SIZE][32];
    rosterConVar.GetString(roster, sizeof(roster));
    if (roster[0] == '\0')
    {
        return 0;
    }
    return ExplodeString(roster, ",", entries, sizeof(entries), sizeof(entries[]));
}

int RosterTeam(const char[] steamId)
{
    if (IsDeathmatch() && RosterContains(g_RosterFfa, steamId))
    {
        return CS_TEAM_T;
    }
    if (RosterContains(g_RosterT, steamId))
    {
        return CS_TEAM_T;
    }
    if (RosterContains(g_RosterCt, steamId))
    {
        return CS_TEAM_CT;
    }
    return CS_TEAM_NONE;
}

bool RosterContains(ConVar rosterConVar, const char[] steamId)
{
    char roster[512];
    char entries[AFTERTICK_DEATHMATCH_SIZE][32];
    rosterConVar.GetString(roster, sizeof(roster));
    int count = ExplodeString(roster, ",", entries, sizeof(entries), sizeof(entries[]));
    for (int i = 0; i < count; i++)
    {
        TrimString(entries[i]);
        if (StrEqual(entries[i], steamId, false))
        {
            return true;
        }
    }
    return false;
}

int CountConnectedRoster(int team)
{
    int count = 0;
    for (int client = 1; client <= MaxClients; client++)
    {
        if (!IsClientConnected(client) || IsFakeClient(client))
        {
            continue;
        }
        char steamId[32];
        if (GetClientAuthId(client, AuthId_SteamID64, steamId, sizeof(steamId), true)
            && RosterTeam(steamId) == team)
        {
            count++;
        }
    }
    return count;
}

void EmitClientEvent(const char[] eventName, const char[] steamId)
{
    char safeSteamId[32];
    strcopy(safeSteamId, sizeof(safeSteamId), steamId);
    ReplaceString(safeSteamId, sizeof(safeSteamId), "\"", "");
    char payload[96];
    Format(payload, sizeof(payload), "{\"steamId\":\"%s\"}", safeSteamId);
    EmitEvent(eventName, payload);
}

void EmitParticipationViolation(
    const char[] eventName,
    int slot,
    int absenceStartedAt,
    int graceSeconds
)
{
    char payload[256];
    char team[16];
    if (IsDeathmatch())
    {
        strcopy(team, sizeof(team), "ffa");
    }
    else
    {
        strcopy(team, sizeof(team), slot < 5 ? "alpha" : "bravo");
    }
    Format(payload, sizeof(payload),
        "{\"policyVersion\":1,\"steamId\":\"%s\",\"team\":\"%s\",\"absenceStartedAt\":%d,\"graceSeconds\":%d}",
        g_SteamIds[slot], team, absenceStartedAt, graceSeconds);
    EmitEvent(eventName, payload);
}

// SMAC is an optional runtime dependency. SourceMod discovers this public
// forward by name when the pinned evidence-only modules are installed.
public Action SMAC_OnCheatDetected(int client, const char[] module, int detectionType, Handle info)
{
    if ((g_State != MatchState_Warmup && g_State != MatchState_Live)
        || !IsClientInGame(client)
        || IsFakeClient(client))
    {
        return Plugin_Continue;
    }

    char steamId[32];
    if (!GetClientAuthId(client, AuthId_SteamID64, steamId, sizeof(steamId), true)
        || RosterSlot(steamId) < 0)
    {
        return Plugin_Continue;
    }

    char safeModule[64];
    strcopy(safeModule, sizeof(safeModule), module);
    ReplaceString(safeModule, sizeof(safeModule), "\"", "");
    ReplaceString(safeModule, sizeof(safeModule), "\\", "");

    EmitAntiCheatSignal(steamId, safeModule, detectionType, false);

    // Continue lets SMAC write its detailed server log. All loaded B2G modules
    // are configured without automatic bans, and no punitive modules ship.
    return Plugin_Continue;
}

void EmitAntiCheatSignal(const char[] steamId, const char[] module, int detectionType, bool synthetic)
{
    char mode[32];
    g_Mode.GetString(mode, sizeof(mode));
    char payload[320];
    Format(payload, sizeof(payload),
        "{\"policyVersion\":1,\"steamId\":\"%s\",\"module\":\"%s\",\"detectionType\":%d,\"mode\":\"%s\",\"automaticAction\":false,\"synthetic\":%s}",
        steamId, module, detectionType, mode, synthetic ? "true" : "false");
    EmitEvent("anticheat.signal", payload);
}

bool IsDeathmatch()
{
    char mode[32];
    g_Mode.GetString(mode, sizeof(mode));
    return StrEqual(mode, "deathmatch", false);
}

int ActiveRosterSize()
{
    return IsDeathmatch() ? LoadedRosterSize() : AFTERTICK_COMPETITIVE_SIZE;
}

int LoadedRosterSize()
{
    int count = 0;
    for (int slot = 0; slot < AFTERTICK_ROSTER_SIZE; slot++)
    {
        if (g_SteamIds[slot][0] == '\0')
        {
            break;
        }
        count++;
    }
    return count;
}

void EmitEvent(const char[] eventName, const char[] payload)
{
    char matchId[64];
    g_MatchId.GetString(matchId, sizeof(matchId));
    File eventLog = OpenFile(g_EventPath, "a");
    if (eventLog == null)
    {
        LogError("Could not open Aftertick event log: %s", g_EventPath);
        return;
    }
    eventLog.WriteLine("{\"version\":1,\"timestamp\":%d,\"matchId\":\"%s\",\"type\":\"%s\",\"payload\":%s}",
        GetTime(), matchId, eventName, payload);
    delete eventLog;
}
