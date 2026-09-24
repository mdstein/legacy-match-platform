#include "panorama_patch.h"
#include "panorama_popup_lifetime.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <string>
#include <string_view>
#ifdef PANORAMA_PATCH_TESTING
#include <iostream>
#endif

namespace
{

constexpr uint32_t ZipLocalHeader = 0x04034b50;
constexpr uint32_t ZipCentralHeader = 0x02014b50;
constexpr size_t LocalHeaderSize = 30;
constexpr size_t CentralHeaderSize = 46;

constexpr std::array<std::string_view, 10> TargetNames{
    "panorama\\layout\\mainmenu_play.xml",
    "panorama\\scripts\\mainmenu_play.js",
    "panorama\\scripts\\mainmenu.js",
    "panorama\\scripts\\endofmatch-drops.js",
    "panorama\\scripts\\playercard.js",
    "panorama\\scripts\\popups\\popup_capability_decodable.js",
    "panorama\\scripts\\popups\\popup_inspect_async-bar.js",
    "panorama\\scripts\\endofmatch-rank.js",
    "panorama\\scripts\\tooltips\\tooltip_player_xp.js",
    "panorama\\scripts\\tooltips\\tooltip_title_progressbar.js",
};

// These are the CRC-32 values of the ten unmodified entries in AppID 4465480's
// final September 2023 code.pbin. The DLL and every target entry are pinned so an
// unknown client archive is never modified.
constexpr std::array<uint32_t, 10> FinalEntryCrcs{
    0xf05e84ae,
    0x81918063,
    0x219d9dd1,
    0x31b53cfe,
    0x1eb77cc5,
    0x453d1476,
    0xdf20c17d,
    0x8a36c580,
    0x726bb83b,
    0x5dba4ae7,
};

constexpr std::string_view OnlineDropdownLine =
    "\t\t\t\t\t\t<Label text=\"#play_setting_online\" id=\"Play-official\" data-type=\"official\" value=\"1\"/>";
constexpr std::string_view OfflineDropdownLine =
    "\t\t\t\t\t\t<Label text=\"#play_setting_offline\" id=\"Play-listen\" data-type=\"listen\" value=\"2\"/>";
constexpr std::string_view OriginalLicenseCondition =
    "if ( playType === 'listen' || playType === 'training' || playType === 'workshop' )";
constexpr std::string_view B2GLicenseCondition =
    "if ( [ 'official', 'listen', 'training', 'workshop' ].includes( playType ) )";
constexpr std::string_view PrimePanelSetup =
    "\t\tvar elPrimePanel = $( '#PrimeStatusPanel' );\r\n"
    "\t\tvar elGetPrimeBtn = $( '#id-play-menu-get-prime' );\r\n"
    "\t\tvar elTooglePrimeBtn = $( '#id-play-menu-toggle-prime' );\r\n"
    "\t\tvar elPrimeText = $('#PrimeStatusLabelContainer');\r\n"
    "\t\tvar elTextNA = $('#PrimeStatusLabelNA');\r\n"
    "\t\tvar isPrime = ( !m_challengeKey && m_serverPrimeSetting ) ? true : false;";
constexpr std::string_view B2GPrimePanelSetup =
    "\t\tvar elPrimePanel = $( '#PrimeStatusPanel' );\r\n"
    "\t\telPrimePanel.visible = false;\r\n"
    "\t\treturn;";
constexpr std::string_view PrimePreference =
    "var primePreference = m_serverPrimeSetting;";
constexpr std::string_view B2GPrimePreference =
    "var primePreference = 0;";
constexpr std::string_view LegacyWarningCall = "_ShowLegacyVersionWarning();";
constexpr std::string_view OriginalServiceDropLabel =
    "$.Localize( \"#elevated_status_ad_drop\" )";
constexpr std::string_view B2GServiceDropLabel = "\"B2G Service Drop\"";
constexpr std::string_view OriginalXpPanelShutdown =
    "\t\telRank.AddClass( 'hidden' );\r\n"
    "\t\treturn;";
constexpr std::string_view B2GXpPanelRestore =
    "\t\telRank.RemoveClass( 'hidden' );";
constexpr std::string_view OriginalSkillGroupShutdown =
    "\t\telSkillGroupContainer.AddClass( 'hidden' );\r\n"
    "\t\treturn;";
constexpr std::string_view B2GSkillGroupRestore =
    "\t\telSkillGroupContainer.RemoveClass( 'hidden' );";
constexpr std::string_view OriginalRankPlacementGate = "wins < winsNeededForRank";
constexpr std::string_view B2GRankPlacementGate = "skillGroup < 1";
constexpr std::string_view PrestigeButtonStart = "\t\tvar bPrestigeAvailable =";
constexpr std::string_view FunctionEnd = "\r\n\t};";
constexpr std::string_view B2GPrestigeButton =
    "var p=$.GetContextPanel(),b=p.FindChildInLayoutFile('GetPrestigeButton'),"
    "c=p.FindChildInLayoutFile('GetPrestigeButtonClickable'),r=_m_currentLvl===InventoryAPI.GetMaxLevel();"
    "b.SetHasClass('hidden',!_m_isSelf||!r);c.enabled=r;"
    "c.text=$.Localize('#SFUI_Redeem_Service_Medal');"
    "c.SetPanelEvent('onactivate',_OnActivateGetPrestigeButtonClickable);\r\n\t};";
constexpr std::string_view PrestigeResponseStart = "\tvar _OnInventoryPrestigeCoinResponse =";
constexpr std::string_view B2GPrestigeResponse =
    "var _OnInventoryPrestigeCoinResponse=function(d,u,h,t){_OnEventToClose();"
    "if(!d){UiToolkitAPI.ShowGenericPopupOk('Service medal unavailable',"
    "['Keep B2G open; saved claims sync automatically. Reopen the preview.',"
    "'Reach level 40 for your next medal.','Make room in your B2G inventory.',"
    "'All available medal tiers redeemed.'][h||0],"
    "'',function(){},function(){});return;}if(m_worktype==='prestigecheck'){"
    "UiToolkitAPI.ShowCustomLayoutPopupParameters('','file://{resources}/layout/popups/popup_inventory_inspect.xml',"
    "'itemid='+InventoryAPI.GetFauxItemIDFromDefAndPaintIndex(d,0)+'&asyncworkitemwarning=no&asyncworktype='"
    "+(u==='0'?'prestigeget':'prestigeupgrade'));}else if(u!=='0'){InventoryAPI.AcknowledgeNewItembyItemID(u);"
    "InventoryAPI.SetItemSessionPropertyValue(u,'recent','1');$.DispatchEvent('InventoryItemPreview',u);}};";
constexpr std::string_view PrestigeAcceptStart = "\tvar _OnAccept =";
constexpr std::string_view B2GPrestigeAccept =
    "var _OnAccept=function(p,g,c){if(m_scheduleHandle){$.CancelScheduled(m_scheduleHandle);m_scheduleHandle=null;}"
    "p.FindChildInLayoutFile('NameableSpinner').RemoveClass('hidden');"
    "p.FindChildInLayoutFile('AsyncItemWorkAcceptConfirm').AddClass('hidden');"
    "m_scheduleHandle=$.Schedule(m_worktype.indexOf('prestige')===0?45:5,_CancelWaitforCallBack.bind(undefined,p));"
    "_PerformAsyncAction(g,c);};";
constexpr std::string_view PrestigeTimeoutStart = "\tvar _CancelWaitforCallBack =";
constexpr std::string_view B2GPrestigeTimeout =
    "var _CancelWaitforCallBack=function(p){m_scheduleHandle=null;_ClosePopup();var b=m_worktype.indexOf('prestige')===0;"
    "UiToolkitAPI.ShowGenericPopupOk(b?'Service medal pending':$.Localize('#SFUI_SteamConnectionErrorTitle'),"
    "b?'Keep B2G open. A sent claim may still complete; saved medals sync automatically.':"
    "$.Localize('#SFUI_InvError_Item_Not_Given'),'',function(){},function(){});};";
constexpr std::string_view OriginalKeylessCaseCondition =
    "if ( ( associatedItemCount === 0 || !associatedItemCount ) && !m_storeItemId )";
constexpr std::string_view B2GKeylessCaseCondition =
    "if ( m_caseId.length>18||!associatedItemCount&&!m_storeItemId )";
constexpr std::string_view MapGroupsStart =
    "\tfunction _GetAvailableMapGroups( gameMode, isPlayingOnValveOfficial )\r\n"
    "\t{\r\n";
constexpr std::string_view MapGroupsEnd =
    "\t\t\treturn Object.keys( mapgroup );\r\n"
    "\t\t}";
constexpr std::string_view B2GMapGroups =
    "\tfunction _GetAvailableMapGroups(gameMode,isPlayingOnValveOfficial){\r\n"
    "\t\tvar mapgroup=isPlayingOnValveOfficial&&gameMode==='competitive'?{mg_lobby_mapveto:1}:"
    "isPlayingOnValveOfficial&&gameMode==='deathmatch'?{mg_de_dust2:1}:isPlayingOnValveOfficial?"
    "m_gameModeConfigs[gameMode].mapgroupsMP:m_gameModeConfigs[gameMode].mapgroupsSP;\r\n"
    "\t\tif(mapgroup)return Object.keys(mapgroup);";
constexpr std::string_view NoMapSelectionStart =
    "\t\t\tif ( !_CheckContainerHasAnyChildChecked( _GetMapListForServerTypeAndGameMode( m_activeMapGroupSelectionPanelID ) ) )\r\n";
constexpr std::string_view NoMapSelectionEnd =
    "\t\t\t\treturn;\r\n"
    "\t\t\t}";
constexpr std::string_view B2GNoMapSelection =
    "\t\t\tif(!(m_serverSetting==='official'&&m_gameModeSetting==='deathmatch')&&"
    "!_CheckContainerHasAnyChildChecked(_GetMapListForServerTypeAndGameMode("
    "m_activeMapGroupSelectionPanelID))){_NoMapSelectedPopup();"
    "return;}";
constexpr std::string_view GameModeSyncStart =
    "\t\t\tfor ( var i = 0; i < m_arrGameModeRadios.length; ++i )\r\n";
constexpr std::string_view GameModeSyncEnd =
    "\t\t\t\tvar isAvailable = _IsGameModeAvailable( m_serverSetting, strGameModeForButton );";
constexpr std::string_view B2GGameModeSync =
    "\t\t\tvar b2gOfficial=m_serverSetting==='official';"
    "if(b2gOfficial&&m_gameModeSetting!=='competitive'&&m_gameModeSetting!=='deathmatch')"
    "m_gameModeSetting='competitive';"
    "var quick=$('#JsQuickSelectParent');if(quick)quick.visible=!b2gOfficial;\r\n"
    "\t\t\tfor(var i=0;i<m_arrGameModeRadios.length;++i)\r\n"
    "\t\t\t{\r\n"
    "\t\t\t\tvar entry=m_arrGameModeRadios[i];\r\n"
    "\t\t\t\tvar strGameModeForButton=entry.id;\r\n"
    "\t\t\t\tvar b2gMode=strGameModeForButton==='competitive'||strGameModeForButton==='deathmatch';\r\n"
    "\t\t\t\tentry.visible=!b2gOfficial||b2gMode;\r\n"
    "\t\t\t\tif(b2gOfficial){entry.checked=b2gMode&&strGameModeForButton===m_gameModeSetting;"
    "if(!b2gMode){entry.enabled=false;continue;}}\r\n"
    "\t\t\t\tvar isAvailable=_IsGameModeAvailable(m_serverSetting,strGameModeForButton);";
constexpr std::string_view ApplySettingsStart = "\t\tif ( !LobbyAPI.BIsHost() )\r\n";
constexpr std::string_view ApplySettingsEnd = "\t\tvar serverType = m_serverSetting;";
constexpr std::string_view B2GApplySettings =
    "\t\tif(!LobbyAPI.BIsHost())return;\r\n"
    "\t\tif(m_serverSetting==='official'){m_isWorkshop=false;"
    "if(m_gameModeSetting!=='competitive'&&m_gameModeSetting!=='deathmatch')"
    "m_gameModeSetting='competitive';}\r\n"
    "\t\t_ValidateSessionSettings();\r\n\r\n"
    "\t\tvar serverType = m_serverSetting;";
constexpr std::string_view MapTileStart = "\t\tvar mg = GetMGDetails( mapGroupName );";
constexpr std::string_view MapTileEnd = "\t\tif ( !p )";
constexpr std::string_view B2GMapTileSetup =
    "\t\tvar mg=GetMGDetails(mapGroupName);if(!mg)return;\r\n"
    "\t\tvar p=elTilePanel;\r\n\r\n"
    "\t\tif ( !p )";

static_assert(B2GLicenseCondition.size() <= OriginalLicenseCondition.size());
static_assert(B2GPrimePanelSetup.size() <= PrimePanelSetup.size());
static_assert(B2GPrimePreference.size() <= PrimePreference.size());
static_assert(B2GServiceDropLabel.size() <= OriginalServiceDropLabel.size());
static_assert(B2GXpPanelRestore.size() <= OriginalXpPanelShutdown.size());
static_assert(B2GSkillGroupRestore.size() <= OriginalSkillGroupShutdown.size());
static_assert(B2GRankPlacementGate.size() <= OriginalRankPlacementGate.size());
static_assert(B2GKeylessCaseCondition.size() <= OriginalKeylessCaseCondition.size());

struct ZipEntry
{
    size_t localHeader{};
    size_t centralHeader{};
    size_t data{};
    size_t size{};
};

struct Replacement
{
    size_t entry{};
    size_t offset{};
    size_t length{};
    std::string_view value;
};

uint16_t Read16(const uint8_t *data)
{
    uint16_t value{};
    memcpy(&value, data, sizeof(value));
    return value;
}

uint32_t Read32(const uint8_t *data)
{
    uint32_t value{};
    memcpy(&value, data, sizeof(value));
    return value;
}

void Write32(uint8_t *data, uint32_t value)
{
    memcpy(data, &value, sizeof(value));
}

uint32_t Crc32(const uint8_t *data, size_t size)
{
    uint32_t crc = 0xffffffff;
    for (size_t index = 0; index < size; ++index)
    {
        crc ^= data[index];
        for (int bit = 0; bit < 8; ++bit)
        {
            const uint32_t mask = 0u - (crc & 1u);
            crc = (crc >> 1) ^ (0xedb88320u & mask);
        }
    }
    return ~crc;
}

bool RangeFits(size_t offset, size_t length, size_t size)
{
    return offset <= size && length <= size - offset;
}

bool NameMatches(const uint8_t *buffer, size_t size, size_t nameOffset,
    uint16_t nameLength, std::string_view expected)
{
    return nameLength == expected.size()
        && RangeFits(nameOffset, nameLength, size)
        && memcmp(buffer + nameOffset, expected.data(), expected.size()) == 0;
}

bool FindEntry(uint8_t *buffer, size_t archiveSize, std::string_view name,
    uint32_t expectedCrc, ZipEntry &entry)
{
    size_t localMatches = 0;
    for (size_t offset = 0; RangeFits(offset, LocalHeaderSize, archiveSize); ++offset)
    {
        if (Read32(buffer + offset) != ZipLocalHeader)
        {
            continue;
        }
        const uint16_t method = Read16(buffer + offset + 8);
        const uint32_t crc = Read32(buffer + offset + 14);
        const uint32_t compressedSize = Read32(buffer + offset + 18);
        const uint32_t uncompressedSize = Read32(buffer + offset + 22);
        const uint16_t nameLength = Read16(buffer + offset + 26);
        const uint16_t extraLength = Read16(buffer + offset + 28);
        const size_t nameOffset = offset + LocalHeaderSize;
        if (!NameMatches(buffer, archiveSize, nameOffset, nameLength, name))
        {
            continue;
        }
        const size_t dataOffset = nameOffset + nameLength + extraLength;
        if (method != 0 || compressedSize != uncompressedSize
            || !RangeFits(dataOffset, uncompressedSize, archiveSize)
            || crc != expectedCrc
            || Crc32(buffer + dataOffset, uncompressedSize) != expectedCrc)
        {
            return false;
        }
        entry.localHeader = offset;
        entry.data = dataOffset;
        entry.size = uncompressedSize;
        ++localMatches;
    }

    size_t centralMatches = 0;
    for (size_t offset = 0; RangeFits(offset, CentralHeaderSize, archiveSize); ++offset)
    {
        if (Read32(buffer + offset) != ZipCentralHeader)
        {
            continue;
        }
        const uint16_t method = Read16(buffer + offset + 10);
        const uint32_t crc = Read32(buffer + offset + 16);
        const uint32_t compressedSize = Read32(buffer + offset + 20);
        const uint32_t uncompressedSize = Read32(buffer + offset + 24);
        const uint16_t nameLength = Read16(buffer + offset + 28);
        const size_t nameOffset = offset + CentralHeaderSize;
        if (!NameMatches(buffer, archiveSize, nameOffset, nameLength, name))
        {
            continue;
        }
        if (method != 0 || compressedSize != entry.size || uncompressedSize != entry.size
            || crc != expectedCrc)
        {
            return false;
        }
        entry.centralHeader = offset;
        ++centralMatches;
    }
    return localMatches == 1 && centralMatches == 1;
}

size_t FindUnique(const uint8_t *data, size_t size, std::string_view value)
{
    if (value.empty() || value.size() > size)
    {
        return std::string_view::npos;
    }
    const auto *first = std::search(data, data + size, value.begin(), value.end());
    if (first == data + size)
    {
        return std::string_view::npos;
    }
    const auto *second = std::search(first + value.size(), data + size,
        value.begin(), value.end());
    return second == data + size ? static_cast<size_t>(first - data) : std::string_view::npos;
}

bool PlanDropdownPatch(size_t entry, const uint8_t *data, size_t size,
    Replacement &replacement)
{
    const size_t offline = FindUnique(data, size, OfflineDropdownLine);
    if (offline == std::string_view::npos || offline < 2)
    {
        return false;
    }
    size_t blankEnd = offline;
    while (blankEnd && (data[blankEnd - 1] == '\r' || data[blankEnd - 1] == '\n'))
    {
        --blankEnd;
    }
    size_t blankStart = blankEnd;
    while (blankStart && data[blankStart - 1] != '\n')
    {
        --blankStart;
    }
    if (blankEnd - blankStart < OnlineDropdownLine.size()
        || !std::all_of(data + blankStart, data + blankEnd,
            [](uint8_t character) { return character == ' ' || character == '\t'; }))
    {
        return false;
    }
    replacement = { entry, blankStart, blankEnd - blankStart, OnlineDropdownLine };
    return true;
}

bool PlanExactPatch(size_t entry, const uint8_t *data, size_t size,
    std::string_view original, std::string_view replacementValue, Replacement &replacement)
{
    const size_t offset = FindUnique(data, size, original);
    if (offset == std::string_view::npos || replacementValue.size() > original.size())
    {
        return false;
    }
    replacement = { entry, offset, original.size(), replacementValue };
    return true;
}

bool PlanRangePatch(size_t entry, const uint8_t *data, size_t size,
    std::string_view start, std::string_view end, std::string_view replacementValue,
    Replacement &replacement)
{
    const size_t startOffset = FindUnique(data, size, start);
    if (startOffset == std::string_view::npos)
    {
#ifdef PANORAMA_PATCH_TESTING
        std::cerr << "missing range start for entry " << entry << '\n';
#endif
        return false;
    }
    const auto *endFirst = std::search(data + startOffset + start.size(), data + size,
        end.begin(), end.end());
    if (endFirst == data + size)
    {
#ifdef PANORAMA_PATCH_TESTING
        std::cerr << "missing range end for entry " << entry << '\n';
#endif
        return false;
    }
    const auto *endSecond = std::search(endFirst + end.size(), data + size,
        end.begin(), end.end());
    if (endSecond != data + size)
    {
#ifdef PANORAMA_PATCH_TESTING
        std::cerr << "duplicate range end for entry " << entry << '\n';
#endif
        return false;
    }
    const size_t length = static_cast<size_t>(endFirst - (data + startOffset)) + end.size();
    if (replacementValue.size() > length)
    {
#ifdef PANORAMA_PATCH_TESTING
        std::cerr << "replacement too long for entry " << entry
                  << " starting with " << start.substr(0, 40)
                  << ": replacement=" << replacementValue.size()
                  << " range=" << length << '\n';
#endif
        return false;
    }
    replacement = { entry, startOffset, length, replacementValue };
    return true;
}

// Some final-client functions contain several identical block endings.  A
// unique, CRC-pinned start still makes the first following ending deterministic;
// requiring that ending to be globally unique rejected the exact 2023 archive.
bool PlanFirstRangePatch(size_t entry, const uint8_t *data, size_t size,
    std::string_view start, std::string_view end, std::string_view replacementValue,
    Replacement &replacement)
{
    const size_t startOffset = FindUnique(data, size, start);
    if (startOffset == std::string_view::npos)
    {
#ifdef PANORAMA_PATCH_TESTING
        std::cerr << "missing anchored range start for entry " << entry << '\n';
#endif
        return false;
    }
    const auto *endFirst = std::search(data + startOffset + start.size(), data + size,
        end.begin(), end.end());
    if (endFirst == data + size)
    {
#ifdef PANORAMA_PATCH_TESTING
        std::cerr << "missing anchored range end for entry " << entry << '\n';
#endif
        return false;
    }
    const size_t length = static_cast<size_t>(endFirst - (data + startOffset)) + end.size();
    if (replacementValue.size() > length)
    {
#ifdef PANORAMA_PATCH_TESTING
        std::cerr << "anchored replacement too long for entry " << entry << '\n';
#endif
        return false;
    }
    replacement = { entry, startOffset, length, replacementValue };
    return true;
}

bool ReplaceOnce(std::string &script, std::string_view original, std::string_view replacement)
{
    const auto offset = script.find(original);
    if (offset == std::string::npos || script.find(original, offset + original.size()) != std::string::npos)
        return false;
    script.replace(offset, original.size(), replacement);
    return true;
}

size_t ReplaceAll(std::string &script, std::string_view original, std::string_view replacement)
{
    size_t count = 0;
    for (size_t offset = 0; (offset = script.find(original, offset)) != std::string::npos; ++count)
    {
        script.replace(offset, original.size(), replacement);
        offset += replacement.size();
    }
    return count;
}

bool PlanPopupLifetime(std::string &script, bool decodable)
{
    // Reclaim indentation/stripped-comment padding only after exact anchors
    // have been checked. Reject JS forms where leading whitespace is data.
    if (script.find('`') != std::string::npos || script.find("\\\r\n") != std::string::npos
        || script.find("\\\n") != std::string::npos) return false;
    // Rewrite calls before inserting the support code, which must retain the
    // original host APIs. A deferred tournament-journal navigation intentionally
    // survives closing the case popup; only its UI animation work is scoped.
    if (decodable && !ReplaceOnce(script, "$.Schedule( 0.2, function()", "B2GJournalTransition( 0.2, function()"))
        return false;
    if (!ReplaceAll(script, "$.Schedule(", "m_b2g.Schedule(")
        || !ReplaceAll(script, "$.CancelScheduled(", "m_b2g.CancelScheduled(")) return false;
    if (decodable)
    {
        if (!ReplaceOnce(script, "B2GJournalTransition( 0.2, function()", "$.Schedule( 0.2, function()")
            || ReplaceAll(script, "$.RegisterForUnhandledEvent(", "CapabilityDecodable.RegisterEvent(") != 3
            || !ReplaceOnce(script, "Init: _Init,", "RegisterEvent: m_b2g.RegisterForUnhandledEvent,Init: _Init,")
            || !ReplaceOnce(script, "var _ClosePopUp = function()\r\n\t{",
                "var _ClosePopUp = function()\r\n\t{m_b2g.Dispose();")) return false;
    }
    else if (ReplaceAll(script, "$.RegisterForUnhandledEvent(", "m_b2g.RegisterForUnhandledEvent(") != 3
        || !ReplaceOnce(script, "var _ClosePopup = function()\r\n\t{",
            "var _ClosePopup = function()\r\n\t{m_b2g.Dispose();")) return false;
    const std::string_view anchor = decodable
        ? "var CapabilityDecodable = ( function()\r\n{"
        : "var InspectAsyncActionBar = ( function()\r\n{";
    if (!ReplaceOnce(script, anchor, std::string(anchor) + std::string(B2GPopupLifetime))) return false;
    std::string compact;
    for (size_t start = 0; start < script.size();)
    {
        const auto found = script.find('\n', start);
        const auto end = found == std::string::npos ? script.size() : found;
        auto content = start;
        while (content < end && (script[content] == ' ' || script[content] == '\t')) ++content;
        compact.append(script, content, end - content);
        if (found != std::string::npos) compact += '\n';
        start = end + 1;
    }
    script = std::move(compact);
    return true;
}

PanoramaPatchResult PatchPanoramaArchive(void *archive, size_t archiveSize,
    const std::array<uint32_t, 10> &expectedCrcs)
{
    if (!archive || archiveSize < 1024)
    {
        return PanoramaPatchResult::NotPanorama;
    }
    auto *buffer = static_cast<uint8_t *>(archive);
    if (std::search(buffer, buffer + archiveSize, TargetNames[0].begin(), TargetNames[0].end())
        == buffer + archiveSize)
    {
        return PanoramaPatchResult::NotPanorama;
    }

    std::array<ZipEntry, 10> entries{};
    for (size_t index = 0; index < entries.size(); ++index)
    {
        if (!FindEntry(buffer, archiveSize, TargetNames[index], expectedCrcs[index], entries[index]))
        {
            return PanoramaPatchResult::Rejected;
        }
    }

    std::array<Replacement, 23> replacements{};
    if (!PlanDropdownPatch(0, buffer + entries[0].data, entries[0].size, replacements[0])
        || !PlanExactPatch(1, buffer + entries[1].data, entries[1].size,
            OriginalLicenseCondition, B2GLicenseCondition, replacements[1])
        || !PlanExactPatch(1, buffer + entries[1].data, entries[1].size,
            PrimePanelSetup, B2GPrimePanelSetup, replacements[2])
        || !PlanExactPatch(1, buffer + entries[1].data, entries[1].size,
            PrimePreference, B2GPrimePreference, replacements[3])
        || !PlanRangePatch(1, buffer + entries[1].data, entries[1].size,
            MapGroupsStart, MapGroupsEnd, B2GMapGroups, replacements[4])
        || !PlanRangePatch(1, buffer + entries[1].data, entries[1].size,
            GameModeSyncStart, GameModeSyncEnd, B2GGameModeSync, replacements[5])
        || !PlanRangePatch(1, buffer + entries[1].data, entries[1].size,
            ApplySettingsStart, ApplySettingsEnd, B2GApplySettings, replacements[6])
        || !PlanRangePatch(1, buffer + entries[1].data, entries[1].size,
            MapTileStart, MapTileEnd, B2GMapTileSetup, replacements[7])
        || !PlanExactPatch(2, buffer + entries[2].data, entries[2].size,
            LegacyWarningCall, {}, replacements[8])
        || !PlanExactPatch(3, buffer + entries[3].data, entries[3].size,
            OriginalServiceDropLabel, B2GServiceDropLabel, replacements[9])
        || !PlanExactPatch(4, buffer + entries[4].data, entries[4].size,
            OriginalXpPanelShutdown, B2GXpPanelRestore, replacements[10])
        || !PlanExactPatch(4, buffer + entries[4].data, entries[4].size,
            OriginalSkillGroupShutdown, B2GSkillGroupRestore, replacements[11])
        || !PlanExactPatch(4, buffer + entries[4].data, entries[4].size,
            OriginalRankPlacementGate, B2GRankPlacementGate, replacements[12])
        || !PlanExactPatch(5, buffer + entries[5].data, entries[5].size,
            OriginalKeylessCaseCondition, B2GKeylessCaseCondition, replacements[13])
        || !PlanFirstRangePatch(1, buffer + entries[1].data, entries[1].size,
            NoMapSelectionStart, NoMapSelectionEnd, B2GNoMapSelection, replacements[14])
        || !PlanFirstRangePatch(4, buffer + entries[4].data, entries[4].size,
            PrestigeButtonStart, FunctionEnd, B2GPrestigeButton, replacements[15])
        || !PlanFirstRangePatch(6, buffer + entries[6].data, entries[6].size,
            PrestigeResponseStart, FunctionEnd, B2GPrestigeResponse, replacements[16])
        || !PlanFirstRangePatch(6, buffer + entries[6].data, entries[6].size,
            PrestigeAcceptStart, FunctionEnd, B2GPrestigeAccept, replacements[17])
        || !PlanFirstRangePatch(6, buffer + entries[6].data, entries[6].size,
            PrestigeTimeoutStart, FunctionEnd, B2GPrestigeTimeout, replacements[18])
        || !PlanExactPatch(4, buffer + entries[4].data, entries[4].size,
            "MyPersonaAPI.GetXpPerLevel()", "1000", replacements[19])
        || !PlanExactPatch(7, buffer + entries[7].data, entries[7].size,
            "MyPersonaAPI.GetXpPerLevel()", "1000", replacements[20])
        || !PlanExactPatch(8, buffer + entries[8].data, entries[8].size,
            "MyPersonaAPI.GetXpPerLevel()", "1000", replacements[21])
        || !PlanExactPatch(9, buffer + entries[9].data, entries[9].size,
            "MyPersonaAPI.GetXpPerLevel()", "1000", replacements[22]))
    {
        return PanoramaPatchResult::Rejected;
    }

    // Stage every change before touching the archive, including lifecycle
    // rewrites. Any unknown anchor or size mismatch rejects the entire patch.
    std::array<std::string, 10> scripts;
    for (size_t index = 0; index < entries.size(); ++index)
        scripts[index].assign(reinterpret_cast<const char *>(buffer + entries[index].data), entries[index].size);
    for (const Replacement &replacement : replacements)
    {
        auto &script = scripts[replacement.entry];
        script.replace(replacement.offset, replacement.length,
            std::string(replacement.value) + std::string(replacement.length - replacement.value.size(), ' '));
    }
    if (!PlanPopupLifetime(scripts[5], true) || !PlanPopupLifetime(scripts[6], false))
        return PanoramaPatchResult::Rejected;
    for (size_t index = 0; index < entries.size(); ++index)
    {
        if (scripts[index].size() > entries[index].size) return PanoramaPatchResult::Rejected;
    }
    for (size_t index = 0; index < entries.size(); ++index)
    {
        const auto &entry = entries[index];
        memset(buffer + entry.data, ' ', entry.size);
        memcpy(buffer + entry.data, scripts[index].data(), scripts[index].size());
    }
    for (const ZipEntry &entry : entries)
    {
        const uint32_t crc = Crc32(buffer + entry.data, entry.size);
        Write32(buffer + entry.localHeader + 14, crc);
        Write32(buffer + entry.centralHeader + 16, crc);
    }
    return PanoramaPatchResult::Patched;
}

} // namespace

PanoramaPatchResult PatchFinalPanoramaArchive(void *buffer, size_t size)
{
    return PatchPanoramaArchive(buffer, size, FinalEntryCrcs);
}

#ifdef PANORAMA_PATCH_TESTING
PanoramaPatchResult PatchPanoramaArchiveForTests(void *buffer, size_t size,
    const std::array<uint32_t, 10> &expectedCrcs)
{
    return PatchPanoramaArchive(buffer, size, expectedCrcs);
}

uint32_t PanoramaPatchCrc32ForTests(const void *buffer, size_t size)
{
    return buffer ? Crc32(static_cast<const uint8_t *>(buffer), size) : 0;
}
#endif
