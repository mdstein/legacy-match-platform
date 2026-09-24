#include "panorama_patch.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace
{

constexpr std::array<std::string_view, 10> Names{
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

const std::array<std::string, 10> Contents{
    std::string("<DropDown>\r\n")
        + std::string(6, '\t') + std::string(95, ' ') + "\r\n"
        + "\t\t\t\t\t\t<Label text=\"#play_setting_offline\" id=\"Play-listen\" data-type=\"listen\" value=\"2\"/>\r\n"
        + "<RadioButton id='scrimcomp2v2'\r\n\t\t\t\t\t\t\t\tgroup=\"gamemodes\" >\r\n"
        + "<RadioButton id='casual' \r\n\t\t\t\t\t\t\t\tgroup=\"gamemodes\" >\r\n"
        + "<RadioButton id='skirmish'\r\n\t\t\t\t\t\t\t\tgroup=\"gamemodes\" >\r\n"
        + "<RadioButton id='survival'  \r\n\t\t\t\t\t\t\t\tgroup=\"gamemodes\" >\r\n"
        + "<RadioButton id='cooperative'  \r\n\t\t\t\t\t\t\t\tgroup=\"gamemodes\" >\r\n"
        + "<RadioButton id='coopmission'  \r\n\t\t\t\t\t\t\t\tgroup=\"gamemodes\" >\r\n"
        + "<Panel class=\"game-mode-selection-radios-spacer\"></Panel>\r\n"
        + "<Panel id=\"JsQuickSelectParent\" class=\"top-bottom-flow map-selection-list__quick-selection-sets\">\r\n",
    std::string("before if ( playType === 'listen' || playType === 'training' || playType === 'workshop' ) after\r\n")
        + "\t\t\tif ( !_CheckContainerHasAnyChildChecked( _GetMapListForServerTypeAndGameMode( m_activeMapGroupSelectionPanelID ) ) )\r\n"
        + "\t\t\t{\r\n"
        + "\t\t\t\t_NoMapSelectedPopup();\r\n\r\n"
        + "\t\t\t\tbtnStartSearch.RemoveClass( 'pressed' );\r\n\r\n"
        + "\t\t\t\treturn;\r\n"
        + "\t\t\t}\r\n"
        + "\t\tvar elPrimePanel = $( '#PrimeStatusPanel' );\r\n"
        + "\t\tvar elGetPrimeBtn = $( '#id-play-menu-get-prime' );\r\n"
        + "\t\tvar elTooglePrimeBtn = $( '#id-play-menu-toggle-prime' );\r\n"
        + "\t\tvar elPrimeText = $('#PrimeStatusLabelContainer');\r\n"
        + "\t\tvar elTextNA = $('#PrimeStatusLabelNA');\r\n"
        + "\t\tvar isPrime = ( !m_challengeKey && m_serverPrimeSetting ) ? true : false;\r\n"
        + "var primePreference = m_serverPrimeSetting;\r\n"
        + "\tfunction _GetAvailableMapGroups( gameMode, isPlayingOnValveOfficial )\r\n"
        + "\t{\r\n" + std::string(260, ' ')
        + "\t\t\treturn Object.keys( mapgroup );\r\n\t\t}\r\n"
        + "\t\tm_serverSetting = settings.options.server;\r\n"
        + "\t\tm_permissions = settings.system.access;\r\n"
        + "\t\tm_gameModeSetting = settings.game.mode;\r\n"
        + "\t\t_SetDirectChallengeKey( settings.options.hasOwnProperty( 'challengekey' ) ? settings.options.challengekey : '' );\r\n"
        + "\t\tm_isWorkshop = settings.game.mapgroupname\r\n"
        + "\t\t\t&& settings.game.mapgroupname.includes( '@workshop' );\r\n"
        + "\t\t\tfor ( var i = 0; i < m_arrGameModeRadios.length; ++i )\r\n"
        + std::string(800, ' ')
        + "\t\t\t\tvar isAvailable = _IsGameModeAvailable( m_serverSetting, strGameModeForButton );\r\n"
        + "\t\tif ( !LobbyAPI.BIsHost() )\r\n" + std::string(500, ' ')
        + "\t\tvar serverType = m_serverSetting;\r\n"
        + "\t\tvar mg = GetMGDetails( mapGroupName );" + std::string(160, ' ')
        + "\t\tif ( !p )\r\n"
        // The real final-client script contains later blocks with the same
        // generic ending.  The Deathmatch guard must remain anchored to its
        // unique opening condition instead of rejecting the whole archive.
        + "\t\t\t\treturn;\r\n\t\t\t}\r\n",
    "before _ShowLegacyVersionWarning(); after",
    "before $.Localize( \"#elevated_status_ad_drop\" ) after",
    std::string("before MyPersonaAPI.GetXpPerLevel()\r\n")
        + "\t\telRank.AddClass( 'hidden' );\r\n\t\treturn;\r\n"
        + "\t\telSkillGroupContainer.AddClass( 'hidden' );\r\n\t\treturn;\r\n"
        + "if ( wins < winsNeededForRank || isloading )\r\n"
        + "\t\tvar bPrestigeAvailable = true;" + std::string(450, ' ') + "\r\n\t};\r\n"
        + "after",
    std::string("var CapabilityDecodable = ( function()\r\n{\r\n") + std::string(4000, ' ') + "\r\n"
        + "if ( ( associatedItemCount === 0 || !associatedItemCount ) && !m_storeItemId ) {}\r\n"
        + "$.Schedule( 0.2, function() {}); $.Schedule(1,cb); $.CancelScheduled(timer);\r\n"
        + "var _ClosePopUp = function()\r\n\t{}; return {Init: _Init,};})();\r\n"
        + "$.RegisterForUnhandledEvent('one',cb); $.RegisterForUnhandledEvent('two',cb); $.RegisterForUnhandledEvent('three',cb);",
    std::string("var InspectAsyncActionBar = ( function()\r\n{\r\n") + std::string(4000, ' ') + "\r\n"
        + "var _ClosePopup = function()\r\n\t{};\r\n"
        + "$.RegisterForUnhandledEvent('one',cb); $.RegisterForUnhandledEvent('two',cb); $.RegisterForUnhandledEvent('three',cb);\r\n"
        + "\tvar _OnInventoryPrestigeCoinResponse = function() {" + std::string(850, ' ') + "\r\n\t};"
        + "\tvar _OnAccept = function() {" + std::string(550, ' ') + "\r\n\t};"
        + "\tvar _CancelWaitforCallBack = function() {" + std::string(460, ' ') + "\r\n\t};",
    "var xpPerLevel = MyPersonaAPI.GetXpPerLevel();",
    "var pointsPerLevel = MyPersonaAPI.GetXpPerLevel();",
    "pointsPerLevel = MyPersonaAPI.GetXpPerLevel();",
};

void Append16(std::vector<uint8_t> &buffer, uint16_t value)
{
    const auto *bytes = reinterpret_cast<const uint8_t *>(&value);
    buffer.insert(buffer.end(), bytes, bytes + sizeof(value));
}

void Append32(std::vector<uint8_t> &buffer, uint32_t value)
{
    const auto *bytes = reinterpret_cast<const uint8_t *>(&value);
    buffer.insert(buffer.end(), bytes, bytes + sizeof(value));
}

std::vector<uint8_t> Fixture(std::array<uint32_t, 10> &crcs, bool invalidLifetime = false)
{
    auto contents = Contents;
    if (invalidLifetime)
        contents[5].replace(contents[5].find("_ClosePopUp"), 11, "_OtherPopUp");
    std::vector<uint8_t> buffer{ 'P', 'A', 'N', 2, 0, 0, 0, 0 };
    std::array<uint32_t, 10> localOffsets{};
    for (size_t index = 0; index < Names.size(); ++index)
    {
        localOffsets[index] = static_cast<uint32_t>(buffer.size());
        crcs[index] = PanoramaPatchCrc32ForTests(contents[index].data(), contents[index].size());
        Append32(buffer, 0x04034b50);
        Append16(buffer, 20);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append32(buffer, crcs[index]);
        Append32(buffer, static_cast<uint32_t>(contents[index].size()));
        Append32(buffer, static_cast<uint32_t>(contents[index].size()));
        Append16(buffer, static_cast<uint16_t>(Names[index].size()));
        Append16(buffer, 0);
        buffer.insert(buffer.end(), Names[index].begin(), Names[index].end());
        buffer.insert(buffer.end(), contents[index].begin(), contents[index].end());
    }
    for (size_t index = 0; index < Names.size(); ++index)
    {
        Append32(buffer, 0x02014b50);
        Append16(buffer, 20);
        Append16(buffer, 20);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append32(buffer, crcs[index]);
        Append32(buffer, static_cast<uint32_t>(contents[index].size()));
        Append32(buffer, static_cast<uint32_t>(contents[index].size()));
        Append16(buffer, static_cast<uint16_t>(Names[index].size()));
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append16(buffer, 0);
        Append32(buffer, 0);
        Append32(buffer, localOffsets[index]);
        buffer.insert(buffer.end(), Names[index].begin(), Names[index].end());
    }
    buffer.resize(buffer.size() + 1024, 0);
    return buffer;
}

bool Contains(const std::vector<uint8_t> &buffer, std::string_view value)
{
    return std::search(buffer.begin(), buffer.end(), value.begin(), value.end()) != buffer.end();
}

bool ExactArchiveIsPatched()
{
    std::array<uint32_t, 10> crcs{};
    std::vector<uint8_t> buffer = Fixture(crcs);
    const PanoramaPatchResult result = PatchPanoramaArchiveForTests(
        buffer.data(), buffer.size(), crcs);
    if (result != PanoramaPatchResult::Patched)
    {
        std::cerr << "fixture patch result=" << static_cast<int>(result) << '\n';
        return false;
    }
    bool valid = true;
    const auto require = [&buffer, &valid](std::string_view value, bool expected = true) {
        const bool present = Contains(buffer, value);
        if (present != expected)
        {
            std::cerr << "archive assertion failed: " << value << " expected=" << expected << '\n';
            valid = false;
        }
    };
    require("id=\"Play-official\"");
    require("<RadioButton id='casual' ");
    require("<RadioButton id='survival'  ");
    require("<Panel id=\"JsQuickSelectParent\" class=\"top-bottom-flow");
    require("[ 'official', 'listen', 'training', 'workshop' ].includes( playType )");
    require("elPrimePanel.visible = false;");
    require("var primePreference = 0;");
    require("mg_lobby_mapveto:1");
    require("mg_de_dust2:1");
    require("m_serverSetting = settings.options.server");
    require("m_gameModeSetting = settings.game.mode");
    require("quick.visible=!b2gOfficial");
    require("entry.visible=!b2gOfficial||b2gMode");
    require("if(b2gOfficial){entry.checked=b2gMode");
    require("m_gameModeSetting!=='competitive'&&m_gameModeSetting!=='deathmatch'");
    require("m_serverSetting==='official'&&m_gameModeSetting==='deathmatch'");
    require("_NoMapSelectedPopup();return;");
    require("mg.nameID='#SFUI_Deathmatch'", false);
    require("_ShowLegacyVersionWarning();", false);
    require("\"B2G Service Drop\"");
    require("#elevated_status_ad_drop", false);
    require("elRank.RemoveClass( 'hidden' );");
    require("elSkillGroupContainer.RemoveClass( 'hidden' );");
    require("skillGroup < 1");
    require("wins < winsNeededForRank", false);
    require("m_caseId.length>18||!associatedItemCount&&!m_storeItemId");
    require("b.SetHasClass('hidden',!_m_isSelf||!r)");
    require("r=_m_currentLvl===InventoryAPI.GetMaxLevel()");
    require("c.enabled=r");
    require("Service medal unavailable");
    require("Service medal pending");
    require("Make room in your B2G inventory.");
    require("if(!d)");
    require("b2gPopupLifetime");
    require("{m_b2g.Dispose();");
    require("CapabilityDecodable.RegisterEvent(");
    require("m_b2g.Schedule(");
    require("$.UnregisterForUnhandledEvent(event[0],event[1])");
    return valid;
}

bool RejectionIsTransactional()
{
    std::array<uint32_t, 10> crcs{};
    std::vector<uint8_t> buffer = Fixture(crcs);
    const auto position = std::search(buffer.begin(), buffer.end(), Contents[2].begin(), Contents[2].end());
    if (position == buffer.end())
    {
        return false;
    }
    *position ^= 1;
    const std::vector<uint8_t> before = buffer;
    return PatchPanoramaArchiveForTests(buffer.data(), buffer.size(), crcs)
            == PanoramaPatchResult::Rejected
        && buffer == before;
}

bool LifetimeRejectionIsTransactional()
{
    std::array<uint32_t, 10> crcs{};
    auto buffer = Fixture(crcs, true);
    const auto before = buffer;
    return PatchPanoramaArchiveForTests(buffer.data(), buffer.size(), crcs)
        == PanoramaPatchResult::Rejected && buffer == before;
}

} // namespace

int main(int argc, char **argv)
{
    const bool exactArchivePatched = ExactArchiveIsPatched();
    const bool rejectionTransactional = RejectionIsTransactional();
    const bool valid = exactArchivePatched && rejectionTransactional && LifetimeRejectionIsTransactional();
    if (!valid)
    {
        std::cerr << "Panorama patch tests failed: exact=" << exactArchivePatched
                  << " transactional=" << rejectionTransactional << '\n';
        return 1;
    }
    if (argc == 2 || argc == 3)
    {
        std::ifstream file(argv[1], std::ios::binary);
        std::vector<uint8_t> archive{
            std::istreambuf_iterator<char>{ file },
            std::istreambuf_iterator<char>{},
        };
        const PanoramaPatchResult result = PatchFinalPanoramaArchive(
            archive.data(), archive.size());
        std::cout << "archive_size=" << archive.size()
                  << " result=" << static_cast<int>(result) << '\n';
        if (argc == 3 && result == PanoramaPatchResult::Patched)
        {
            std::ofstream output(argv[2], std::ios::binary);
            output.write(reinterpret_cast<const char *>(archive.data()), archive.size());
            if (!output) return 3;
        }
        return result == PanoramaPatchResult::Patched ? 0 : 2;
    }
    return 0;
}
