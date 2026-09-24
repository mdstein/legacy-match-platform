use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

const BRIDGE_MAGIC: u32 = 0x3147_3242;
const BRIDGE_VERSION: u16 = 1;
const HEADER_SIZE: usize = 12;
const MAX_PAYLOAD: usize = 64 * 1024;
const CLIENT_HELLO: u16 = 1;
const QUEUE_START: u16 = 2;
const QUEUE_STOP: u16 = 3;
const READY_ACCEPT: u16 = 4;
const PLAYER_PROFILES_REQUEST: u16 = 5;
const CASE_OPEN_REQUEST: u16 = 6;
const TRADE_UP_REQUEST: u16 = 7;
const LOADOUT_SYNC: u16 = 8;
const INVENTORY_ACKNOWLEDGE: u16 = 9;
const ITEM_RENAME: u16 = 10;
const SPRAY_UNSEAL_REQUEST: u16 = 11;
const SPRAY_USE_REQUEST: u16 = 12;
const QUEUE_START_CORRELATED: u16 = 13;
const QUEUE_STOP_CORRELATED: u16 = 14;
const SERVICE_MEDAL_REQUEST: u16 = 15;
const STATE: u16 = 101;
const ERROR: u16 = 102;
const READY_CHECK: u16 = 103;
const PLAYER_PROFILES: u16 = 104;
const CASE_OPEN_RESULT: u16 = 105;
const INVENTORY_REFRESH: u16 = 106;
const TRADE_UP_RESULT: u16 = 107;
const SPRAY_UNSEAL_RESULT: u16 = 108;
const QUEUE_COMMAND_RESULT: u16 = 109;
const SERVICE_MEDAL_RESULT: u16 = 110;
const MAX_PLAYER_PROFILES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueMode {
    Competitive,
    Deathmatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueIntent {
    pub request_id: u64,
    pub game_type: u32,
    pub client_version: u32,
    pub prime_only: bool,
    pub mode: QueueMode,
    pub maps: Vec<String>,
    pub steam_lobby_id: Option<String>,
    pub member_steam_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeEvent {
    Connected { steam_id: u64 },
    QueueStart(QueueIntent),
    QueueStop { abandon: i32, request_id: u64 },
    QueueRejected { request_id: u64, error: String },
    ReadyAccept { match_id: String },
    PlayerProfilesRequest(PlayerProfilesRequest),
    CaseOpenRequest(CaseOpenRequest),
    TradeUpRequest(TradeUpRequest),
    ServiceMedalRequest(ServiceMedalRequest),
    LoadoutSync(LoadoutSync),
    InventoryAcknowledge(InventoryAcknowledgement),
    ItemRename(ItemRenameRequest),
    SprayUnsealRequest(SprayRequest),
    SprayUseRequest(SprayRequest),
    ProtocolError(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaseOpenRequest {
    pub case_asset_id: u64,
    pub key_asset_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseOpenCompletion {
    pub case_asset_id: u64,
    pub key_asset_id: u64,
    pub result_asset_id: Option<u64>,
    pub item_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TradeUpRequest {
    pub recipe: i16,
    pub input_asset_ids: [u64; 10],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TradeUpCompletion {
    pub recipe_index: i16,
    pub input_asset_ids: [u64; 10],
    pub result_asset_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceMedalRequest {
    pub request_id: u64,
    pub definition_index: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ServiceMedalCompletion {
    pub request_id: u64,
    pub asset_id: u64,
    pub definition_index: u32,
    pub prestige_time: u32,
    pub player_level: u32,
    pub player_xp: u32,
    pub succeeded: bool,
    pub redeemed: bool,
    pub failure_reason: u16, // 0 transport/unknown, 1 level, 2 capacity, 3 exhausted
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadoutSync {
    pub asset_ids: Vec<u64>,
    pub ownership_generations: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventoryAcknowledgement {
    pub positions: Vec<(u64, u32)>,
    pub ownership_generations: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemRenameRequest {
    pub asset_id: u64,
    pub custom_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SprayRequest {
    pub asset_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SprayUnsealCompletion {
    pub sealed_asset_id: u64,
    pub result_asset_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BridgeState {
    pub rank_id: u32,
    pub wins: u32,
    pub player_level: u32,
    pub player_xp: u32,
    pub queue_phase: u32,
    pub players_online: u32,
    pub servers_online: u32,
    pub players_searching: u32,
    pub ongoing_matches: u32,
    pub estimated_wait_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyCheckPresentation {
    pub announcement_only: bool,
    pub match_id: String,
    pub map: String,
    pub accepted_players: u32,
    pub total_players: u32,
    pub seconds_remaining: u32,
    pub local_accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerProfilesRequest {
    pub has_request_id: bool,
    pub request_id: u32,
    pub account_ids: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlayerProfilePresentation {
    pub account_id: u32,
    pub rank_id: u32,
    pub wins: u32,
    pub player_level: u32,
    pub player_xp: u32,
}

#[derive(Debug)]
struct Frame {
    message_type: u16,
    payload: Vec<u8>,
}

fn encode_frame(message_type: u16, payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_PAYLOAD {
        return Err("Launcher bridge payload exceeds 64 KiB.".to_string());
    }
    let mut frame = Vec::with_capacity(HEADER_SIZE + payload.len());
    frame.extend_from_slice(&BRIDGE_MAGIC.to_le_bytes());
    frame.extend_from_slice(&BRIDGE_VERSION.to_le_bytes());
    frame.extend_from_slice(&message_type.to_le_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

fn drain_frames(buffer: &mut Vec<u8>) -> Result<Vec<Frame>, String> {
    let mut frames = Vec::new();
    let mut consumed = 0;
    while buffer.len().saturating_sub(consumed) >= HEADER_SIZE {
        let header = &buffer[consumed..consumed + HEADER_SIZE];
        let magic = u32::from_le_bytes(header[0..4].try_into().unwrap());
        let version = u16::from_le_bytes(header[4..6].try_into().unwrap());
        let message_type = u16::from_le_bytes(header[6..8].try_into().unwrap());
        let payload_size = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
        if magic != BRIDGE_MAGIC || version != BRIDGE_VERSION || payload_size > MAX_PAYLOAD {
            return Err("The in-game launcher bridge sent an invalid frame.".to_string());
        }
        let frame_size = HEADER_SIZE + payload_size;
        if buffer.len() - consumed < frame_size {
            break;
        }
        frames.push(Frame {
            message_type,
            payload: buffer[consumed + HEADER_SIZE..consumed + frame_size].to_vec(),
        });
        consumed += frame_size;
    }
    if consumed > 0 {
        buffer.drain(..consumed);
    }
    if buffer.len() > HEADER_SIZE + MAX_PAYLOAD {
        return Err("The in-game launcher bridge buffer is invalid.".to_string());
    }
    Ok(frames)
}

fn read_varint(data: &[u8], offset: &mut usize) -> Result<u64, String> {
    let mut value = 0_u64;
    for shift in (0..64).step_by(7) {
        let byte = *data
            .get(*offset)
            .ok_or_else(|| "Truncated matchmaking protobuf.".to_string())?;
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("Invalid matchmaking protobuf varint.".to_string())
}

fn skip_field(data: &[u8], offset: &mut usize, wire_type: u64) -> Result<(), String> {
    let length = match wire_type {
        0 => {
            read_varint(data, offset)?;
            return Ok(());
        }
        1 => 8,
        2 => usize::try_from(read_varint(data, offset)?)
            .map_err(|_| "Invalid matchmaking protobuf length.".to_string())?,
        5 => 4,
        _ => return Err("Unsupported matchmaking protobuf wire type.".to_string()),
    };
    *offset = offset
        .checked_add(length)
        .filter(|end| *end <= data.len())
        .ok_or_else(|| "Truncated matchmaking protobuf field.".to_string())?;
    Ok(())
}

#[derive(Default)]
struct MatchmakingStartFields {
    account_ids: Vec<u32>,
    game_type: u32,
    client_version: u32,
    prime_only: bool,
    ticket_data: String,
    lobby_id: u64,
}

fn parse_matchmaking_start(data: &[u8]) -> Result<MatchmakingStartFields, String> {
    let mut result = MatchmakingStartFields::default();
    let mut offset = 0;
    while offset < data.len() {
        let tag = read_varint(data, &mut offset)?;
        let field = tag >> 3;
        let wire_type = tag & 7;
        match (field, wire_type) {
            (1, 0) => {
                let account_id = read_varint(data, &mut offset)?;
                result.account_ids.push(
                    u32::try_from(account_id)
                        .map_err(|_| "Invalid matchmaking party member.".to_string())?,
                );
            }
            (1, 2) => {
                let length = usize::try_from(read_varint(data, &mut offset)?)
                    .map_err(|_| "Invalid matchmaking party length.".to_string())?;
                let end = offset
                    .checked_add(length)
                    .filter(|end| *end <= data.len() && length <= 64)
                    .ok_or_else(|| "Invalid matchmaking party.".to_string())?;
                while offset < end {
                    let account_id = read_varint(&data[..end], &mut offset)?;
                    result.account_ids.push(
                        u32::try_from(account_id)
                            .map_err(|_| "Invalid matchmaking party member.".to_string())?,
                    );
                }
            }
            (2, 0) => result.game_type = read_varint(data, &mut offset)? as u32,
            (3, 2) => {
                let length = usize::try_from(read_varint(data, &mut offset)?)
                    .map_err(|_| "Invalid matchmaking ticket length.".to_string())?;
                let end = offset
                    .checked_add(length)
                    .filter(|end| *end <= data.len() && length <= 16 * 1024)
                    .ok_or_else(|| "Invalid matchmaking ticket.".to_string())?;
                result.ticket_data = std::str::from_utf8(&data[offset..end])
                    .map_err(|_| "Matchmaking ticket is not UTF-8.".to_string())?
                    .to_string();
                offset = end;
            }
            (4, 0) => result.client_version = read_varint(data, &mut offset)? as u32,
            (6, 0) => result.prime_only = read_varint(data, &mut offset)? != 0,
            (8, 0) => result.lobby_id = read_varint(data, &mut offset)?,
            _ => skip_field(data, &mut offset, wire_type)?,
        }
    }
    Ok(result)
}

fn parse_matchmaking_stop(data: &[u8]) -> Result<i32, String> {
    let mut offset = 0;
    while offset < data.len() {
        let tag = read_varint(data, &mut offset)?;
        if tag >> 3 == 1 && tag & 7 == 0 {
            return Ok(read_varint(data, &mut offset)? as i32);
        }
        skip_field(data, &mut offset, tag & 7)?;
    }
    Ok(0)
}

fn parse_player_profiles_request(data: &[u8]) -> Result<PlayerProfilesRequest, String> {
    if data.len() < 12 {
        return Err("The in-game profile request is truncated.".to_string());
    }
    let has_request_id = data[0];
    let request_id = u32::from_le_bytes(data[4..8].try_into().unwrap());
    let count = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    if has_request_id > 1
        || data[1..4] != [0, 0, 0]
        || count == 0
        || count > MAX_PLAYER_PROFILES
        || data.len() != 12 + count * 4
    {
        return Err("The in-game profile request is invalid.".to_string());
    }
    let mut account_ids = Vec::with_capacity(count);
    for chunk in data[12..].chunks_exact(4) {
        let account_id = u32::from_le_bytes(chunk.try_into().unwrap());
        if account_id == 0 || account_ids.contains(&account_id) {
            return Err("The in-game profile request contains an invalid account.".to_string());
        }
        account_ids.push(account_id);
    }
    Ok(PlayerProfilesRequest {
        has_request_id: has_request_id != 0,
        request_id,
        account_ids,
    })
}

fn parse_case_open_request(data: &[u8]) -> Result<CaseOpenRequest, String> {
    if data.len() != 16 {
        return Err("The in-game case-opening request is invalid.".to_string());
    }
    let case_asset_id = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let key_asset_id = u64::from_le_bytes(data[8..16].try_into().unwrap());
    if case_asset_id == 0 || case_asset_id == key_asset_id {
        return Err("The in-game case-opening request is invalid.".to_string());
    }
    Ok(CaseOpenRequest {
        case_asset_id,
        key_asset_id,
    })
}

fn parse_trade_up_request(data: &[u8]) -> Result<TradeUpRequest, String> {
    if data.len() != 88 {
        return Err("The in-game Trade Up request is invalid.".to_string());
    }
    let recipe = i16::from_le_bytes(data[0..2].try_into().unwrap());
    let item_count = u16::from_le_bytes(data[2..4].try_into().unwrap());
    if item_count != 10 || data[4..8] != [0, 0, 0, 0] {
        return Err("The in-game Trade Up request is invalid.".to_string());
    }
    let mut input_asset_ids = [0_u64; 10];
    for (index, chunk) in data[8..].chunks_exact(8).enumerate() {
        let asset_id = u64::from_le_bytes(chunk.try_into().unwrap());
        if asset_id == 0 || input_asset_ids[..index].contains(&asset_id) {
            return Err("The in-game Trade Up request contains an invalid item.".to_string());
        }
        input_asset_ids[index] = asset_id;
    }
    Ok(TradeUpRequest {
        recipe,
        input_asset_ids,
    })
}

fn parse_loadout_sync(data: &[u8]) -> Result<LoadoutSync, String> {
    if data.len() < 4 {
        return Err("The in-game loadout snapshot is truncated.".to_string());
    }
    let count = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    let extended = data[2..4] == [1, 0];let stride=if extended {16}else{8};
    if (!extended && data[2..4] != [0, 0]) || count > 64 || data.len() != 4 + count * stride {
        return Err("The in-game loadout snapshot is invalid.".to_string());
    }
    let mut asset_ids = Vec::with_capacity(count);
    let mut ownership_generations=std::collections::BTreeMap::new();
    for chunk in data[4..].chunks_exact(stride) {
        let asset_id = u64::from_le_bytes(chunk[..8].try_into().unwrap());
        let generation=if extended {u64::from_le_bytes(chunk[8..16].try_into().unwrap())}else{0};
        if asset_id == 0 || asset_ids.contains(&asset_id) || generation>i64::MAX as u64 {
            return Err("The in-game loadout snapshot contains an invalid item.".to_string());
        }
        asset_ids.push(asset_id);
        if extended {ownership_generations.insert(asset_id.to_string(),generation.to_string());}
    }
    Ok(LoadoutSync { asset_ids, ownership_generations })
}

fn parse_inventory_acknowledgement(data: &[u8]) -> Result<InventoryAcknowledgement, String> {
    if data.len() < 4 {
        return Err("The in-game inventory acknowledgement is truncated.".to_string());
    }
    let count = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    let extended = data[2..4] == [1, 0];let stride=if extended {20}else{12};
    if (!extended && data[2..4] != [0, 0]) || count > 512 || data.len() != 4 + count * stride {
        return Err("The in-game inventory acknowledgement is invalid.".to_string());
    }
    let mut positions = Vec::with_capacity(count);
    let mut ownership_generations=std::collections::BTreeMap::new();
    for chunk in data[4..].chunks_exact(stride) {
        let asset_id = u64::from_le_bytes(chunk[0..8].try_into().unwrap());
        let position = u32::from_le_bytes(chunk[8..12].try_into().unwrap());
        let generation=if extended {u64::from_le_bytes(chunk[12..20].try_into().unwrap())}else{0};
        if asset_id == 0
            || generation>i64::MAX as u64
            || position >= 0x4000_0000
            || positions
                .iter()
                .any(|entry: &(u64, u32)| entry.0 == asset_id)
        {
            return Err(
                "The in-game inventory acknowledgement contains an invalid item.".to_string(),
            );
        }
        positions.push((asset_id, position));
        if extended {ownership_generations.insert(asset_id.to_string(),generation.to_string());}
    }
    Ok(InventoryAcknowledgement { positions, ownership_generations })
}

fn parse_item_rename(data: &[u8]) -> Result<ItemRenameRequest, String> {
    if data.len() < 12 {
        return Err("The in-game item naming request is truncated.".to_string());
    }
    let asset_id = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let name_bytes = u16::from_le_bytes(data[8..10].try_into().unwrap()) as usize;
    if asset_id == 0 || data[10..12] != [0, 0] || name_bytes > 100 || data.len() != 12 + name_bytes
    {
        return Err("The in-game item naming request is invalid.".to_string());
    }
    let custom_name = std::str::from_utf8(&data[12..])
        .map_err(|_| "The in-game item name is not UTF-8.".to_string())?
        .to_string();
    if custom_name.chars().any(char::is_control) {
        return Err("The in-game item name contains control characters.".to_string());
    }
    Ok(ItemRenameRequest {
        asset_id,
        custom_name,
    })
}

fn parse_spray_request(data: &[u8]) -> Result<SprayRequest, String> {
    if data.len() != 8 {
        return Err("The in-game graffiti request is invalid.".to_string());
    }
    let asset_id = u64::from_le_bytes(data.try_into().unwrap());
    if asset_id == 0 {
        return Err("The in-game graffiti request is invalid.".to_string());
    }
    Ok(SprayRequest { asset_id })
}

#[derive(Deserialize, Default)]
struct PlaySettings {
    #[serde(default)]
    mode: String,
}

fn competitive_maps(game_type: u32) -> Vec<String> {
    const MAP_BITS: &[(u32, &str)] = &[
        (2_048, "Ancient"),
        (8_388_608, "Anubis"),
        (4_096, "Inferno"),
        (32_768, "Mirage"),
        (8_192, "Nuke"),
        (268_435_456, "Overpass"),
        (16_384, "Vertigo"),
    ];
    let selected = MAP_BITS
        .iter()
        .filter(|(bit, _)| game_type & bit != 0)
        .map(|(_, map)| (*map).to_string())
        .collect::<Vec<_>>();
    if selected.is_empty() || game_type & 33_554_432 != 0 {
        MAP_BITS.iter().map(|(_, map)| (*map).to_string()).collect()
    } else {
        selected
    }
}

fn queue_intent(data: &[u8], expected_steam_id: u64) -> Result<QueueIntent, String> {
    const STEAM_ID64_INDIVIDUAL_BASE: u64 = 76_561_197_960_265_728;
    // The final September 2023 Panorama client sends no ticket_data for its
    // native play menu and encodes Free For All Deathmatch as exactly 0x206.
    // Keep this exact so Casual/War Games/Danger Zone values that share the
    // same low-byte mode flags are never routed into B2G Deathmatch.
    const FINAL_2023_DEATHMATCH_GAME_TYPE: u32 = 518;
    let fields = parse_matchmaking_start(data)?;
    let settings = if fields.ticket_data.is_empty() {
        PlaySettings::default()
    } else {
        serde_json::from_str::<PlaySettings>(&fields.ticket_data)
            .map_err(|_| "Panorama sent invalid matchmaking play settings.".to_string())?
    };
    let mode_name = settings.mode.trim().to_ascii_lowercase();
    let mode = if mode_name == "deathmatch"
        || (mode_name.is_empty() && fields.game_type == FINAL_2023_DEATHMATCH_GAME_TYPE)
    {
        QueueMode::Deathmatch
    } else if matches!(
        mode_name.as_str(),
        "competitive" | "competitive_unranked" | "premier" | "comp"
    ) || fields.game_type & 0xff & 0x08 != 0
    {
        QueueMode::Competitive
    } else {
        return Err(format!(
            "B2G does not support Panorama matchmaking mode '{}' (game_type={}).",
            if mode_name.is_empty() {
                "unknown"
            } else {
                &mode_name
            },
            fields.game_type
        ));
    };
    let maps = match mode {
        QueueMode::Competitive => competitive_maps(fields.game_type),
        QueueMode::Deathmatch => Vec::new(),
    };
    let local_account_id = expected_steam_id as u32;
    let mut account_ids = fields.account_ids;
    if account_ids.is_empty() {
        account_ids.push(local_account_id);
    }
    account_ids.sort_unstable();
    account_ids.dedup();
    if account_ids.is_empty()
        || account_ids.len() > 5
        || account_ids.iter().any(|account_id| *account_id == 0)
        || !account_ids.contains(&local_account_id)
    {
        return Err("Panorama sent an invalid Steam party roster.".to_string());
    }
    if account_ids.len() > 1 && fields.lobby_id == 0 {
        return Err("Panorama sent a party without a Steam lobby identifier.".to_string());
    }
    let member_steam_ids = account_ids
        .into_iter()
        .map(|account_id| (STEAM_ID64_INDIVIDUAL_BASE + u64::from(account_id)).to_string())
        .collect::<Vec<_>>();
    Ok(QueueIntent {
        request_id: 0, // Legacy bridge messages carry no correlation ID.
        game_type: fields.game_type,
        client_version: fields.client_version,
        prime_only: fields.prime_only,
        mode,
        maps,
        steam_lobby_id: (member_steam_ids.len() > 1).then(|| fields.lobby_id.to_string()),
        member_steam_ids,
    })
}

fn state_payload(state: BridgeState) -> Vec<u8> {
    [
        state.rank_id,
        state.wins,
        state.player_level,
        state.player_xp,
        state.queue_phase,
        state.players_online,
        state.servers_online,
        state.players_searching,
        state.ongoing_matches,
        state.estimated_wait_seconds,
    ]
    .into_iter()
    .flat_map(u32::to_le_bytes)
    .collect()
}

fn native_map_id(map: &str) -> Result<&'static str, String> {
    match map.trim().to_ascii_lowercase().as_str() {
        "dust ii" | "dust2" | "de_dust2" => Ok("de_dust2"),
        "ancient" | "de_ancient" => Ok("de_ancient"),
        "anubis" | "de_anubis" => Ok("de_anubis"),
        "inferno" | "de_inferno" => Ok("de_inferno"),
        "mirage" | "de_mirage" => Ok("de_mirage"),
        "nuke" | "de_nuke" => Ok("de_nuke"),
        "overpass" | "de_overpass" => Ok("de_overpass"),
        "vertigo" | "de_vertigo" => Ok("de_vertigo"),
        _ => Err("B2G returned an unsupported ready-check map.".to_string()),
    }
}

fn is_uuid_bytes(value: &[u8]) -> bool {
    value.len() == 36
        && value.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn ready_check_payload(ready: Option<&ReadyCheckPresentation>) -> Result<Vec<u8>, String> {
    let mut payload = vec![0_u8; 84];
    let Some(ready) = ready else {
        return Ok(payload);
    };
    if !is_uuid_bytes(ready.match_id.as_bytes())
        || (!ready.announcement_only && ready.total_players == 0)
        || ready.total_players > 16
        || ready.accepted_players > ready.total_players
        || ready.seconds_remaining > 120
        || (ready.announcement_only
            && (ready.total_players != 0
                || ready.accepted_players != 0
                || ready.seconds_remaining != 0
                || !ready.local_accepted
                || native_map_id(&ready.map)? != "de_dust2"))
    {
        return Err("B2G returned invalid native ready-check state.".to_string());
    }
    let map = native_map_id(&ready.map)?;
    payload[0] = 1;
    payload[1] = u8::from(ready.local_accepted);
    payload[2] = u8::from(ready.announcement_only);
    payload[4..8].copy_from_slice(&ready.accepted_players.to_le_bytes());
    payload[8..12].copy_from_slice(&ready.total_players.to_le_bytes());
    payload[12..16].copy_from_slice(&ready.seconds_remaining.to_le_bytes());
    payload[16..52].copy_from_slice(ready.match_id.as_bytes());
    payload[52..52 + map.len()].copy_from_slice(map.as_bytes());
    Ok(payload)
}

fn queue_result_payload(
    request_id: u64,
    queue_phase: u32,
    error: Option<&str>,
) -> Result<Vec<u8>, String> {
    if request_id == 0 || queue_phase > 4 {
        return Err("Invalid queue command result.".to_string());
    }
    let mut payload = request_id.to_le_bytes().to_vec();
    payload.extend_from_slice(&queue_phase.to_le_bytes());
    for character in error.unwrap_or("").chars().filter(|c| !c.is_control()) {
        let mut bytes = [0; 4];
        let encoded = character.encode_utf8(&mut bytes);
        if payload.len() + encoded.len() > 12 + 512 {
            break;
        }
        payload.extend_from_slice(encoded.as_bytes());
    }
    Ok(payload)
}

fn player_profiles_payload(
    request: &PlayerProfilesRequest,
    profiles: &[PlayerProfilePresentation],
) -> Result<Vec<u8>, String> {
    if request.account_ids.is_empty()
        || request.account_ids.len() > MAX_PLAYER_PROFILES
        || profiles.len() != request.account_ids.len()
    {
        return Err("B2G returned an invalid player-profile response.".to_string());
    }
    let mut payload = Vec::with_capacity(12 + profiles.len() * 20);
    payload.push(u8::from(request.has_request_id));
    payload.extend_from_slice(&[0, 0, 0]);
    payload.extend_from_slice(&request.request_id.to_le_bytes());
    payload.extend_from_slice(&(profiles.len() as u32).to_le_bytes());
    for (expected_account_id, profile) in request.account_ids.iter().zip(profiles) {
        if profile.account_id != *expected_account_id
            || profile.account_id == 0
            || profile.rank_id > 18
            || profile.player_level > 40
            || profile.player_xp > 999
            || (profile.player_level == 0 && profile.player_xp != 0)
        {
            return Err("B2G returned an invalid player profile.".to_string());
        }
        for value in [
            profile.account_id,
            profile.rank_id,
            profile.wins,
            profile.player_level,
            profile.player_xp,
        ] {
            payload.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(payload)
}

fn case_open_result_payload(completion: CaseOpenCompletion) -> Result<Vec<u8>, String> {
    let item_name = completion.item_name.as_deref().unwrap_or("");
    if completion.result_asset_id.is_some() != completion.item_name.is_some()
        || item_name.is_empty() != completion.result_asset_id.is_none()
        || item_name.len() > 160
        || item_name.chars().any(char::is_control)
    {
        return Err("B2G returned an invalid case reward name.".to_string());
    }
    let mut payload = Vec::with_capacity(192);
    payload.push(u8::from(completion.result_asset_id.is_some()));
    payload.push(0);
    payload.extend_from_slice(&(item_name.len() as u16).to_le_bytes());
    payload.extend_from_slice(&[0; 4]);
    payload.extend_from_slice(&completion.case_asset_id.to_le_bytes());
    payload.extend_from_slice(&completion.key_asset_id.to_le_bytes());
    payload.extend_from_slice(&completion.result_asset_id.unwrap_or(0).to_le_bytes());
    payload.extend_from_slice(item_name.as_bytes());
    payload.resize(192, 0);
    Ok(payload)
}

fn trade_up_result_payload(completion: TradeUpCompletion) -> Vec<u8> {
    let mut payload = Vec::with_capacity(96);
    payload.push(u8::from(completion.result_asset_id.is_some()));
    payload.push(0);
    payload.extend_from_slice(&completion.recipe_index.to_le_bytes());
    payload.extend_from_slice(&[0; 4]);
    payload.extend_from_slice(&completion.result_asset_id.unwrap_or(0).to_le_bytes());
    for asset_id in completion.input_asset_ids {
        payload.extend_from_slice(&asset_id.to_le_bytes());
    }
    payload
}

fn parse_service_medal_request(data: &[u8]) -> Result<ServiceMedalRequest, String> {
    if data.len() != 16 || data[12..16] != [0; 4] {
        return Err("Invalid service medal request size or reserved fields.".to_string());
    }
    let request = ServiceMedalRequest {
        request_id: u64::from_le_bytes(data[0..8].try_into().unwrap()),
        definition_index: u32::from_le_bytes(data[8..12].try_into().unwrap()),
    };
    if request.request_id == 0 || request.definition_index > u16::MAX as u32 {
        return Err("Invalid service medal request identity or definition.".to_string());
    }
    Ok(request)
}

fn service_medal_result_payload(result: ServiceMedalCompletion) -> Vec<u8> {
    let mut payload = Vec::with_capacity(36);
    payload.extend_from_slice(&result.request_id.to_le_bytes());
    payload.extend_from_slice(&result.asset_id.to_le_bytes());
    payload.extend_from_slice(&result.definition_index.to_le_bytes());
    payload.extend_from_slice(&result.prestige_time.to_le_bytes());
    payload.extend_from_slice(&result.player_level.to_le_bytes());
    payload.extend_from_slice(&result.player_xp.to_le_bytes());
    payload.push(u8::from(result.succeeded));
    payload.push(u8::from(result.redeemed));
    payload.extend_from_slice(&result.failure_reason.to_le_bytes());
    payload
}

fn spray_unseal_result_payload(completion: SprayUnsealCompletion) -> Vec<u8> {
    let mut payload = Vec::with_capacity(24);
    payload.push(u8::from(completion.result_asset_id.is_some()));
    payload.extend_from_slice(&[0; 7]);
    payload.extend_from_slice(&completion.sealed_asset_id.to_le_bytes());
    payload.extend_from_slice(&completion.result_asset_id.unwrap_or(0).to_le_bytes());
    payload
}

pub struct LauncherBridgeServer {
    events: mpsc::Receiver<BridgeEvent>,
    outbound: mpsc::Sender<Frame>,
    stopping: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl LauncherBridgeServer {
    pub fn start(expected_game_binary: &Path, expected_steam_id: u64) -> Result<Self, String> {
        platform::start(expected_game_binary, expected_steam_id)
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<BridgeEvent, mpsc::RecvTimeoutError> {
        self.events.recv_timeout(timeout)
    }

    pub fn send_state(&self, state: BridgeState) -> Result<(), String> {
        self.outbound
            .send(Frame {
                message_type: STATE,
                payload: state_payload(state),
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_error(&self, message: &str) -> Result<(), String> {
        let clean = message
            .chars()
            .filter(|character| !character.is_control() || *character == '\t')
            .take(512)
            .collect::<String>();
        self.outbound
            .send(Frame {
                message_type: ERROR,
                payload: clean.into_bytes(),
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_ready_check(&self, ready: Option<&ReadyCheckPresentation>) -> Result<(), String> {
        self.outbound
            .send(Frame {
                message_type: READY_CHECK,
                payload: ready_check_payload(ready)?,
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_queue_result(
        &self,
        request_id: u64,
        queue_phase: u32,
        error: Option<&str>,
    ) -> Result<(), String> {
        // Older clients keep the original error channel; new clients receive
        // a correlated completion so an old response cannot undo CANCEL.
        if request_id == 0 {
            return error.map_or(Ok(()), |message| self.send_error(message));
        }
        self.outbound
            .send(Frame {
                message_type: QUEUE_COMMAND_RESULT,
                payload: queue_result_payload(request_id, queue_phase, error)?,
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_player_profiles(
        &self,
        request: &PlayerProfilesRequest,
        profiles: &[PlayerProfilePresentation],
    ) -> Result<(), String> {
        self.outbound
            .send(Frame {
                message_type: PLAYER_PROFILES,
                payload: player_profiles_payload(request, profiles)?,
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_case_open_result(&self, completion: CaseOpenCompletion) -> Result<(), String> {
        self.outbound
            .send(Frame {
                message_type: CASE_OPEN_RESULT,
                payload: case_open_result_payload(completion)?,
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_inventory_refresh(&self) -> Result<(), String> {
        self.outbound
            .send(Frame {
                message_type: INVENTORY_REFRESH,
                payload: Vec::new(),
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_trade_up_result(&self, completion: TradeUpCompletion) -> Result<(), String> {
        self.outbound
            .send(Frame {
                message_type: TRADE_UP_RESULT,
                payload: trade_up_result_payload(completion),
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_service_medal_result(&self, completion: ServiceMedalCompletion) -> Result<(), String> {
        self.outbound.send(Frame {
            message_type: SERVICE_MEDAL_RESULT,
            payload: service_medal_result_payload(completion),
        }).map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }

    pub fn send_spray_unseal_result(
        &self,
        completion: SprayUnsealCompletion,
    ) -> Result<(), String> {
        self.outbound
            .send(Frame {
                message_type: SPRAY_UNSEAL_RESULT,
                payload: spray_unseal_result_payload(completion),
            })
            .map_err(|_| "The launcher bridge stopped unexpectedly.".to_string())
    }
}

impl Drop for LauncherBridgeServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn dispatch_frame(
    frame: Frame,
    expected_steam_id: u64,
    hello_received: &mut bool,
) -> Result<Option<BridgeEvent>, String> {
    match frame.message_type {
        CLIENT_HELLO => {
            if frame.payload.len() != 8 {
                return Err("The in-game launcher bridge sent an invalid identity.".to_string());
            }
            let steam_id = u64::from_le_bytes(frame.payload.as_slice().try_into().unwrap());
            if steam_id != expected_steam_id {
                return Err(
                    "The running CS:GO Steam account does not match the paired B2G account."
                        .to_string(),
                );
            }
            *hello_received = true;
            Ok(Some(BridgeEvent::Connected { steam_id }))
        }
        QUEUE_START if *hello_received => queue_intent(&frame.payload, expected_steam_id)
            .map(BridgeEvent::QueueStart)
            .map(Some),
        QUEUE_STOP if *hello_received => parse_matchmaking_stop(&frame.payload).map(|abandon| {
            Some(BridgeEvent::QueueStop {
                abandon,
                request_id: 0,
            })
        }),
        QUEUE_START_CORRELATED | QUEUE_STOP_CORRELATED if *hello_received => {
            if frame.payload.len() < 8 {
                return Err("Truncated queue command.".to_string());
            }
            let request_id = u64::from_le_bytes(frame.payload[..8].try_into().unwrap());
            if request_id == 0 {
                return Err("Invalid queue command identifier.".to_string());
            }
            if frame.message_type == QUEUE_START_CORRELATED {
                let mut intent = match queue_intent(&frame.payload[8..], expected_steam_id) {
                    Ok(intent) => intent,
                    Err(error) => {
                        return Ok(Some(BridgeEvent::QueueRejected { request_id, error }));
                    }
                };
                intent.request_id = request_id;
                Ok(Some(BridgeEvent::QueueStart(intent)))
            } else {
                match parse_matchmaking_stop(&frame.payload[8..]) {
                    Ok(abandon) => Ok(Some(BridgeEvent::QueueStop {
                        abandon,
                        request_id,
                    })),
                    Err(error) => Ok(Some(BridgeEvent::QueueRejected { request_id, error })),
                }
            }
        }
        READY_ACCEPT if *hello_received => {
            if !is_uuid_bytes(&frame.payload) {
                return Err("The in-game ready check sent an invalid match identifier.".to_string());
            }
            Ok(Some(BridgeEvent::ReadyAccept {
                match_id: String::from_utf8(frame.payload)
                    .map_err(|_| "The in-game ready check sent invalid text.".to_string())?,
            }))
        }
        PLAYER_PROFILES_REQUEST if *hello_received => parse_player_profiles_request(&frame.payload)
            .map(BridgeEvent::PlayerProfilesRequest)
            .map(Some),
        CASE_OPEN_REQUEST if *hello_received => parse_case_open_request(&frame.payload)
            .map(BridgeEvent::CaseOpenRequest)
            .map(Some),
        TRADE_UP_REQUEST if *hello_received => parse_trade_up_request(&frame.payload)
            .map(BridgeEvent::TradeUpRequest)
            .map(Some),
        SERVICE_MEDAL_REQUEST if *hello_received => parse_service_medal_request(&frame.payload)
            .map(BridgeEvent::ServiceMedalRequest).map(Some),
        LOADOUT_SYNC if *hello_received => parse_loadout_sync(&frame.payload)
            .map(BridgeEvent::LoadoutSync)
            .map(Some),
        INVENTORY_ACKNOWLEDGE if *hello_received => parse_inventory_acknowledgement(&frame.payload)
            .map(BridgeEvent::InventoryAcknowledge)
            .map(Some),
        ITEM_RENAME if *hello_received => parse_item_rename(&frame.payload)
            .map(BridgeEvent::ItemRename)
            .map(Some),
        SPRAY_UNSEAL_REQUEST if *hello_received => parse_spray_request(&frame.payload)
            .map(BridgeEvent::SprayUnsealRequest)
            .map(Some),
        SPRAY_USE_REQUEST if *hello_received => parse_spray_request(&frame.payload)
            .map(BridgeEvent::SprayUseRequest)
            .map(Some),
        QUEUE_START
        | QUEUE_START_CORRELATED
        | QUEUE_STOP_CORRELATED
        | QUEUE_STOP
        | READY_ACCEPT
        | PLAYER_PROFILES_REQUEST
        | CASE_OPEN_REQUEST
        | TRADE_UP_REQUEST
        | SERVICE_MEDAL_REQUEST
        | LOADOUT_SYNC
        | INVENTORY_ACKNOWLEDGE
        | ITEM_RENAME
        | SPRAY_UNSEAL_REQUEST
        | SPRAY_USE_REQUEST => {
            Err("The in-game launcher bridge sent queue intent before identity.".to_string())
        }
        _ => Err(format!(
            "The in-game launcher bridge sent unknown message type {}.",
            frame.message_type
        )),
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::io;
    use std::ptr;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{PIPE_ACCESS_DUPLEX, ReadFile, WriteFile};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
        PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    };

    const PIPE_NAME: &str = r"\\.\pipe\B2G.Launcher.v1";

    struct Pipe(windows_sys::Win32::Foundation::HANDLE);

    impl Drop for Pipe {
        fn drop(&mut self) {
            unsafe {
                DisconnectNamedPipe(self.0);
                CloseHandle(self.0);
            }
        }
    }

    fn create_pipe(pipe_name: &str) -> Result<Pipe, String> {
        let name = pipe_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                MAX_PAYLOAD as u32,
                MAX_PAYLOAD as u32,
                250,
                ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "Could not create the local launcher bridge: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Pipe(handle))
    }

    fn connected(pipe: &Pipe) -> Result<bool, String> {
        if unsafe { ConnectNamedPipe(pipe.0, ptr::null_mut()) } != 0 {
            return Ok(true);
        }
        match io::Error::last_os_error()
            .raw_os_error()
            .map(|value| value as u32)
        {
            Some(ERROR_PIPE_CONNECTED) => Ok(true),
            Some(ERROR_PIPE_LISTENING) | Some(ERROR_NO_DATA) => Ok(false),
            _ => Err(format!(
                "Could not accept the in-game launcher bridge: {}",
                io::Error::last_os_error()
            )),
        }
    }

    fn verified_client(pipe: &Pipe, expected_game_binary: &Path) -> Result<(), String> {
        let mut process_id = 0_u32;
        if unsafe { GetNamedPipeClientProcessId(pipe.0, &mut process_id) } == 0 || process_id == 0 {
            return Err("Windows could not identify the launcher bridge client.".to_string());
        }
        let actual = super::super::windows_process_path(process_id)?;
        if !super::super::same_windows_path(&actual, expected_game_binary) {
            return Err(format!(
                "Rejected launcher bridge client PID {process_id} because it is not the verified CS:GO executable."
            ));
        }
        Ok(())
    }

    fn write_frame(pipe: &Pipe, frame: Frame) -> Result<(), String> {
        let bytes = encode_frame(frame.message_type, &frame.payload)?;
        let mut offset = 0;
        while offset < bytes.len() {
            let mut written = 0_u32;
            let result = unsafe {
                WriteFile(
                    pipe.0,
                    bytes[offset..].as_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            };
            if result == 0 || written == 0 {
                return Err(format!(
                    "Could not write to the in-game launcher bridge: {}",
                    io::Error::last_os_error()
                ));
            }
            offset += written as usize;
        }
        Ok(())
    }

    fn run_client(
        pipe: &Pipe,
        expected_steam_id: u64,
        events: &mpsc::Sender<BridgeEvent>,
        outbound: &mpsc::Receiver<Frame>,
        stopping: &AtomicBool,
    ) {
        let mut pending = Vec::new();
        let mut hello_received = false;
        while !stopping.load(Ordering::Acquire) {
            while let Ok(frame) = outbound.try_recv() {
                if let Err(error) = write_frame(pipe, frame) {
                    let _ = events.send(BridgeEvent::ProtocolError(error));
                    return;
                }
            }
            let mut chunk = [0_u8; 4096];
            let mut read = 0_u32;
            let result = unsafe {
                ReadFile(
                    pipe.0,
                    chunk.as_mut_ptr(),
                    chunk.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            };
            if result != 0 && read > 0 {
                pending.extend_from_slice(&chunk[..read as usize]);
                match drain_frames(&mut pending) {
                    Ok(frames) => {
                        for frame in frames {
                            match dispatch_frame(frame, expected_steam_id, &mut hello_received) {
                                Ok(Some(event)) => {
                                    let _ = events.send(event);
                                }
                                Ok(None) => {}
                                Err(error) => {
                                    let _ = events.send(BridgeEvent::ProtocolError(error));
                                    return;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let _ = events.send(BridgeEvent::ProtocolError(error));
                        return;
                    }
                }
            } else if result == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error().map(|value| value as u32) != Some(ERROR_NO_DATA) {
                    return;
                }
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub(super) fn start(
        expected_game_binary: &Path,
        expected_steam_id: u64,
    ) -> Result<LauncherBridgeServer, String> {
        start_on_pipe(
            expected_game_binary,
            expected_steam_id,
            PIPE_NAME.to_string(),
        )
    }

    #[cfg(test)]
    pub(super) fn start_test(
        expected_game_binary: &Path,
        expected_steam_id: u64,
    ) -> Result<(LauncherBridgeServer, String), String> {
        // A test must never connect to or compete with an installed launcher.
        // The release binary has no configurable pipe-name override.
        let name = format!(
            r"\\.\pipe\B2G.Test.{}.{}",
            std::process::id(),
            super::super::now_unix()
        );
        let server = start_on_pipe(expected_game_binary, expected_steam_id, name.clone())?;
        Ok((server, name))
    }

    fn start_on_pipe(
        expected_game_binary: &Path,
        expected_steam_id: u64,
        pipe_name: String,
    ) -> Result<LauncherBridgeServer, String> {
        let expected_game_binary = expected_game_binary.to_path_buf();
        let (event_tx, event_rx) = mpsc::channel();
        let (outbound_tx, outbound_rx) = mpsc::channel();
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let worker = thread::Builder::new()
            .name("b2g-launcher-bridge".to_string())
            .spawn(move || {
                while !worker_stopping.load(Ordering::Acquire) {
                    let pipe = match create_pipe(&pipe_name) {
                        Ok(pipe) => pipe,
                        Err(error) => {
                            let _ = event_tx.send(BridgeEvent::ProtocolError(error));
                            return;
                        }
                    };
                    loop {
                        if worker_stopping.load(Ordering::Acquire) {
                            return;
                        }
                        match connected(&pipe) {
                            Ok(true) => break,
                            Ok(false) => thread::sleep(Duration::from_millis(50)),
                            Err(error) => {
                                let _ = event_tx.send(BridgeEvent::ProtocolError(error));
                                return;
                            }
                        }
                    }
                    if let Err(error) = verified_client(&pipe, &expected_game_binary) {
                        let _ = event_tx.send(BridgeEvent::ProtocolError(error));
                        continue;
                    }
                    run_client(
                        &pipe,
                        expected_steam_id,
                        &event_tx,
                        &outbound_rx,
                        &worker_stopping,
                    );
                }
            })
            .map_err(|error| format!("Could not start the local launcher bridge: {error}"))?;
        Ok(LauncherBridgeServer {
            events: event_rx,
            outbound: outbound_tx,
            stopping,
            worker: Some(worker),
        })
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub(super) fn start(
        _expected_game_binary: &Path,
        _expected_steam_id: u64,
    ) -> Result<LauncherBridgeServer, String> {
        Err("The local launcher bridge is only supported on Windows.".to_string())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ownership_epochs_survive_loadout_and_ack_bridge_frames() {
        let mut loadout=vec![1,0,0,0];loadout.extend_from_slice(&42u64.to_le_bytes());
        let legacy=super::parse_loadout_sync(&loadout).unwrap();assert_eq!(legacy.asset_ids,vec![42]);
        assert!(legacy.ownership_generations.is_empty());
        loadout[2]=1;loadout.extend_from_slice(&2u64.to_le_bytes());
        assert_eq!(super::parse_loadout_sync(&loadout).unwrap().ownership_generations["42"],"2");
        let mut ack=vec![1,0,1,0];ack.extend_from_slice(&42u64.to_le_bytes());
        ack.extend_from_slice(&130u32.to_le_bytes());ack.extend_from_slice(&2u64.to_le_bytes());
        let parsed=super::parse_inventory_acknowledgement(&ack).unwrap();
        assert_eq!(parsed.positions,vec![(42,130)]);assert_eq!(parsed.ownership_generations["42"],"2");
        ack[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(super::parse_inventory_acknowledgement(&ack).is_err());
        loadout[2]=2;assert!(super::parse_loadout_sync(&loadout).is_err());
        loadout[2]=1;loadout.pop();assert!(super::parse_loadout_sync(&loadout).is_err());
    }
    use super::*;

    fn varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }

    #[test]
    fn native_keyless_case_open_wire_round_trips_exact_asset_ids() {
        let request = CaseOpenRequest {
            case_asset_id: 8_000_000_000_000_000_100,
            key_asset_id: 0,
        };
        let mut hello_received = true;
        let mut request_payload = request.case_asset_id.to_le_bytes().to_vec();
        request_payload.extend_from_slice(&request.key_asset_id.to_le_bytes());
        let event = dispatch_frame(
            Frame {
                message_type: CASE_OPEN_REQUEST,
                payload: request_payload,
            },
            76_561_198_000_000_001,
            &mut hello_received,
        )
        .unwrap();
        assert_eq!(event, Some(BridgeEvent::CaseOpenRequest(request)));

        let result = case_open_result_payload(CaseOpenCompletion {
            case_asset_id: request.case_asset_id,
            key_asset_id: request.key_asset_id,
            result_asset_id: Some(8_000_000_000_000_000_102),
            item_name: Some("Moto Gloves | Spearmint".to_string()),
        })
        .unwrap();
        assert_eq!(result.len(), 192);
        assert_eq!(result[0], 1);
        assert_eq!(result[1], 0);
        assert_eq!(u16::from_le_bytes(result[2..4].try_into().unwrap()), 23);
        assert_eq!(&result[4..8], &[0; 4]);
        assert_eq!(
            u64::from_le_bytes(result[8..16].try_into().unwrap()),
            request.case_asset_id
        );
        assert_eq!(
            u64::from_le_bytes(result[16..24].try_into().unwrap()),
            request.key_asset_id
        );
        assert_eq!(
            u64::from_le_bytes(result[24..32].try_into().unwrap()),
            8_000_000_000_000_000_102
        );
        assert_eq!(&result[32..55], b"Moto Gloves | Spearmint");
        assert!(result[55..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn case_open_result_rejects_missing_or_unsafe_reward_names() {
        let invalid = [String::new(), "line\nbreak".to_string(), "x".repeat(161)];
        for item_name in invalid {
            assert!(
                case_open_result_payload(CaseOpenCompletion {
                    case_asset_id: 8_000_000_000_000_000_100,
                    key_asset_id: 0,
                    result_asset_id: Some(8_000_000_000_000_000_102),
                    item_name: Some(item_name),
                })
                .is_err()
            );
        }
    }

    #[test]
    fn native_trade_up_wire_round_trips_all_authoritative_items() {
        let input_asset_ids =
            std::array::from_fn(|index| 8_000_000_000_000_001_000_u64 + index as u64);
        let request = TradeUpRequest {
            recipe: -3,
            input_asset_ids,
        };
        let mut request_payload = request.recipe.to_le_bytes().to_vec();
        request_payload.extend_from_slice(&10_u16.to_le_bytes());
        request_payload.extend_from_slice(&[0; 4]);
        for asset_id in input_asset_ids {
            request_payload.extend_from_slice(&asset_id.to_le_bytes());
        }
        let mut hello_received = true;
        let event = dispatch_frame(
            Frame {
                message_type: TRADE_UP_REQUEST,
                payload: request_payload.clone(),
            },
            76_561_198_000_000_001,
            &mut hello_received,
        )
        .unwrap();
        assert_eq!(event, Some(BridgeEvent::TradeUpRequest(request)));

        let mut no_identity = false;
        assert!(
            dispatch_frame(
                Frame {
                    message_type: TRADE_UP_REQUEST,
                    payload: request_payload
                },
                76_561_198_000_000_001,
                &mut no_identity,
            )
            .unwrap_err()
            .contains("before identity")
        );

        let result_asset_id = 8_000_000_000_000_002_000_u64;
        let result = trade_up_result_payload(TradeUpCompletion {
            recipe_index: 2,
            input_asset_ids,
            result_asset_id: Some(result_asset_id),
        });
        assert_eq!(result.len(), 96);
        assert_eq!(result[0], 1);
        assert_eq!(result[1], 0);
        assert_eq!(i16::from_le_bytes(result[2..4].try_into().unwrap()), 2);
        assert_eq!(&result[4..8], &[0; 4]);
        assert_eq!(
            u64::from_le_bytes(result[8..16].try_into().unwrap()),
            result_asset_id
        );
        for (index, asset_id) in input_asset_ids.into_iter().enumerate() {
            let offset = 16 + index * 8;
            assert_eq!(
                u64::from_le_bytes(result[offset..offset + 8].try_into().unwrap()),
                asset_id
            );
        }
    }

    #[test]
    fn medal_wire_requires_identity_and_preserves_preview_and_redemption_fields() {
        let mut payload = 97_u64.to_le_bytes().to_vec();
        payload.extend_from_slice(&1331_u32.to_le_bytes());
        payload.extend_from_slice(&[0; 4]);
        let frame = || Frame { message_type: SERVICE_MEDAL_REQUEST, payload: payload.clone() };
        assert!(dispatch_frame(frame(), 76561198000000001, &mut false).is_err());
        assert_eq!(dispatch_frame(frame(), 76561198000000001, &mut true).unwrap(),
            Some(BridgeEvent::ServiceMedalRequest(ServiceMedalRequest { request_id: 97, definition_index: 1331 })));
        let result = service_medal_result_payload(ServiceMedalCompletion {
            request_id: 97, asset_id: 8000000000000000123, definition_index: 1331,
            prestige_time: 1788751000, player_level: 1, player_xp: 0, succeeded: true, redeemed: true,
            failure_reason: 0,
        });
        assert_eq!(result.len(), 36);
        assert_eq!(u64::from_le_bytes(result[0..8].try_into().unwrap()), 97);
        assert_eq!(u64::from_le_bytes(result[8..16].try_into().unwrap()), 8000000000000000123);
        assert_eq!(u32::from_le_bytes(result[16..20].try_into().unwrap()), 1331);
        assert_eq!(u32::from_le_bytes(result[20..24].try_into().unwrap()), 1788751000);
        assert_eq!(&result[24..], &[1,0,0,0,0,0,0,0,1,1,0,0]);
        payload[8..12].copy_from_slice(&0_u32.to_le_bytes());
        assert_eq!(parse_service_medal_request(&payload).unwrap().definition_index, 0);
        payload[12] = 1;
        assert!(parse_service_medal_request(&payload).is_err());
        assert!(parse_service_medal_request(&payload[..15]).is_err());
        payload[12] = 0;
        payload[0..8].fill(0);
        assert!(parse_service_medal_request(&payload).is_err());
    }

    fn mm_start(game_type: u32, ticket: &str) -> Vec<u8> {
        let mut bytes = vec![0x10];
        bytes.extend(varint(u64::from(game_type)));
        bytes.push(0x1a);
        bytes.extend(varint(ticket.len() as u64));
        bytes.extend(ticket.as_bytes());
        bytes.extend([0x20, 0x7b, 0x30, 0x01]);
        bytes
    }

    fn mm_party_start(game_type: u32, ticket: &str, account_ids: &[u32], lobby_id: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        for account_id in account_ids {
            bytes.push(0x08);
            bytes.extend(varint(u64::from(*account_id)));
        }
        bytes.extend(mm_start(game_type, ticket));
        bytes.push(0x40);
        bytes.extend(varint(lobby_id));
        bytes
    }

    #[test]
    fn frames_survive_fragmented_stream_reads() {
        let first = encode_frame(CLIENT_HELLO, &123_u64.to_le_bytes()).unwrap();
        let second = encode_frame(QUEUE_STOP, &[0x08, 0x01]).unwrap();
        let mut pending = first[..7].to_vec();
        assert!(drain_frames(&mut pending).unwrap().is_empty());
        pending.extend_from_slice(&first[7..]);
        pending.extend_from_slice(&second);
        let frames = drain_frames(&mut pending).unwrap();
        assert_eq!(frames.len(), 2);
        assert!(pending.is_empty());
    }

    #[test]
    fn decodes_panorama_deathmatch_intent_from_ticket_data() {
        let intent = queue_intent(
            &mm_start(
                7,
                r#"{"source":"playmenu","mode":"deathmatch","mapgroups":"mg_deathmatch"}"#,
            ),
            76_561_198_000_000_001,
        )
        .unwrap();
        assert_eq!(intent.mode, QueueMode::Deathmatch);
        assert!(intent.maps.is_empty());
        assert!(intent.prime_only);
        assert_eq!(intent.client_version, 123);
    }

    #[test]
    fn decodes_final_2023_deathmatch_wire_value_without_ticket_data() {
        let intent = queue_intent(&mm_start(518, ""), 76_561_198_000_000_001).unwrap();
        assert_eq!(intent.mode, QueueMode::Deathmatch);
        assert!(intent.maps.is_empty());
    }

    #[test]
    fn does_not_confuse_other_final_2023_modes_with_deathmatch() {
        for game_type in [268_486_662, 8_400_902, 196_614] {
            let error = queue_intent(&mm_start(game_type, ""), 76_561_198_000_000_001).unwrap_err();
            assert!(error.contains("does not support"));
        }
    }

    #[test]
    fn decodes_competitive_map_bits_without_guessing_ticket_names() {
        let intent = queue_intent(
            &mm_start(
                8 | 32_768 | 4_096,
                r#"{"source":"playmenu","mode":"competitive","mapgroups":"ignored"}"#,
            ),
            76_561_198_000_000_001,
        )
        .unwrap();
        assert_eq!(intent.mode, QueueMode::Competitive);
        assert_eq!(intent.maps, ["Inferno", "Mirage"]);
    }

    #[test]
    fn carries_the_verified_native_steam_lobby_roster() {
        let intent = queue_intent(
            &mm_party_start(
                8 | 32_768,
                r#"{"source":"playmenu","mode":"competitive"}"#,
                &[39_734_274, 39_734_273],
                109_775_241_234_567_890,
            ),
            76_561_198_000_000_001,
        )
        .unwrap();
        assert_eq!(
            intent.member_steam_ids,
            ["76561198000000001", "76561198000000002"]
        );
        assert_eq!(intent.steam_lobby_id.as_deref(), Some("109775241234567890"));
    }

    #[test]
    fn rejects_a_native_party_that_omits_the_paired_account() {
        let error = queue_intent(
            &mm_party_start(
                8 | 32_768,
                r#"{"source":"playmenu","mode":"competitive"}"#,
                &[39_734_274, 39_734_275],
                109_775_241_234_567_890,
            ),
            76_561_198_000_000_001,
        )
        .unwrap_err();
        assert!(error.contains("invalid Steam party roster"));
    }

    #[test]
    fn rejects_an_unimplemented_panorama_mode() {
        let error = queue_intent(
            &mm_start(
                1,
                r#"{"source":"playmenu","mode":"casual","mapgroups":"mg_casual"}"#,
            ),
            76_561_198_000_000_001,
        )
        .unwrap_err();
        assert!(error.contains("does not support"));
    }

    #[test]
    fn state_wire_matches_the_cpp_layout() {
        let bytes = state_payload(BridgeState {
            rank_id: 11,
            wins: 42,
            player_level: 3,
            player_xp: 900,
            queue_phase: 1,
            players_online: 20,
            servers_online: 2,
            players_searching: 5,
            ongoing_matches: 1,
            estimated_wait_seconds: 30,
        });
        assert_eq!(bytes.len(), 40);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 11);
        assert_eq!(u32::from_le_bytes(bytes[36..40].try_into().unwrap()), 30);
    }

    #[test]
    fn native_ready_check_wire_matches_the_cpp_layout() {
        let ready = ReadyCheckPresentation {
            announcement_only: false,
            match_id: "11111111-2222-3333-4444-555555555555".to_string(),
            map: "Mirage".to_string(),
            accepted_players: 6,
            total_players: 10,
            seconds_remaining: 17,
            local_accepted: true,
        };
        let bytes = ready_check_payload(Some(&ready)).unwrap();
        assert_eq!(bytes.len(), 84);
        assert_eq!(bytes[0], 1);
        assert_eq!(bytes[1], 1);
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 6);
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 10);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 17);
        assert_eq!(&bytes[16..52], ready.match_id.as_bytes());
        assert_eq!(&bytes[52..61], b"de_mirage");
        assert!(bytes[61..].iter().all(|byte| *byte == 0));
        assert_eq!(ready_check_payload(None).unwrap(), vec![0; 84]);
    }

    #[test]
    fn correlated_queue_commands_and_results_are_bounded_and_identity_gated() {
        let request_id = 27_u64;
        let mut payload = request_id.to_le_bytes().to_vec();
        payload.extend_from_slice(&[0x08, 0x01]); // abandon=1
        let frame = || Frame {
            message_type: QUEUE_STOP_CORRELATED,
            payload: payload.clone(),
        };
        assert!(dispatch_frame(frame(), 0, &mut false).is_err());
        assert_eq!(
            dispatch_frame(frame(), 0, &mut true).unwrap(),
            Some(BridgeEvent::QueueStop {
                abandon: 1,
                request_id
            })
        );
        assert!(
            dispatch_frame(
                Frame {
                    message_type: QUEUE_START_CORRELATED,
                    payload: vec![0; 8]
                },
                0,
                &mut true
            )
            .is_err()
        );
        let rejected = dispatch_frame(
            Frame {
                message_type: QUEUE_START_CORRELATED,
                payload: [request_id.to_le_bytes().as_slice(), &[0xff]].concat(),
            },
            0,
            &mut true,
        )
        .unwrap();
        assert!(matches!(
            rejected,
            Some(BridgeEvent::QueueRejected { request_id: 27, .. })
        ));
        let error = "é\n".repeat(300);
        let result = queue_result_payload(request_id, 0, Some(&error)).unwrap();
        assert_eq!(result.len(), 524);
        assert_eq!(&result[..8], &request_id.to_le_bytes());
        assert_eq!(std::str::from_utf8(&result[12..]).unwrap(), "é".repeat(256));
        assert_eq!(queue_result_payload(request_id, 4, None).unwrap().len(), 12);
        assert!(queue_result_payload(0, 1, None).is_err());
        assert!(queue_result_payload(1, 5, None).is_err());
    }

    #[test]
    fn native_deathmatch_notice_has_no_fabricated_player_slots() {
        let mut ready = ReadyCheckPresentation {
            announcement_only: true,
            match_id: "11111111-2222-3333-4444-555555555555".to_string(),
            map: "de_dust2".to_string(),
            accepted_players: 0,
            total_players: 0,
            seconds_remaining: 0,
            local_accepted: true,
        };
        let payload = ready_check_payload(Some(&ready)).unwrap();
        assert_eq!(&payload[..4], &[1, 1, 1, 0]);
        assert_eq!(&payload[4..16], &[0; 12]);
        ready.total_players = 10;
        assert!(ready_check_payload(Some(&ready)).is_err());
        ready.total_players = 0;
        ready.map = "Mirage".to_string();
        assert!(ready_check_payload(Some(&ready)).is_err());
        ready.map = "Dust II".to_string();
        ready.announcement_only = false;
        assert!(ready_check_payload(Some(&ready)).is_err());
    }

    #[test]
    fn native_ready_accept_requires_identity_and_a_uuid() {
        let match_id = b"11111111-2222-3333-4444-555555555555";
        let mut hello_received = true;
        let event = dispatch_frame(
            Frame {
                message_type: READY_ACCEPT,
                payload: match_id.to_vec(),
            },
            0,
            &mut hello_received,
        )
        .unwrap();
        assert_eq!(
            event,
            Some(BridgeEvent::ReadyAccept {
                match_id: String::from_utf8(match_id.to_vec()).unwrap()
            })
        );

        let mut no_identity = false;
        assert!(
            dispatch_frame(
                Frame {
                    message_type: READY_ACCEPT,
                    payload: match_id.to_vec(),
                },
                0,
                &mut no_identity,
            )
            .unwrap_err()
            .contains("before identity")
        );

        let mut hello_received = true;
        assert!(
            dispatch_frame(
                Frame {
                    message_type: READY_ACCEPT,
                    payload: b"111111112222-3333-4444-555555555555".to_vec(),
                },
                0,
                &mut hello_received,
            )
            .unwrap_err()
            .contains("invalid match identifier")
        );
    }

    #[test]
    fn native_player_profile_wire_round_trips_authoritative_party_state() {
        let mut request_payload = vec![1, 0, 0, 0];
        request_payload.extend_from_slice(&42_u32.to_le_bytes());
        request_payload.extend_from_slice(&2_u32.to_le_bytes());
        request_payload.extend_from_slice(&39_734_273_u32.to_le_bytes());
        request_payload.extend_from_slice(&39_734_274_u32.to_le_bytes());
        let mut hello_received = true;
        let event = dispatch_frame(
            Frame {
                message_type: PLAYER_PROFILES_REQUEST,
                payload: request_payload,
            },
            0,
            &mut hello_received,
        )
        .unwrap();
        let Some(BridgeEvent::PlayerProfilesRequest(request)) = event else {
            panic!("expected a player-profile request");
        };
        assert!(request.has_request_id);
        assert_eq!(request.request_id, 42);
        assert_eq!(request.account_ids, [39_734_273, 39_734_274]);

        let payload = player_profiles_payload(
            &request,
            &[
                PlayerProfilePresentation {
                    account_id: 39_734_273,
                    rank_id: 11,
                    wins: 42,
                    player_level: 4,
                    player_xp: 380,
                },
                PlayerProfilePresentation {
                    account_id: 39_734_274,
                    rank_id: 18,
                    wins: 900,
                    player_level: 40,
                    player_xp: 999,
                },
            ],
        )
        .unwrap();
        assert_eq!(payload.len(), 52);
        assert_eq!(payload[0], 1);
        assert_eq!(u32::from_le_bytes(payload[4..8].try_into().unwrap()), 42);
        assert_eq!(u32::from_le_bytes(payload[8..12].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(payload[12..16].try_into().unwrap()),
            39_734_273
        );
        assert_eq!(u32::from_le_bytes(payload[16..20].try_into().unwrap()), 11);
        assert_eq!(
            u32::from_le_bytes(payload[48..52].try_into().unwrap()),
            999
        );
    }

    #[test]
    fn native_player_profiles_reject_identity_bypass_and_unbounded_state() {
        let mut payload = vec![0, 0, 0, 0];
        payload.extend_from_slice(&0_u32.to_le_bytes());
        payload.extend_from_slice(&1_u32.to_le_bytes());
        payload.extend_from_slice(&39_734_273_u32.to_le_bytes());
        let mut no_identity = false;
        assert!(
            dispatch_frame(
                Frame {
                    message_type: PLAYER_PROFILES_REQUEST,
                    payload: payload.clone(),
                },
                0,
                &mut no_identity,
            )
            .unwrap_err()
            .contains("before identity")
        );

        payload[8..12].copy_from_slice(&17_u32.to_le_bytes());
        let mut hello_received = true;
        assert!(
            dispatch_frame(
                Frame {
                    message_type: PLAYER_PROFILES_REQUEST,
                    payload,
                },
                0,
                &mut hello_received,
            )
            .unwrap_err()
            .contains("invalid")
        );
    }

    #[cfg(windows)]
    #[test]
    fn authenticates_a_real_local_pipe_client_and_exchanges_state() {
        use std::ptr;
        use std::time::Instant;
        use windows_sys::Win32::Foundation::{
            CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, ReadFile, WriteFile,
        };
        use windows_sys::Win32::System::Pipes::{PIPE_NOWAIT, SetNamedPipeHandleState};

        struct TestPipe(windows_sys::Win32::Foundation::HANDLE);
        impl Drop for TestPipe {
            fn drop(&mut self) {
                unsafe { CloseHandle(self.0) };
            }
        }

        let steam_id = 76_561_198_000_000_001_u64;
        let executable = std::env::current_exe().unwrap();
        let (server, test_pipe_name) = platform::start_test(&executable, steam_id).unwrap();
        assert!(test_pipe_name.starts_with(r"\\.\pipe\B2G.Test."));
        let name = test_pipe_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let deadline = Instant::now() + Duration::from_secs(3);
        let client = loop {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                break TestPipe(handle);
            }
            assert!(
                Instant::now() < deadline,
                "launcher pipe was not available: {}",
                std::io::Error::last_os_error()
            );
            thread::sleep(Duration::from_millis(20));
        };

        // Keep the read deadlines below meaningful even if the worker fails.
        let mode = PIPE_NOWAIT;
        assert_ne!(
            unsafe { SetNamedPipeHandleState(client.0, &mode, ptr::null(), ptr::null()) },
            0
        );

        let mut request = encode_frame(CLIENT_HELLO, &steam_id.to_le_bytes()).unwrap();
        request.extend(
            encode_frame(
                QUEUE_START,
                &mm_start(
                    8 | 32_768,
                    r#"{"source":"playmenu","mode":"competitive","mapgroups":"mg_de_mirage"}"#,
                ),
            )
            .unwrap(),
        );
        let mut written = 0_u32;
        assert_ne!(
            unsafe {
                WriteFile(
                    client.0,
                    request.as_ptr(),
                    request.len() as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(written as usize, request.len());
        assert_eq!(
            server.recv_timeout(Duration::from_secs(2)).unwrap(),
            BridgeEvent::Connected { steam_id }
        );
        let intent = server.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            intent,
            BridgeEvent::QueueStart(QueueIntent {
                mode: QueueMode::Competitive,
                maps,
                ..
            }) if maps == ["Mirage"]
        ));

        server
            .send_state(BridgeState {
                rank_id: 11,
                wins: 42,
                player_level: 4,
                player_xp: 380,
                queue_phase: 1,
                players_online: 12,
                servers_online: 2,
                players_searching: 5,
                ongoing_matches: 2,
                estimated_wait_seconds: 30,
            })
            .unwrap();
        let mut response = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut chunk = [0_u8; 128];
            let mut read = 0_u32;
            if unsafe {
                ReadFile(
                    client.0,
                    chunk.as_mut_ptr(),
                    chunk.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            } != 0
                && read > 0
            {
                response.extend_from_slice(&chunk[..read as usize]);
                let frames = drain_frames(&mut response).unwrap();
                if let Some(frame) = frames.into_iter().find(|frame| frame.message_type == STATE) {
                    assert_eq!(frame.payload.len(), 40);
                    assert_eq!(
                        u32::from_le_bytes(frame.payload[0..4].try_into().unwrap()),
                        11
                    );
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "launcher did not return bridge state"
            );
            thread::sleep(Duration::from_millis(20));
        }

        let match_id = "11111111-2222-3333-4444-555555555555";
        server
            .send_ready_check(Some(&ReadyCheckPresentation {
                announcement_only: false,
                match_id: match_id.to_string(),
                map: "Mirage".to_string(),
                accepted_players: 4,
                total_players: 10,
                seconds_remaining: 19,
                local_accepted: false,
            }))
            .unwrap();
        let mut response = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut chunk = [0_u8; 128];
            let mut read = 0_u32;
            if unsafe {
                ReadFile(
                    client.0,
                    chunk.as_mut_ptr(),
                    chunk.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            } != 0
                && read > 0
            {
                response.extend_from_slice(&chunk[..read as usize]);
                let frames = drain_frames(&mut response).unwrap();
                if let Some(frame) = frames
                    .into_iter()
                    .find(|frame| frame.message_type == READY_CHECK)
                {
                    assert_eq!(frame.payload.len(), 84);
                    assert_eq!(frame.payload[0], 1);
                    assert_eq!(&frame.payload[16..52], match_id.as_bytes());
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "launcher did not return native ready-check state"
            );
            thread::sleep(Duration::from_millis(20));
        }

        let acceptance = encode_frame(READY_ACCEPT, match_id.as_bytes()).unwrap();
        let mut written = 0_u32;
        assert_ne!(
            unsafe {
                WriteFile(
                    client.0,
                    acceptance.as_ptr(),
                    acceptance.len() as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(written as usize, acceptance.len());
        assert_eq!(
            server.recv_timeout(Duration::from_secs(2)).unwrap(),
            BridgeEvent::ReadyAccept {
                match_id: match_id.to_string()
            }
        );
    }
}
