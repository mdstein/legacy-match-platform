use super::{
    BridgeEvent, BridgeState, CaseOpenCompletion, CaseOpenRequest, ConnectRequest,
    InventoryAcknowledgement, ItemRenameRequest, LauncherBridgeServer, LoadoutSync,
    PlayerProfilePresentation, PlayerProfilesRequest, QueueMode, ReadyCheckPresentation,
    SOURCE_PROCESS_WAIT, SOURCE_WINDOW_WAIT, STANDALONE_APP_ID, SprayRequest,
    SprayUnsealCompletion, TradeUpCompletion, TradeUpRequest, api_endpoint, atomic_write, discover,
    ServiceMedalRequest, ServiceMedalCompletion,
    ensure_faceit_closed, ensure_gc_for_root, fetch_owned_inventory_bundle, get_api_json,
    handle_protocol, log_launcher_event, post_api_json, read_launcher_credential,
    render_owned_inventory_bundle, running_game_process_ids, selected_app_id,
    steam_start_arguments, sync_inventory_for_root, verified_source_window, wait_for_game_process,
    wait_for_source_window,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const BOOTSTRAP_INTERVAL: Duration = Duration::from_secs(2);
const LATENCY_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);

struct SessionHandoff {
    last_match: Option<String>,
    enabled: bool,
    dm_notice: Option<(String, Instant, bool)>,
}

impl Default for SessionHandoff {
    fn default() -> Self {
        Self {
            last_match: None,
            enabled: true,
            dm_notice: None,
        }
    }
}

impl SessionHandoff {
    fn queue_committed(&mut self, mode: QueueMode) {
        self.enabled = true;
        self.dm_notice = None;
        // A fresh, explicitly accepted DM request can reassign the same live
        // match after a disconnect. Background polling must still deduplicate.
        if mode == QueueMode::Deathmatch {
            self.last_match = None;
        }
    }

    fn needs_connection(&self, match_id: &str) -> bool {
        self.enabled && self.last_match.as_deref() != Some(match_id)
    }

    fn connected(&mut self, match_id: &str) {
        self.last_match = Some(match_id.to_string());
        self.dm_notice = None;
    }

    fn cancel_pending(&mut self) {
        self.enabled = false;
        self.dm_notice = None;
    }

    fn deathmatch_notice(
        &mut self,
        state: &SessionBootstrap,
        now: Instant,
    ) -> Option<ReadyCheckPresentation> {
        let Some(assignment) = state.assignment.as_ref() else {
            self.dm_notice = None;
            return None;
        };
        if state.queue.mode.as_deref() != Some("deathmatch")
            || state.queue.phase != "assigned"
            || !self.needs_connection(&assignment.match_id)
        {
            self.dm_notice = None;
            return None;
        }
        if self
            .dm_notice
            .as_ref()
            .is_none_or(|(id, _, _)| id != &assignment.match_id)
        {
            self.dm_notice = Some((assignment.match_id.clone(), now, false));
        }
        Some(ReadyCheckPresentation {
            announcement_only: true,
            match_id: assignment.match_id.clone(),
            map: "de_dust2".to_string(),
            accepted_players: 0,
            total_players: 0,
            seconds_remaining: 0,
            local_accepted: true,
        })
    }

    fn announcement_completed(&mut self, match_id: &str) -> bool {
        let Some((id, _, completed)) = self.dm_notice.as_mut() else {
            return false;
        };
        if id != match_id || !self.enabled {
            return false;
        }
        *completed = true;
        true
    }

    fn can_connect(&self, match_id: &str, now: Instant) -> bool {
        self.needs_connection(match_id)
            && self
                .dm_notice
                .as_ref()
                .is_none_or(|(id, started, completed)| {
                    id == match_id
                        && (*completed || now.duration_since(*started) >= Duration::from_secs(3))
                })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameProfile {
    steam_id: String,
    competitive_rank_id: u32,
    competitive_wins: u32,
    player_level: u32,
    player_xp: u32,
    #[serde(default)]
    b2g_inventory_version: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPlayer {
    id: String,
    region: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionQueue {
    #[serde(default)]
    ticket_id: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    phase: String,
    estimated_wait_seconds: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPlatform {
    online_players: u32,
    active_matches: u32,
    competitive_queue_players: Option<u32>,
    deathmatch_queue_players: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReadyCheck {
    mode: Option<String>,
    match_id: String,
    expires_at: String,
    accepted_player_ids: Vec<String>,
    total_players: u32,
    map: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionAssignment {
    match_id: String,
    launcher_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionBootstrap {
    player: SessionPlayer,
    queue: SessionQueue,
    ready_check: Option<SessionReadyCheck>,
    assignment: Option<SessionAssignment>,
    platform: SessionPlatform,
    game_profile: GameProfile,
}

fn mark_inventory_synchronized(state: &mut SessionBootstrap, inventory_version: Option<u64>) {
    if let Some(inventory_version) = inventory_version {
        state.game_profile.b2g_inventory_version = state
            .game_profile
            .b2g_inventory_version
            .max(inventory_version);
    }
}

fn inventory_refresh_required(current: &SessionBootstrap, next: &SessionBootstrap) -> bool {
    next.game_profile.b2g_inventory_version > current.game_profile.b2g_inventory_version
}

fn finish_inventory_refresh(
    current: &SessionBootstrap,
    next: &mut SessionBootstrap,
    result: &Result<Option<u64>, String>,
) {
    let applied = current.game_profile.b2g_inventory_version;
    next.game_profile.b2g_inventory_version = match result {
        Ok(Some(bundle_version)) => applied.max(*bundle_version),
        Ok(None) => applied.max(next.game_profile.b2g_inventory_version),
        // Keep retrying the same advertised revision after a failed fetch/write.
        // Queue/profile updates still go through; only this watermark is retained.
        Err(_) => applied,
    };
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherLatencyChallenge {
    enabled: bool,
    launcher_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPlayerProfile {
    account_id: u32,
    competitive_rank_id: u32,
    competitive_wins: u32,
    player_level: u32,
    player_xp: u32,
}

#[derive(Debug, Clone, Deserialize)]
struct LauncherPlayerProfilesResponse {
    profiles: Vec<LauncherPlayerProfile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherCaseOpenItem {
    asset_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherCaseOpenResponse {
    odds_version: String,
    already_opened: bool,
    item_name: String,
    item: LauncherCaseOpenItem,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherTradeUpResponse {
    already_completed: bool,
    input_asset_ids: Vec<String>,
    recipe_index: i16,
    item: LauncherCaseOpenItem,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherSprayUnsealResponse {
    already_unsealed: bool,
    sealed_asset_id: String,
    item: LauncherCaseOpenItem,
}

impl SessionBootstrap {
    fn steam_id(&self) -> Result<u64, String> {
        if self.game_profile.steam_id.len() != 17
            || !self
                .game_profile
                .steam_id
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        {
            return Err("B2G returned an invalid Steam identity for this launcher.".to_string());
        }
        self.game_profile
            .steam_id
            .parse::<u64>()
            .map_err(|_| "B2G returned an invalid Steam identity for this launcher.".to_string())
    }

    fn bridge_state(&self) -> Result<BridgeState, String> {
        if self.game_profile.competitive_rank_id > 18
            || !(1..=40).contains(&self.game_profile.player_level)
            || self.game_profile.player_xp > 999
        {
            return Err("B2G returned invalid in-game profile state.".to_string());
        }
        let queue_phase = match self.queue.phase.as_str() {
            "idle" => 0,
            "searching" => 1,
            "ready-check" => 2,
            "map-veto" => 3,
            "assigned" => 4,
            _ => return Err("B2G returned an unknown matchmaking phase.".to_string()),
        };
        Ok(BridgeState {
            rank_id: self.game_profile.competitive_rank_id,
            wins: self.game_profile.competitive_wins,
            player_level: self.game_profile.player_level,
            player_xp: self.game_profile.player_xp,
            queue_phase,
            players_online: self.platform.online_players,
            servers_online: self.platform.active_matches,
            players_searching: self
                .platform
                .competitive_queue_players
                .unwrap_or(0)
                .saturating_add(self.platform.deathmatch_queue_players.unwrap_or(0)),
            ongoing_matches: self.platform.active_matches,
            estimated_wait_seconds: self.queue.estimated_wait_seconds,
        })
    }

    fn ready_check_presentation(&self) -> Result<Option<ReadyCheckPresentation>, String> {
        let Some(ready) = &self.ready_check else {
            return Ok(None);
        };
        match ready.mode.as_deref().unwrap_or("competitive") {
            "competitive" => {}
            "deathmatch" => return Ok(None),
            _ => return Err("B2G returned an unknown ready-check mode.".to_string()),
        }
        if ready.total_players != 10 {
            return Err("B2G returned an invalid Competitive ready-check size.".to_string());
        }
        let deadline = OffsetDateTime::parse(&ready.expires_at, &Rfc3339)
            .map_err(|_| "B2G returned an invalid ready-check deadline.".to_string())?;
        let milliseconds = (deadline - OffsetDateTime::now_utc())
            .whole_milliseconds()
            .max(0);
        let seconds_remaining = u32::try_from((milliseconds + 999) / 1000)
            .unwrap_or(u32::MAX)
            .min(120);
        Ok(Some(ReadyCheckPresentation {
            announcement_only: false,
            match_id: ready.match_id.clone(),
            map: ready.map.clone(),
            accepted_players: u32::try_from(ready.accepted_player_ids.len())
                .map_err(|_| "B2G returned too many ready players.".to_string())?,
            total_players: ready.total_players,
            seconds_remaining,
            local_accepted: ready.accepted_player_ids.contains(&self.player.id),
        }))
    }
}

fn bootstrap(origin: &str, access_token: &str) -> Result<SessionBootstrap, String> {
    get_api_json(
        &api_endpoint(origin, "/api/launcher/v1/bootstrap")?,
        access_token,
        "B2G launcher session",
    )
}

fn queue_join(
    origin: &str,
    access_token: &str,
    region: &str,
    intent: &crate::launcher_bridge::QueueIntent,
) -> Result<SessionQueue, String> {
    let mode_name = match intent.mode {
        QueueMode::Competitive => "competitive",
        QueueMode::Deathmatch => "deathmatch",
    };
    let mut body = serde_json::json!({
        "regions": [region],
        "maps": intent.maps,
        "mode": mode_name
    });
    if let Some(lobby_id) = intent.steam_lobby_id.as_ref() {
        body["nativeParty"] = serde_json::json!({
            "steamLobbyId": lobby_id,
            "memberSteamIds": intent.member_steam_ids
        });
    }
    let queue: SessionQueue = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/queue/join")?,
        &body,
        Some(access_token),
        "B2G matchmaking request",
    )?;
    // Use the actual join response immediately; waiting for the next bootstrap
    // made a successful request appear idle for another poll interval.
    if !matches!(
        queue.phase.as_str(),
        "searching" | "ready-check" | "map-veto" | "assigned"
    ) {
        return Err("B2G returned an invalid queue join response.".to_string());
    }
    Ok(queue)
}

fn join_may_have_committed(error: &str) -> bool {
    // An explicit non-2xx response is a rejection, not a lost success response.
    !error.contains("returned HTTP ")
}

fn queue_join_committed(
    state: &SessionBootstrap,
    intent: &crate::launcher_bridge::QueueIntent,
) -> bool {
    if state.queue.phase == "idle" {
        return false;
    }
    match intent.mode {
        QueueMode::Competitive => {
            state.queue.mode.as_deref().unwrap_or("competitive") == "competitive"
        }
        QueueMode::Deathmatch => state.queue.mode.as_deref() == Some("deathmatch"),
    }
}

fn refresh_latency(origin: &str, access_token: &str, region: &str) -> Result<(), String> {
    log_launcher_event(&format!("latency: measuring the selected {region} route"));
    let challenge: LauncherLatencyChallenge = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/latency/challenges")?,
        &serde_json::json!({ "regions": [region] }),
        Some(access_token),
        "B2G latency challenge",
    )?;
    if !challenge.enabled {
        log_launcher_event("latency: regional measurement is disabled for this environment");
        return Ok(());
    }
    let launcher_url = challenge
        .launcher_url
        .ok_or_else(|| "B2G returned an incomplete latency challenge.".to_string())?;
    let result = handle_protocol(&launcher_url, false)?;
    log_launcher_event(&format!("latency: {result}"));
    Ok(())
}

fn queue_leave(origin: &str, access_token: &str) -> Result<(), String> {
    let _: serde_json::Value = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/queue/leave")?,
        &serde_json::json!({}),
        Some(access_token),
        "B2G matchmaking cancellation",
    )?;
    Ok(())
}

fn release_closed_search(
    origin: &str,
    access_token: &str,
    queue: &SessionQueue,
) -> Result<(), String> {
    if queue.phase != "searching" {
        // Ready checks expire through their normal policy; accepted matches stay committed.
        return Ok(());
    }
    let Some(ticket_id) = queue.ticket_id.as_deref() else {
        return Err("The API cannot safely cancel this search. Update the API, then cancel matchmaking before closing CS:GO.".to_string());
    };
    let endpoint = api_endpoint(origin, "/api/launcher/v1/queue/session-ended")?;
    let mut last_error = String::new();
    for _ in 0..3 {
        match post_api_json::<_, serde_json::Value>(
            &endpoint,
            &serde_json::json!({ "ticketId": ticket_id }),
            Some(access_token),
            "B2G closed-session cleanup",
        ) {
            Ok(_) => return Ok(()),
            Err(error) => last_error = error,
        }
    }
    Err(format!(
        "CS:GO closed, but B2G could not confirm search cancellation. Reopen the client and cancel matchmaking. {last_error}"
    ))
}

fn accept_match(origin: &str, access_token: &str, match_id: &str) -> Result<(), String> {
    if match_id.len() != 36
        || !match_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("B2G returned an invalid ready-check identifier.".to_string());
    }
    let endpoint = api_endpoint(
        origin,
        &format!("/api/launcher/v1/matches/{match_id}/accept"),
    )?;
    let _: serde_json::Value = post_api_json(
        &endpoint,
        &serde_json::json!({}),
        Some(access_token),
        "B2G ready-check acceptance",
    )?;
    Ok(())
}

fn player_profiles(
    origin: &str,
    access_token: &str,
    request: &PlayerProfilesRequest,
) -> Result<Vec<PlayerProfilePresentation>, String> {
    let response: LauncherPlayerProfilesResponse = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/player-profiles")?,
        &serde_json::json!({ "accountIds": request.account_ids }),
        Some(access_token),
        "B2G in-game player profiles",
    )?;
    let response_count = response.profiles.len();
    let mut by_account_id = response
        .profiles
        .into_iter()
        .map(|profile| (profile.account_id, profile))
        .collect::<HashMap<_, _>>();
    if by_account_id.len() != response_count
        || by_account_id.len() > request.account_ids.len()
        || by_account_id
            .keys()
            .any(|account_id| !request.account_ids.contains(account_id))
    {
        return Err("B2G returned profiles outside the in-game request.".to_string());
    }
    request
        .account_ids
        .iter()
        .map(|account_id| {
            let Some(profile) = by_account_id.remove(account_id) else {
                return Ok(PlayerProfilePresentation {
                    account_id: *account_id,
                    rank_id: 0,
                    wins: 0,
                    player_level: 0,
                    player_xp: 0,
                });
            };
            let presentation = PlayerProfilePresentation {
                account_id: profile.account_id,
                rank_id: profile.competitive_rank_id,
                wins: profile.competitive_wins,
                player_level: profile.player_level,
                player_xp: profile.player_xp,
            };
            if presentation.rank_id > 18
                || !(1..=40).contains(&presentation.player_level)
                || presentation.player_xp > 999
            {
                return Err("B2G returned invalid in-game player profile state.".to_string());
            }
            Ok(presentation)
        })
        .collect()
}

fn open_b2g_case(
    origin: &str,
    access_token: &str,
    request: CaseOpenRequest,
) -> Result<LauncherCaseOpenResponse, String> {
    let body = if request.key_asset_id == 0 {
        serde_json::json!({
            "caseAssetId": request.case_asset_id.to_string()
        })
    } else {
        serde_json::json!({
            "caseAssetId": request.case_asset_id.to_string(),
            "keyAssetId": request.key_asset_id.to_string()
        })
    };
    post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/cases/open")?,
        &body,
        Some(access_token),
        "B2G case opening",
    )
}

fn trade_up_b2g(
    origin: &str,
    access_token: &str,
    request: TradeUpRequest,
) -> Result<LauncherTradeUpResponse, String> {
    post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/trade-ups")?,
        &serde_json::json!({
            "inputAssetIds": request
                .input_asset_ids
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
        }),
        Some(access_token),
        "B2G Trade Up Contract",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MedalPreview {
    can_redeem: bool,
    #[serde(default)]
    failure_reason: u16,
    player_level: u32,
    player_xp: u32,
    medal: Option<MedalPreviewItem>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MedalPreviewItem {
    definition_index: u32,
    upgrade_asset_id: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MedalRedemption {
    definition_index: u32,
    asset_id: String,
    redeemed_at: String,
    player_level: u32,
    player_xp: u32,
}

fn service_medal(
    origin: &str, access_token: &str, game_root: &Path, request: ServiceMedalRequest,
) -> Result<(ServiceMedalCompletion, Option<u64>), String> {
    let endpoint = api_endpoint(origin, "/api/launcher/v1/service-medal")?;
    let rejected = |preview: &MedalPreview| ServiceMedalCompletion {
        request_id: request.request_id, failure_reason: preview.failure_reason.min(3),
        ..Default::default()
    };
    if request.definition_index == 0 {
        let preview: MedalPreview = get_api_json(&endpoint, access_token, "B2G service medal preview")?;
        if !preview.can_redeem { return Ok((rejected(&preview), None)); }
        let medal = preview.medal.ok_or("You have redeemed every available service medal tier.")?;
        if !preview.can_redeem || preview.player_level != 40 || preview.player_xp >= 1000 {
            return Err("Reach level 40 to redeem your next service medal.".to_string());
        }
        let asset_id = medal.upgrade_asset_id.map(|id| id.parse::<u64>())
            .transpose().map_err(|_| "Invalid service medal asset.")?.unwrap_or(0);
        return Ok((ServiceMedalCompletion {
            request_id: request.request_id, asset_id, definition_index: medal.definition_index,
            player_level: preview.player_level, player_xp: preview.player_xp, succeeded: true,
            ..Default::default()
        }, None));
    }
    let redemption: Result<MedalRedemption, String> = post_api_json(&endpoint,
        &serde_json::json!({ "definitionIndex": request.definition_index }),
        Some(access_token), "B2G service medal redemption");
    let redeemed = match redemption {
        Ok(value) => value,
        Err(error) => {
            // A fresh preview distinguishes ineligibility/capacity/exhaustion
            // without guessing from transport error strings or resubmitting.
            if let Ok(preview) = get_api_json::<MedalPreview>(&endpoint, access_token, "B2G service medal recovery") {
                if !preview.can_redeem && preview.medal.as_ref()
                    .is_some_and(|medal| medal.definition_index == request.definition_index) {
                    return Ok((rejected(&preview), None));
                }
            }
            return Err(error);
        }
    };
    let asset_id = redeemed.asset_id.parse::<u64>().map_err(|_| "Invalid service medal asset.")?;
    let prestige_time = OffsetDateTime::parse(&redeemed.redeemed_at, &Rfc3339)
        .map_err(|_| "Invalid service medal redemption time.")?.unix_timestamp();
    if redeemed.definition_index != request.definition_index || asset_id == 0
        || redeemed.player_level == 0 || redeemed.player_level > 40 || redeemed.player_xp >= 1000
        || prestige_time <= 0 || prestige_time > u32::MAX as i64 {
        return Err("The service medal response did not match the redemption.".to_string());
    }
    let version = install_session_inventory(origin, access_token, game_root)?;
    Ok((ServiceMedalCompletion {
        request_id: request.request_id, asset_id, definition_index: redeemed.definition_index,
        prestige_time: prestige_time as u32, player_level: redeemed.player_level,
        player_xp: redeemed.player_xp, succeeded: true, redeemed: true,
        failure_reason: 0,
    }, version))
}

fn sync_loadout(origin: &str, access_token: &str, request: &LoadoutSync) -> Result<(), String> {
    let _: serde_json::Value = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/inventory/loadout")?,
        &serde_json::json!({
            "assetIds": request.asset_ids.iter().map(u64::to_string).collect::<Vec<_>>(),
            "ownershipGenerations": request.ownership_generations
        }),
        Some(access_token),
        "B2G loadout persistence",
    )?;
    Ok(())
}

fn acknowledge_inventory(
    origin: &str,
    access_token: &str,
    request: &InventoryAcknowledgement,
) -> Result<(), String> {
    let _: serde_json::Value = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/inventory/acknowledge")?,
        &serde_json::json!({
            "positions": request.positions.iter().map(|(asset_id, position)| serde_json::json!({
                "assetId": asset_id.to_string(), "position": position,
                "ownershipGeneration": request.ownership_generations.get(&asset_id.to_string()).map(String::as_str).unwrap_or("0")
            })).collect::<Vec<_>>()
        }),
        Some(access_token),
        "B2G inventory acknowledgement",
    )?;
    Ok(())
}

fn rename_item(
    origin: &str,
    access_token: &str,
    request: &ItemRenameRequest,
) -> Result<(), String> {
    let _: serde_json::Value = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/inventory/rename")?,
        &serde_json::json!({
            "assetId": request.asset_id.to_string(), "customName": request.custom_name
        }),
        Some(access_token),
        "B2G free Name Tag",
    )?;
    Ok(())
}

fn unseal_spray(
    origin: &str,
    access_token: &str,
    request: SprayRequest,
) -> Result<LauncherSprayUnsealResponse, String> {
    post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/inventory/sprays/unseal")?,
        &serde_json::json!({ "assetId": request.asset_id.to_string() }),
        Some(access_token),
        "B2G graffiti activation",
    )
}

fn use_spray(origin: &str, access_token: &str, request: SprayRequest) -> Result<(), String> {
    let _: serde_json::Value = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/inventory/sprays/use")?,
        &serde_json::json!({ "assetId": request.asset_id.to_string() }),
        Some(access_token),
        "B2G graffiti usage",
    )?;
    Ok(())
}

fn install_session_inventory(
    origin: &str,
    access_token: &str,
    game_root: &Path,
) -> Result<Option<u64>, String> {
    log_launcher_event("inventory: refreshing the paired account's owned-item bundle");
    let endpoint = api_endpoint(origin, "/api/launcher/v1/inventory")?;
    let bundle = fetch_owned_inventory_bundle(&endpoint, access_token)?;
    let item_count = bundle
        .players
        .iter()
        .map(|player| player.items.len())
        .sum::<usize>();
    atomic_write(
        &game_root.join("csgo_gc").join("b2g_owned_manifest.txt"),
        render_owned_inventory_bundle(&bundle).as_bytes(),
    )?;
    log_launcher_event(&format!(
        "inventory: activated {item_count} verified owned item(s) for this client session"
    ));
    Ok(bundle.inventory_version)
}

fn launch_game_shell(
    steam: &Path,
    app_id: &str,
    expected_game_binary: &Path,
) -> Result<(), String> {
    if verified_source_window(expected_game_binary)?.is_some() {
        log_launcher_event("game: using the existing verified CS:GO window");
        return Ok(());
    }
    let running = running_game_process_ids(expected_game_binary)?;
    if !running.is_empty() {
        return Err(format!(
            "CS:GO is still running without a game window (PID {}). End that process from Steam or Task Manager, then press GO again.",
            running
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    log_launcher_event(&format!("game: asking Steam to launch App {app_id}"));
    Command::new(steam)
        .args(steam_start_arguments(app_id))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not launch Steam: {error}"))?;
    wait_for_game_process(expected_game_binary, SOURCE_PROCESS_WAIT)?;
    wait_for_source_window(expected_game_binary, SOURCE_WINDOW_WAIT)?;
    log_launcher_event("game: CS:GO window is ready; in-game matchmaking is active");
    Ok(())
}

fn connect_assignment(launcher_url: &str, origin: &str, access_token: &str) -> Result<(), String> {
    let request = ConnectRequest::from_deep_link(launcher_url)?;
    let endpoint = api_endpoint(origin, "/api/launcher/v1/inventory")?;
    let bundle = fetch_owned_inventory_bundle(&endpoint, access_token)?;
    super::connect_with_inventory(&request, false, Some(&bundle)).map(|_| ())
}

pub fn run_client_session() -> Result<String, String> {
    run_client_session_with_ready(|| {})
}

pub(super) fn run_client_session_with_ready(on_ready: impl FnOnce()) -> Result<String, String> {
    let result = run_client_session_inner(on_ready);
    match &result {
        Ok(message) => log_launcher_event(&format!("session: finished: {message}")),
        Err(error) => log_launcher_event(&format!("session: failed: {error}")),
    }
    result
}

fn run_client_session_inner(on_ready: impl FnOnce()) -> Result<String, String> {
    let credential = read_launcher_credential()?.ok_or_else(|| {
        "Connect this launcher to your B2G account before pressing GO.".to_string()
    })?;
    log_launcher_event("session: loading paired account and authoritative profile");
    let mut state = bootstrap(&credential.api_origin, &credential.access_token)?;
    let expected_steam_id = state.steam_id()?;

    let report = discover();
    if !report.legacy_ready {
        return Err(report
            .blocking_reason
            .unwrap_or_else(|| "Legacy CS:GO is not ready.".to_string()));
    }
    let app_id = selected_app_id(&report, false)?;
    let game_root = PathBuf::from(
        report
            .game_root
            .as_deref()
            .ok_or_else(|| "Legacy CS:GO game root is unavailable.".to_string())?,
    );
    let game_binary = PathBuf::from(
        report
            .legacy_binary
            .as_deref()
            .ok_or_else(|| "Legacy CS:GO executable is unavailable.".to_string())?,
    );
    let steam = PathBuf::from(
        report
            .steam_executable
            .as_deref()
            .ok_or_else(|| "Steam is not installed.".to_string())?,
    );

    ensure_faceit_closed()?;
    super::require_game_stopped(&game_root)?;
    if app_id != STANDALONE_APP_ID {
        sync_inventory_for_root(&game_root, false)?;
    }
    let _ =
        install_session_inventory(&credential.api_origin, &credential.access_token, &game_root)?;
    let gc_changed = ensure_gc_for_root(&game_root)?;
    if gc_changed && verified_source_window(&game_binary)?.is_some() {
        return Err(
            "B2G updated the in-game client. Close CS:GO, then press GO again.".to_string(),
        );
    }

    log_launcher_event("session: starting the credential-free local game bridge");
    let bridge = LauncherBridgeServer::start(&game_binary, expected_steam_id)?;
    bridge.send_state(state.bridge_state()?)?;
    let initial_ready_check = state.ready_check_presentation()?;
    bridge.send_ready_check(initial_ready_check.as_ref())?;
    launch_game_shell(&steam, &app_id, &game_binary)?;
    on_ready();

    let mut last_bootstrap = Instant::now() - BOOTSTRAP_INTERVAL;
    let mut last_accepted_match: Option<String> = None;
    let mut handoff = SessionHandoff::default();
    let mut last_presented_ready = initial_ready_check
        .as_ref()
        .map(|ready| ready.match_id.clone());
    let mut active_native_search = state.queue.phase != "idle";
    let mut measured_regions: HashMap<String, Instant> = HashMap::new();
    match refresh_latency(
        &credential.api_origin,
        &credential.access_token,
        &state.player.region,
    ) {
        Ok(()) => {
            measured_regions.insert(state.player.region.clone(), Instant::now());
        }
        Err(error) => {
            log_launcher_event(&format!(
                "latency: initial measurement deferred until matchmaking: {error}"
            ));
        }
    }
    let session_result = (|| -> Result<(), String> {
        loop {
            if running_game_process_ids(&game_binary)?.is_empty() {
                log_launcher_event("session: CS:GO closed; launcher bridge stopped");
                break;
            }

            match bridge.recv_timeout(Duration::from_millis(100)) {
                Ok(BridgeEvent::Connected { steam_id }) => {
                    log_launcher_event(&format!(
                        "session: verified in-game bridge for Steam account {steam_id}"
                    ));
                    bridge.send_state(state.bridge_state()?)?;
                    bridge.send_ready_check(state.ready_check_presentation()?.as_ref())?;
                }
                Ok(BridgeEvent::QueueStart(intent)) => {
                    handoff.cancel_pending();
                    let mode = match intent.mode {
                        QueueMode::Competitive => "competitive",
                        QueueMode::Deathmatch => "deathmatch",
                    };
                    log_launcher_event(&format!(
                        "queue: Panorama requested {mode} game_type={} maps={} party_members={}",
                        intent.game_type,
                        if intent.maps.is_empty() {
                            "automatic".to_string()
                        } else {
                            intent.maps.join(",")
                        },
                        intent.member_steam_ids.len()
                    ));
                    let needs_measurement = measured_regions
                        .get(&state.player.region)
                        .is_none_or(|measured| measured.elapsed() >= LATENCY_REFRESH_INTERVAL);
                    if needs_measurement
                        && let Err(error) = refresh_latency(
                            &credential.api_origin,
                            &credential.access_token,
                            &state.player.region,
                        )
                    {
                        log_launcher_event(&format!("queue: latency measurement failed: {error}"));
                        bridge.send_queue_result(intent.request_id, 0, Some(&error))?;
                        continue;
                    }
                    if needs_measurement {
                        measured_regions.insert(state.player.region.clone(), Instant::now());
                    }
                    match queue_join(
                        &credential.api_origin,
                        &credential.access_token,
                        &state.player.region,
                        &intent,
                    ) {
                        Err(error) => {
                            if !join_may_have_committed(&error) {
                                log_launcher_event(&format!("queue: join rejected: {error}"));
                                bridge.send_queue_result(intent.request_id, 0, Some(&error))?;
                                continue;
                            }
                            log_launcher_event(&format!(
                                "queue: join response failed; reconciling authoritative state: {error}"
                            ));
                            match bootstrap(&credential.api_origin, &credential.access_token) {
                                Ok(reconciled)
                                    if queue_join_committed(&reconciled, &intent)
                                        && !(state.queue.phase == "assigned"
                                            && reconciled.queue.phase == "assigned"
                                            && state.assignment.as_ref().map(|a| &a.match_id)
                                                == reconciled
                                                    .assignment
                                                    .as_ref()
                                                    .map(|a| &a.match_id)) =>
                                {
                                    state = reconciled;
                                    handoff.queue_committed(intent.mode);
                                    active_native_search = true;
                                    bridge.send_state(state.bridge_state()?)?;
                                    bridge.send_queue_result(
                                        intent.request_id,
                                        state.bridge_state()?.queue_phase,
                                        None,
                                    )?;
                                    log_launcher_event(
                                        "queue: recovered a committed B2G matchmaking request after the slow response",
                                    );
                                    last_bootstrap = Instant::now() - BOOTSTRAP_INTERVAL;
                                }
                                Ok(_) => {
                                    log_launcher_event(&format!("queue: join failed: {error}"));
                                    bridge.send_queue_result(intent.request_id, 0, Some(&error))?;
                                }
                                Err(reconcile_error) => {
                                    log_launcher_event(&format!(
                                        "queue: join failed: {error}; reconciliation failed: {reconcile_error}"
                                    ));
                                    bridge.send_queue_result(intent.request_id, 0, Some(&error))?;
                                }
                            }
                        }
                        Ok(queue) => {
                            state.queue = queue;
                            handoff.queue_committed(intent.mode);
                            active_native_search = true;
                            log_launcher_event(
                                "queue: B2G accepted the in-game matchmaking request",
                            );
                            bridge.send_state(state.bridge_state()?)?;
                            bridge.send_queue_result(
                                intent.request_id,
                                state.bridge_state()?.queue_phase,
                                None,
                            )?;
                            last_bootstrap = Instant::now() - BOOTSTRAP_INTERVAL;
                        }
                    }
                }
                Ok(BridgeEvent::QueueRejected { request_id, error }) => {
                    log_launcher_event(&format!("queue: invalid native request: {error}"));
                    bridge.send_queue_result(request_id, 0, Some(&error))?;
                }
                Ok(BridgeEvent::QueueStop {
                    abandon,
                    request_id,
                }) => {
                    handoff.cancel_pending();
                    bridge.send_ready_check(None)?;
                    log_launcher_event(&format!(
                        "queue: Panorama cancelled matchmaking (abandon={abandon})"
                    ));
                    if let Err(error) =
                        queue_leave(&credential.api_origin, &credential.access_token)
                    {
                        log_launcher_event(&format!("queue: cancellation failed: {error}"));
                        bridge.send_queue_result(
                            request_id,
                            state.bridge_state()?.queue_phase,
                            Some(&error),
                        )?;
                    } else {
                        state.queue.phase = "idle".to_string();
                        state.assignment = None;
                        state.ready_check = None;
                        bridge.send_state(state.bridge_state()?)?;
                        bridge.send_queue_result(request_id, 0, None)?;
                        active_native_search = false;
                        last_accepted_match = None;
                        last_bootstrap = Instant::now() - BOOTSTRAP_INTERVAL;
                    }
                }
                Ok(BridgeEvent::ReadyAccept { match_id }) => {
                    if state.queue.mode.as_deref() == Some("deathmatch") {
                        if active_native_search
                            && state
                                .assignment
                                .as_ref()
                                .is_some_and(|a| a.match_id == match_id)
                            && handoff.announcement_completed(&match_id)
                        {
                            log_launcher_event(
                                "queue: native Deathmatch announcement confirmed; connecting",
                            );
                            last_bootstrap = Instant::now() - BOOTSTRAP_INTERVAL;
                        }
                        // A notification cannot approve a Competitive ready check.
                        continue;
                    }
                    let Some(ready) = state.ready_check.as_ref() else {
                        let error = "That B2G ready check is no longer active.";
                        log_launcher_event(&format!("queue: native acceptance rejected: {error}"));
                        bridge.send_error(error)?;
                        continue;
                    };
                    if !active_native_search || ready.match_id != match_id {
                        let error = "The in-game ready check did not match the active B2G search.";
                        log_launcher_event(&format!("queue: native acceptance rejected: {error}"));
                        bridge.send_error(error)?;
                        continue;
                    }
                    if last_accepted_match.as_deref() == Some(match_id.as_str()) {
                        log_launcher_event("queue: duplicate native acceptance ignored");
                        continue;
                    }
                    log_launcher_event(&format!(
                        "queue: submitting native Panorama acceptance for {match_id}"
                    ));
                    match accept_match(&credential.api_origin, &credential.access_token, &match_id)
                    {
                        Ok(()) => {
                            last_accepted_match = Some(match_id);
                            last_bootstrap = Instant::now() - BOOTSTRAP_INTERVAL;
                            log_launcher_event("queue: native Panorama acceptance confirmed");
                        }
                        Err(error) => {
                            log_launcher_event(&format!(
                                "queue: native ready-check acceptance failed: {error}"
                            ));
                            bridge.send_error(&error)?;
                        }
                    }
                }
                Ok(BridgeEvent::PlayerProfilesRequest(request)) => {
                    log_launcher_event(&format!(
                        "profiles: resolving {} in-game player profile(s)",
                        request.account_ids.len()
                    ));
                    match player_profiles(
                        &credential.api_origin,
                        &credential.access_token,
                        &request,
                    ) {
                        Ok(profiles) => bridge.send_player_profiles(&request, &profiles)?,
                        Err(error) => {
                            log_launcher_event(&format!("profiles: lookup failed: {error}"));
                            let unavailable = request
                                .account_ids
                                .iter()
                                .map(|account_id| PlayerProfilePresentation {
                                    account_id: *account_id,
                                    rank_id: 0,
                                    wins: 0,
                                    player_level: 0,
                                    player_xp: 0,
                                })
                                .collect::<Vec<_>>();
                            bridge.send_player_profiles(&request, &unavailable)?;
                        }
                    }
                }
                Ok(BridgeEvent::CaseOpenRequest(request)) => {
                    log_launcher_event(&format!(
                        "drops: opening keyless B2G case {} with its included entitlement",
                        request.case_asset_id
                    ));
                    let authoritative_result =
                        (|| -> Result<(CaseOpenCompletion, Option<u64>), String> {
                            let opened = open_b2g_case(
                                &credential.api_origin,
                                &credential.access_token,
                                request,
                            )?;
                            let result_asset_id =
                                opened.item.asset_id.parse::<u64>().map_err(|_| {
                                    "B2G returned an invalid case reward identifier.".to_string()
                                })?;
                            let inventory_version = install_session_inventory(
                                &credential.api_origin,
                                &credential.access_token,
                                &game_root,
                            )?;
                            log_launcher_event(&format!(
                                "drops: {} reward {} recorded under odds policy {}",
                                if opened.already_opened {
                                    "recovered"
                                } else {
                                    "unboxed"
                                },
                                result_asset_id,
                                opened.odds_version
                            ));
                            Ok((
                                CaseOpenCompletion {
                                    case_asset_id: request.case_asset_id,
                                    key_asset_id: request.key_asset_id,
                                    result_asset_id: Some(result_asset_id),
                                    item_name: Some(opened.item_name),
                                },
                                inventory_version,
                            ))
                        })();
                    let completion = match authoritative_result {
                        Ok((completion, inventory_version)) => {
                            mark_inventory_synchronized(&mut state, inventory_version);
                            completion
                        }
                        Err(error) => {
                            log_launcher_event(&format!("drops: case opening failed: {error}"));
                            CaseOpenCompletion {
                                case_asset_id: request.case_asset_id,
                                key_asset_id: request.key_asset_id,
                                result_asset_id: None,
                                item_name: None,
                            }
                        }
                    };
                    bridge.send_case_open_result(completion)?;
                }
                Ok(BridgeEvent::TradeUpRequest(request)) => {
                    log_launcher_event("inventory: submitting authoritative B2G Trade Up Contract");
                    let authoritative_result =
                        (|| -> Result<(TradeUpCompletion, Option<u64>), String> {
                            let traded = trade_up_b2g(
                                &credential.api_origin,
                                &credential.access_token,
                                request,
                            )?;
                            let mut returned_ids = traded
                                .input_asset_ids
                                .iter()
                                .map(|asset_id| {
                                    asset_id.parse::<u64>().map_err(|_| {
                                        "B2G returned an invalid Trade Up input identifier."
                                            .to_string()
                                    })
                                })
                                .collect::<Result<Vec<_>, _>>()?;
                            let mut requested_ids = request.input_asset_ids.to_vec();
                            returned_ids.sort_unstable();
                            requested_ids.sort_unstable();
                            if returned_ids != requested_ids
                                || traded.recipe_index < 0
                                || traded.recipe_index > 15
                            {
                                return Err(
                                    "B2G returned a mismatched Trade Up result.".to_string()
                                );
                            }
                            let result_asset_id =
                                traded.item.asset_id.parse::<u64>().map_err(|_| {
                                    "B2G returned an invalid Trade Up reward identifier."
                                        .to_string()
                                })?;
                            let inventory_version = install_session_inventory(
                                &credential.api_origin,
                                &credential.access_token,
                                &game_root,
                            )?;
                            log_launcher_event(&format!(
                                "inventory: {} Trade Up result {}",
                                if traded.already_completed {
                                    "recovered"
                                } else {
                                    "created"
                                },
                                result_asset_id
                            ));
                            Ok((
                                TradeUpCompletion {
                                    recipe_index: traded.recipe_index,
                                    input_asset_ids: request.input_asset_ids,
                                    result_asset_id: Some(result_asset_id),
                                },
                                inventory_version,
                            ))
                        })();
                    let completion = match authoritative_result {
                        Ok((completion, inventory_version)) => {
                            mark_inventory_synchronized(&mut state, inventory_version);
                            completion
                        }
                        Err(error) => {
                            log_launcher_event(&format!("inventory: Trade Up failed: {error}"));
                            TradeUpCompletion {
                                recipe_index: request.recipe,
                                input_asset_ids: request.input_asset_ids,
                                result_asset_id: None,
                            }
                        }
                    };
                    bridge.send_trade_up_result(completion)?;
                }
                Ok(BridgeEvent::ServiceMedalRequest(request)) => {
                    let completion = match service_medal(&credential.api_origin,
                        &credential.access_token, &game_root, request) {
                        Ok((completion, inventory_version)) => {
                            if completion.redeemed {
                                mark_inventory_synchronized(&mut state, inventory_version);
                                state.game_profile.player_level = completion.player_level;
                                state.game_profile.player_xp = completion.player_xp;
                                log_launcher_event("inventory: service medal redemption saved");
                            }
                            completion
                        }
                        Err(error) => {
                            log_launcher_event(&format!("inventory: service medal failed: {error}"));
                            ServiceMedalCompletion { request_id: request.request_id, ..Default::default() }
                        }
                    };
                    bridge.send_service_medal_result(completion)?;
                    last_bootstrap = Instant::now() - BOOTSTRAP_INTERVAL;
                }
                Ok(BridgeEvent::LoadoutSync(request)) => {
                    match sync_loadout(&credential.api_origin, &credential.access_token, &request) {
                        Ok(()) => log_launcher_event(&format!(
                            "inventory: persisted {} equipped item(s)",
                            request.asset_ids.len()
                        )),
                        Err(error) => log_launcher_event(&format!(
                            "inventory: loadout persistence failed: {error}"
                        )),
                    }
                }
                Ok(BridgeEvent::InventoryAcknowledge(request)) => {
                    match acknowledge_inventory(
                        &credential.api_origin,
                        &credential.access_token,
                        &request,
                    ) {
                        Ok(()) => log_launcher_event(&format!(
                            "inventory: acknowledged {} new item(s)",
                            request.positions.len()
                        )),
                        Err(error) => log_launcher_event(&format!(
                            "inventory: acknowledgement persistence failed: {error}"
                        )),
                    }
                }
                Ok(BridgeEvent::ItemRename(request)) => {
                    match rename_item(&credential.api_origin, &credential.access_token, &request) {
                        Ok(()) => log_launcher_event(&format!(
                            "inventory: saved free Name Tag for item {}",
                            request.asset_id
                        )),
                        Err(error) => {
                            log_launcher_event(&format!("inventory: item rename failed: {error}"));
                            bridge.send_error(&error)?;
                        }
                    }
                }
                Ok(BridgeEvent::SprayUnsealRequest(request)) => {
                    let authoritative_result =
                        (|| -> Result<(SprayUnsealCompletion, Option<u64>), String> {
                            let activated = unseal_spray(
                                &credential.api_origin,
                                &credential.access_token,
                                request,
                            )?;
                            if activated.sealed_asset_id != request.asset_id.to_string() {
                                return Err(
                                    "B2G returned a mismatched graffiti activation.".to_string()
                                );
                            }
                            let result_asset_id =
                                activated.item.asset_id.parse::<u64>().map_err(|_| {
                                    "B2G returned an invalid graffiti identifier.".to_string()
                                })?;
                            let inventory_version = install_session_inventory(
                                &credential.api_origin,
                                &credential.access_token,
                                &game_root,
                            )?;
                            log_launcher_event(&format!(
                                "inventory: {} 50-use graffiti {}",
                                if activated.already_unsealed {
                                    "recovered"
                                } else {
                                    "activated"
                                },
                                result_asset_id
                            ));
                            Ok((
                                SprayUnsealCompletion {
                                    sealed_asset_id: request.asset_id,
                                    result_asset_id: Some(result_asset_id),
                                },
                                inventory_version,
                            ))
                        })();
                    let completion = match authoritative_result {
                        Ok((completion, inventory_version)) => {
                            mark_inventory_synchronized(&mut state, inventory_version);
                            completion
                        }
                        Err(error) => {
                            log_launcher_event(&format!(
                                "inventory: graffiti activation failed: {error}"
                            ));
                            SprayUnsealCompletion {
                                sealed_asset_id: request.asset_id,
                                result_asset_id: None,
                            }
                        }
                    };
                    bridge.send_spray_unseal_result(completion)?;
                }
                Ok(BridgeEvent::SprayUseRequest(request)) => {
                    match use_spray(&credential.api_origin, &credential.access_token, request) {
                        Ok(()) => log_launcher_event(&format!(
                            "inventory: recorded one graffiti use for {}",
                            request.asset_id
                        )),
                        Err(error) => log_launcher_event(&format!(
                            "inventory: graffiti usage persistence failed: {error}"
                        )),
                    }
                }
                Ok(BridgeEvent::ProtocolError(error)) => {
                    log_launcher_event(&format!("session: bridge warning: {error}"));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("The local game bridge stopped unexpectedly.".to_string());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }

            if last_bootstrap.elapsed() < BOOTSTRAP_INTERVAL {
                continue;
            }
            last_bootstrap = Instant::now();
            match bootstrap(&credential.api_origin, &credential.access_token) {
                Ok(mut next) => {
                    if inventory_refresh_required(&state, &next) {
                        log_launcher_event("inventory: a B2G inventory change was detected");
                        let refreshed = install_session_inventory(
                            &credential.api_origin,
                            &credential.access_token,
                            &game_root,
                        );
                        finish_inventory_refresh(&state, &mut next, &refreshed);
                        match refreshed {
                            Ok(_) => {
                                bridge.send_inventory_refresh()?;
                                log_launcher_event(
                                    "inventory: synchronized changed B2G inventory items",
                                );
                            }
                            Err(error) => {
                                log_launcher_event(&format!(
                                    "inventory: refresh failed; will retry: {error}"
                                ));
                            }
                        }
                    } else {
                        mark_inventory_synchronized(
                            &mut next,
                            Some(state.game_profile.b2g_inventory_version),
                        );
                    }
                    state = next;
                }
                Err(error) => {
                    log_launcher_event(&format!("session: state refresh failed: {error}"));
                    bridge.send_error(&error)?;
                    continue;
                }
            }
            active_native_search = state.queue.phase != "idle";
            bridge.send_state(state.bridge_state()?)?;
            let ready_check = handoff
                .deathmatch_notice(&state, Instant::now())
                .or(state.ready_check_presentation()?);
            if let Some(ready) = ready_check.as_ref()
                && last_presented_ready.as_deref() != Some(ready.match_id.as_str())
            {
                if ready.announcement_only {
                    log_launcher_event(
                        "queue: MATCH FOUND on Dust II; showing the native automatic Deathmatch announcement",
                    );
                } else {
                    log_launcher_event(&format!(
                        "queue: MATCH FOUND on {}; accept in CS:GO ({} of {}, {}s remaining)",
                        ready.map,
                        ready.accepted_players,
                        ready.total_players,
                        ready.seconds_remaining
                    ));
                }
            }
            if ready_check.is_none() && last_presented_ready.is_some() {
                log_launcher_event("queue: native ready check closed");
            }
            last_presented_ready = ready_check.as_ref().map(|ready| ready.match_id.clone());
            bridge.send_ready_check(ready_check.as_ref())?;

            if let Some(assignment) = &state.assignment
                && handoff.can_connect(&assignment.match_id, Instant::now())
            {
                log_launcher_event(&format!(
                    "queue: match {} assigned; preparing secure server handoff",
                    assignment.match_id
                ));
                match connect_assignment(
                    &assignment.launcher_url,
                    &credential.api_origin,
                    &credential.access_token,
                ) {
                    Ok(()) => {
                        handoff.connected(&assignment.match_id);
                        bridge.send_ready_check(None)?;
                        log_launcher_event("queue: server handoff completed");
                    }
                    Err(error) => {
                        log_launcher_event(&format!("queue: server handoff failed: {error}"));
                        bridge.send_error(&error)?;
                    }
                }
            }
        }

        Ok(())
    })();
    let cleanup = release_closed_search(
        &credential.api_origin,
        &credential.access_token,
        &state.queue,
    );
    if let Err(error) = &cleanup {
        log_launcher_event(&format!("session: {error}"));
    }
    session_result?;
    cleanup?;
    Ok("CS:GO session closed cleanly.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_deathmatch_requeue_reconnects_to_the_same_match_once() {
        let mut handoff = SessionHandoff::default();
        assert!(handoff.needs_connection("dm-1"));
        handoff.connected("dm-1");
        for _ in 0..5 {
            assert!(!handoff.needs_connection("dm-1"));
        }
        handoff.queue_committed(QueueMode::Deathmatch);
        assert!(handoff.needs_connection("dm-1"));
        handoff.connected("dm-1");
        assert!(!handoff.needs_connection("dm-1"));
        assert!(handoff.needs_connection("dm-2"));
    }

    #[test]
    fn competitive_requests_keep_handoff_deduplication() {
        let mut handoff = SessionHandoff::default();
        handoff.connected("competitive-1");
        handoff.queue_committed(QueueMode::Competitive);
        assert!(!handoff.needs_connection("competitive-1"));
        assert!(handoff.needs_connection("competitive-2"));
    }

    fn bootstrap_with_ready_mode(mode: &str) -> SessionBootstrap {
        serde_json::from_value(serde_json::json!({
            "player": { "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "region": "NA Central" },
            "queue": { "phase": "ready-check", "estimatedWaitSeconds": 0 },
            "readyCheck": {
                "mode": mode,
                "matchId": "11111111-2222-3333-4444-555555555555",
                "expiresAt": "2099-09-03T03:20:19.000Z",
                "acceptedPlayerIds": ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
                "totalPlayers": 10,
                "map": "Mirage"
            },
            "assignment": null,
            "platform": { "onlinePlayers": 10, "activeMatches": 1 },
            "gameProfile": {
                "steamId": "76561198000000001",
                "competitiveRankId": 11,
                "competitiveWins": 42,
                "playerLevel": 4,
                "playerXp": 380
            }
        }))
        .unwrap()
    }

    fn bootstrap_with_queue(mode: Option<&str>, phase: &str) -> SessionBootstrap {
        let mut value = serde_json::json!({
            "player": { "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "region": "NA Central" },
            "queue": { "phase": phase, "estimatedWaitSeconds": 0 },
            "readyCheck": null,
            "assignment": null,
            "platform": { "onlinePlayers": 1, "activeMatches": 0 },
            "gameProfile": {
                "steamId": "76561198000000001",
                "competitiveRankId": 7,
                "competitiveWins": 0,
                "playerLevel": 3,
                "playerXp": 0
            }
        });
        if let Some(mode) = mode {
            value["queue"]["mode"] = serde_json::json!(mode);
        }
        serde_json::from_value(value).unwrap()
    }

    fn queue_intent(mode: QueueMode) -> crate::launcher_bridge::QueueIntent {
        crate::launcher_bridge::QueueIntent {
            request_id: 1,
            game_type: 0,
            client_version: 0,
            prime_only: false,
            mode,
            maps: Vec::new(),
            steam_lobby_id: None,
            member_steam_ids: vec!["76561198000000001".to_string()],
        }
    }

    #[test]
    fn presents_only_a_ten_player_competitive_ready_check() {
        let competitive = bootstrap_with_ready_mode("competitive")
            .ready_check_presentation()
            .unwrap()
            .unwrap();
        assert_eq!(competitive.total_players, 10);
        assert_eq!(competitive.accepted_players, 1);
        assert!(competitive.local_accepted);
        assert_eq!(competitive.map, "Mirage");
        assert_eq!(competitive.seconds_remaining, 120);

        assert!(
            bootstrap_with_ready_mode("deathmatch")
                .ready_check_presentation()
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn reconciles_only_the_matching_committed_native_queue() {
        let competitive = queue_intent(QueueMode::Competitive);
        let deathmatch = queue_intent(QueueMode::Deathmatch);

        assert!(queue_join_committed(
            &bootstrap_with_queue(Some("deathmatch"), "searching"),
            &deathmatch
        ));
        assert!(!queue_join_committed(
            &bootstrap_with_queue(Some("deathmatch"), "searching"),
            &competitive
        ));
        assert!(queue_join_committed(
            &bootstrap_with_queue(None, "ready-check"),
            &competitive
        ));
        assert!(!queue_join_committed(
            &bootstrap_with_queue(Some("deathmatch"), "idle"),
            &deathmatch
        ));
    }

    fn assigned_dm(match_id: &str) -> SessionBootstrap {
        let mut state = bootstrap_with_queue(Some("deathmatch"), "assigned");
        state.assignment = Some(SessionAssignment {
            match_id: match_id.to_string(),
            launcher_url: "unused-in-unit-test".to_string(),
        });
        state
    }

    #[test]
    fn deathmatch_uses_an_automatic_notice_with_no_accept_count_or_gate() {
        let mut handoff = SessionHandoff::default();
        let now = Instant::now();
        let state = assigned_dm("dm-1");
        let notice = handoff.deathmatch_notice(&state, now).unwrap();
        assert!(notice.announcement_only);
        assert!(notice.local_accepted);
        assert_eq!(notice.map, "de_dust2");
        assert_eq!(
            (
                notice.total_players,
                notice.accepted_players,
                notice.seconds_remaining
            ),
            (0, 0, 0)
        );
        assert!(!handoff.can_connect("dm-1", now));
        assert!(!handoff.announcement_completed("wrong-match"));
        assert!(handoff.announcement_completed("dm-1"));
        assert!(handoff.can_connect("dm-1", now));
        handoff.connected("dm-1");
        assert!(handoff.deathmatch_notice(&state, now).is_none());
        assert!(!handoff.can_connect("dm-1", now));
        handoff.queue_committed(QueueMode::Deathmatch);
        assert!(handoff.deathmatch_notice(&state, now).is_some());
        assert!(!handoff.can_connect("dm-1", now));
    }

    #[test]
    fn deathmatch_notice_has_a_bounded_fallback_and_cancel_does_not_reconnect() {
        let mut handoff = SessionHandoff::default();
        let now = Instant::now();
        let state = assigned_dm("dm-1");
        handoff.deathmatch_notice(&state, now);
        handoff.deathmatch_notice(&state, now + Duration::from_secs(2));
        assert!(!handoff.can_connect("dm-1", now + Duration::from_millis(2999)));
        assert!(handoff.can_connect("dm-1", now + Duration::from_secs(3)));
        handoff.cancel_pending();
        assert!(!handoff.announcement_completed("dm-1"));
        assert!(handoff.deathmatch_notice(&state, now).is_none());
        assert!(!handoff.can_connect("dm-1", now + Duration::from_secs(30)));
        handoff.queue_committed(QueueMode::Competitive);
        let mut competitive = state;
        competitive.queue.mode = Some("competitive".to_string());
        assert!(handoff.deathmatch_notice(&competitive, now).is_none());
        assert!(handoff.can_connect("dm-1", now));
    }

    #[test]
    fn explicit_http_rejections_are_not_treated_as_committed_joins() {
        assert!(!join_may_have_committed(
            "B2G matchmaking request returned HTTP 503."
        ));
        assert!(!join_may_have_committed(
            "B2G matchmaking request returned HTTP 403."
        ));
        assert!(join_may_have_committed(
            "B2G matchmaking request failed: timeout: global"
        ));
    }

    #[test]
    fn a_handled_inventory_mutation_does_not_trigger_a_duplicate_full_refresh() {
        let mut current = bootstrap_with_queue(None, "idle");
        current.game_profile.b2g_inventory_version = 40;
        mark_inventory_synchronized(&mut current, Some(41));

        let mut next = current.clone();
        next.game_profile.b2g_inventory_version = 41;
        assert!(!inventory_refresh_required(&current, &next));

        next.game_profile.b2g_inventory_version = 42;
        assert!(inventory_refresh_required(&current, &next));
    }

    #[test]
    fn an_old_api_without_a_bundle_revision_keeps_external_refresh_detection() {
        let mut current = bootstrap_with_queue(None, "idle");
        current.game_profile.b2g_inventory_version = 40;
        mark_inventory_synchronized(&mut current, None);

        let mut next = current.clone();
        next.game_profile.b2g_inventory_version = 41;
        assert!(inventory_refresh_required(&current, &next));
    }

    #[test]
    fn failed_periodic_inventory_refresh_retries_without_discarding_queue_or_profile() {
        let mut applied = bootstrap_with_queue(None, "idle");
        applied.game_profile.b2g_inventory_version = 40;
        let mut advertised = bootstrap_with_queue(Some("deathmatch"), "assigned");
        advertised.game_profile.b2g_inventory_version = 41;
        advertised.game_profile.player_xp = 123;
        assert!(inventory_refresh_required(&applied, &advertised));
        let mut next = advertised.clone();
        finish_inventory_refresh(&applied, &mut next, &Err("HTTP timeout".to_string()));
        assert_eq!(next.queue.phase, "assigned");
        assert_eq!(next.game_profile.player_xp, 123);
        assert_eq!(next.game_profile.b2g_inventory_version, 40);
        assert!(inventory_refresh_required(&next, &advertised));
        finish_inventory_refresh(&next.clone(), &mut next, &Ok(Some(41)));
        assert!(!inventory_refresh_required(&next, &advertised));
    }

    #[test]
    fn periodic_inventory_refresh_tracks_the_fetched_bundle_not_an_older_bootstrap() {
        let mut applied = bootstrap_with_queue(None, "idle");
        applied.game_profile.b2g_inventory_version = 40;
        let mut next = applied.clone();
        next.game_profile.b2g_inventory_version = 41;
        finish_inventory_refresh(&applied, &mut next, &Ok(Some(42)));
        let mut advertised = next.clone();
        advertised.game_profile.b2g_inventory_version = 41;
        assert!(!inventory_refresh_required(&next, &advertised));
        mark_inventory_synchronized(
            &mut advertised,
            Some(next.game_profile.b2g_inventory_version),
        );
        assert_eq!(advertised.game_profile.b2g_inventory_version, 42);
        advertised.game_profile.b2g_inventory_version = 43;
        assert!(inventory_refresh_required(&next, &advertised));
        finish_inventory_refresh(&next, &mut advertised, &Ok(None)); // older API's unversioned bundle
        assert_eq!(advertised.game_profile.b2g_inventory_version, 43);
    }
}
