//! Typed launcher trading client and review model. All network work belongs on
//! a worker; UI code only reads snapshots and submits bounded commands.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

#[cfg(test)]
pub(crate) mod art;
#[cfg(test)]
pub(crate) mod test_support;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Player {
    pub player_id: String,
    pub display_name: String,
    pub trade_code: String,
    pub allow_offers: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sticker {
    pub slot: u32,
    pub sticker_id: u32,
    pub wear: Option<f64>,
    pub scale: Option<f64>,
    pub rotation: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    pub asset_id: String,
    pub owner_id: String,
    pub ownership_generation: String,
    pub item_kind: String,
    pub definition_index: u32,
    pub weapon_key: String,
    pub display_name: String,
    pub icon_path: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
    pub paint_index: Option<u32>,
    pub paint_wear: Option<f64>,
    pub paint_seed: Option<u32>,
    pub quality: u32,
    pub rarity: u32,
    pub origin: u32,
    pub stat_trak: bool,
    pub stat_trak_count: Option<u32>,
    pub custom_name: Option<String>,
    pub stickers: Vec<Sticker>,
    pub spray_kit_id: Option<u32>,
    pub spray_tint_id: Option<u32>,
    pub sprays_remaining: Option<u32>,
    pub equipped: bool,
    pub tradable: bool,
    pub restriction: Option<String>,
    pub fingerprint: String,
}

impl Item {
    pub fn condition(&self) -> &'static str {
        match self.paint_wear {
            Some(wear) if wear < 0.07 => "Factory New",
            Some(wear) if wear < 0.15 => "Minimal Wear",
            Some(wear) if wear < 0.38 => "Field-Tested",
            Some(wear) if wear < 0.45 => "Well-Worn",
            Some(_) => "Battle-Scarred",
            None if self.item_kind == "case" => "Unopened container",
            None => "Collectible",
        }
    }

    pub fn rarity_name(&self) -> &'static str {
        match self.rarity {
            1 => "Consumer Grade", 2 => "Industrial Grade", 3 => "Mil-Spec",
            4 => "Restricted", 5 => "Classified", 6 => "Covert", 7 => "Contraband",
            _ => "Base Grade",
        }
    }

    pub fn details(&self) -> String {
        let mut lines = vec![self.display_name.clone(), format!("{} · {}", self.rarity_name(), self.condition())];
        if let Some(name) = &self.custom_name { lines.push(format!("Name tag: {name}")); }
        if let Some(wear) = self.paint_wear { lines.push(format!("Wear: {wear:.9}")); }
        if let Some(seed) = self.paint_seed { lines.push(format!("Pattern: {seed}")); }
        if let Some(paint) = self.paint_index { lines.push(format!("Finish: {paint}")); }
        if self.stat_trak {
            lines.push(format!("StatTrak: {} kills · resets to 0 for the recipient", self.stat_trak_count.unwrap_or(0)));
        }
        for sticker in &self.stickers {
            lines.push(format!("Sticker {}: #{} · wear {:.3}", sticker.slot + 1, sticker.sticker_id, sticker.wear.unwrap_or(0.0)));
        }
        if self.equipped { lines.push("Currently equipped".into()); }
        if let Some(reason) = &self.restriction { lines.push(reason.clone()); }
        lines.push(format!("Item ID: {}", self.asset_id));
        lines.join("\n")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Offer {
    pub id: String,
    pub revision: u32,
    pub status: String,
    pub status_reason: Option<String>,
    pub sender_id: String,
    pub participants: Vec<Player>,
    pub message: String,
    #[serde(default)]
    pub item_count: Option<usize>,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub changed_asset_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: String,
    pub completed_at: Option<String>,
}

impl Offer {
    pub fn partner(&self, me: &str) -> Option<&Player> {
        self.participants.iter().find(|player| player.player_id != me)
    }
    pub fn can_accept(&self, me: &str) -> bool {
        self.status == "pending" && self.sender_id != me && self.changed_asset_ids.is_empty()
            && self.fully_loaded() && !self.items.is_empty() && self.participants.iter().any(|player| player.player_id == me)
    }
    pub fn total_items(&self)->usize {self.item_count.unwrap_or(self.items.len())}
    pub fn fully_loaded(&self)->bool {self.item_count.is_none_or(|count|count==self.items.len())}
    pub fn is_gift(&self) -> bool {
        !self.items.is_empty() && self.items.iter().all(|item| item.owner_id == self.items[0].owner_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Overview {
    pub enabled: bool,
    pub player: Player,
    pub incoming_count: u32,
    pub unread_count: u32,
    pub latest_event_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InventoryPage {
    pub items: Vec<Item>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfferPage {
    pub offers: Vec<Offer>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TradeEvent {
    pub id: String,
    pub offer_id: String,
    pub revision: u32,
    pub actor_id: Option<String>,
    pub kind: String,
    pub created_at: String,
    pub detail: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventPage {
    pub events: Vec<TradeEvent>,
    pub next_cursor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Terms {
    pub give_asset_ids: Vec<String>,
    pub receive_asset_ids: Vec<String>,
    pub item_fingerprints: BTreeMap<String, String>,
    pub message: String,
    pub confirm_gift: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Composer {
    pub partner: Option<Player>,
    pub selected: BTreeMap<String, Item>,
    pub message: String,
    pub counter: Option<(String, u32)>,
    pub reviewing: bool,
    pub gift_confirmed: bool,
}

impl Composer {
    pub fn select(&mut self, item: &Item) -> Result<(), String> {
        if self.selected.remove(&item.asset_id).is_none() {
            if !item.tradable { return Err(item.restriction.clone().unwrap_or("This item cannot be traded.".into())); }
            if self.selected.values().filter(|selected| selected.owner_id == item.owner_id).count() >= 50 {
                return Err("An offer can contain up to 50 items per side.".into());
            }
            self.selected.insert(item.asset_id.clone(), item.clone());
        }
        self.reviewing = false;
        self.gift_confirmed = false;
        Ok(())
    }

    pub fn terms(&self, me: &str) -> Result<Terms, String> {
        let partner = self.partner.as_ref().ok_or("Choose a trading partner first.")?;
        if partner.player_id == me { return Err("Choose another B2G player.".into()); }
        if self.selected.is_empty() { return Err("Select at least one item for this offer.".into()); }
        let mut terms = Terms { give_asset_ids: vec![], receive_asset_ids: vec![],
            item_fingerprints: BTreeMap::new(), message: self.message.clone(), confirm_gift: self.gift_confirmed };
        for item in self.selected.values() {
            if !item.tradable { return Err("An item in this offer can no longer be traded. Review it again.".into()); }
            if item.owner_id == me { terms.give_asset_ids.push(item.asset_id.clone()); }
            else if item.owner_id == partner.player_id { terms.receive_asset_ids.push(item.asset_id.clone()); }
            else { return Err("An item no longer belongs to either trading partner.".into()); }
            terms.item_fingerprints.insert(item.asset_id.clone(),item.fingerprint.clone());
        }
        if terms.give_asset_ids.len() > 50 || terms.receive_asset_ids.len() > 50 {
            return Err("Select at most 50 items per side.".into());
        }
        Ok(terms)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Mutation {
    Send { recipient_id: String, terms: Terms },
    Counter { offer_id: String, revision: u32, terms: Terms },
    Respond { offer_id: String, revision: u32, response: String, confirm_gift: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingMutation {
    version: u32,
    pub player_id: String,
    pub request_id: String,
    pub mutation: Mutation,
}

impl PendingMutation {
    pub fn new(player_id: String, mutation: Mutation) -> Result<Self, String> {
        let pending = Self { version: 1, player_id, mutation, request_id: request_uuid()? };
        pending.request()?;
        Ok(pending)
    }

    fn request(&self) -> Result<(String,Value),String> {
        if self.version != 1 || !valid_uuid(&self.player_id) || !valid_uuid(&self.request_id) {
            return Err("The saved trading request is invalid. Contact B2G support before sending another offer.".into());
        }
        match &self.mutation {
            Mutation::Send { recipient_id, terms } if valid_uuid(recipient_id) => Ok(("/offers".into(),
                json!({"recipientId":recipient_id,"requestId":self.request_id,"terms":terms}))),
            Mutation::Counter { offer_id, revision, terms } if valid_uuid(offer_id) && (1..=100).contains(revision) =>
                Ok((format!("/offers/{offer_id}/counter"),json!({"revision":revision,"requestId":self.request_id,"terms":terms}))),
            Mutation::Respond { offer_id, revision, response, confirm_gift }
                if valid_uuid(offer_id) && (1..=100).contains(revision) && matches!(response.as_str(),"accept"|"cancel"|"decline") =>
                Ok((format!("/offers/{offer_id}/{response}"),json!({"revision":revision,"requestId":self.request_id,"confirmGift":confirm_gift}))),
            _ => Err("The saved trading request has invalid terms. Refresh trading before continuing.".into()),
        }
    }
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(index, byte)| {
        if matches!(index,8|13|18|23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    })
}

#[cfg(windows)]
pub(crate) fn request_uuid() -> Result<String,String> {
    let mut guid = windows_sys::core::GUID::from_u128(0);
    if unsafe { windows_sys::Win32::System::Com::CoCreateGuid(&mut guid) } < 0 {
        return Err("Windows could not create a trading request ID. Retry.".into());
    }
    let d = guid.data4;
    Ok(format!("{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        guid.data1,guid.data2,guid.data3,d[0],d[1],d[2],d[3],d[4],d[5],d[6],d[7]))
}
#[cfg(not(windows))]
pub(crate) fn request_uuid() -> Result<String,String> { Err("This action requires the Windows launcher.".into()) }

#[derive(Debug, Clone)]
pub(crate) struct ApiError {
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<String>,
}
impl From<String> for ApiError {
    fn from(message: String) -> Self { Self { message, status: None, code: None } }
}

pub(crate) struct TradingApi {
    origin: String,
    token: String,
    agent: ureq::Agent,
    #[cfg(test)]
    journal_root: Option<std::path::PathBuf>,
}

impl TradingApi {
    pub fn connected() -> Result<Self, ApiError> {
        #[cfg(test)]
        if let Some(connection) = test_support::connection() { return Ok(Self::fixture(connection)); }
        let credential = super::read_launcher_credential()?
            .ok_or_else(|| ApiError::from("Connect your B2G account to continue.".to_string()))?;
        Ok(Self {
            origin: credential.api_origin, token: credential.access_token,
            #[cfg(test)]
            journal_root: None,
            agent: ureq::Agent::config_builder().max_redirects(0).http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(10)))
                .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
                .build().new_agent(),
        })
    }

    fn request<R: serde::de::DeserializeOwned>(&self, path: &str, body: Option<&Value>) -> Result<R, ApiError> {
        let endpoint = self.endpoint(path)?;
        self.request_endpoint(&endpoint, body)
    }

    pub(crate) fn launcher_request<R: serde::de::DeserializeOwned>(&self, path:&str, body:Option<&Value>)->Result<R,ApiError> {
        self.request_endpoint(&self.launcher_endpoint(path)?,body)
    }

    pub(crate) fn download_demo(&self,id:&str,metadata:&Value)->Result<std::path::PathBuf,ApiError> {
        let root=std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).ok_or_else(||ApiError::from("The local downloads folder is unavailable.".to_string()))?.join("B2G").join("demos");
        self.download_demo_to(id,metadata,&root)
    }

    fn download_demo_to(&self,id:&str,metadata:&Value,root:&std::path::Path)->Result<std::path::PathBuf,ApiError> {
        use std::io::Write;
        use sha2::Digest;
        if !valid_uuid(id)||metadata["available"]!=true{return Err("This match has no downloadable demo.".to_string().into());}
        let size=metadata["sizeBytes"].as_u64().filter(|n|*n>0&&*n<=4*1024*1024*1024).ok_or_else(||ApiError::from("The demo size is invalid.".to_string()))?;
        let checksum=metadata["checksum"].as_str().filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())).ok_or_else(||ApiError::from("The demo checksum is invalid.".to_string()))?;
        std::fs::create_dir_all(&root).map_err(|_|ApiError::from("Could not create the demo folder. Check disk space.".to_string()))?;
        let target=root.join(format!("{id}.dem"));
        let temporary=root.join(format!("{id}-{}.partial",request_uuid()?));
        let result=(||->Result<(),ApiError>{
            let agent=ureq::Agent::config_builder().max_redirects(0).http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(180)))
                .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build()).build().new_agent();
            let mut response=agent.get(self.launcher_endpoint(&format!("/api/launcher/v1/matches/{id}/demo"))?)
                .header("Authorization",format!("Bearer {}",self.token)).call()
                .map_err(|_|ApiError::from("The demo download was interrupted. Retry.".to_string()))?;
            if response.status().as_u16()!=200{return Err("B2G could not download this demo. Refresh and retry.".to_string().into());}
            let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_|ApiError::from("Could not save the demo. Check disk space.".to_string()))?;
            let mut reader=response.body_mut().as_reader().take(size+1);
            let mut hash=sha2::Sha256::new();let mut total=0u64;let mut buffer=[0u8;65536];
            loop{let n=reader.read(&mut buffer).map_err(|_|ApiError::from("The demo download was interrupted. Retry.".to_string()))?;
                if n==0{break;}total+=n as u64;if total>size{return Err("The demo exceeds its expected size.".to_string().into());}
                hash.update(&buffer[..n]);file.write_all(&buffer[..n]).map_err(|_|ApiError::from("Could not save the demo. Check disk space.".to_string()))?;
            }
            if total!=size||format!("{:x}",hash.finalize())!=checksum.to_ascii_lowercase(){return Err("The demo failed verification. Retry the download.".to_string().into());}
            file.sync_all().map_err(|_|ApiError::from("Could not finish saving the demo.".to_string()))?;drop(file);
            if target.exists(){
                // A verified existing download is sufficient; never overwrite
                // an unrelated local file on behalf of remote metadata.
                let mut old=std::fs::File::open(&target).map_err(|e|ApiError::from(e.to_string()))?;
                let mut old_hash=sha2::Sha256::new();std::io::copy(&mut old,&mut old_hash).map_err(|e|ApiError::from(e.to_string()))?;
                if format!("{:x}",old_hash.finalize())!=checksum.to_ascii_lowercase(){return Err("A different demo already exists at this path. Move it before downloading again.".to_string().into());}
            }else{std::fs::rename(&temporary,&target).map_err(|e|ApiError::from(e.to_string()))?;}
            Ok(())
        })();
        let _=std::fs::remove_file(&temporary);
        result.map(|_|target)
    }

    fn launcher_endpoint(&self,path:&str)->Result<String,ApiError> {
        if !path.starts_with("/api/launcher/v1/") || path.contains("..") || path.contains('#') {
            return Err("Invalid launcher request.".to_string().into());
        }
        #[cfg(test)]
        if self.journal_root.is_some() {
            return Ok(format!("{}{path}",self.origin.trim_end_matches('/')));
        }
        super::api_endpoint(&self.origin,path).map_err(Into::into)
    }

    fn request_endpoint<R:serde::de::DeserializeOwned>(&self,endpoint:&str,body:Option<&Value>)->Result<R,ApiError> {
        let token = format!("Bearer {}",self.token);
        let response = if let Some(body) = body {
            self.agent.post(endpoint).header("Authorization",&token).header("Content-Type","application/json")
                .header("Accept","application/json").send(body.to_string())
        } else {
            self.agent.get(endpoint).header("Authorization",&token).header("Accept","application/json").call()
        };
        let mut response = response.map_err(|error| {
            #[cfg(test)]
            eprintln!("Trading fixture transport: {error:?}");
            let _=error;
            ApiError::from("Could not reach B2G. Check your connection and retry.".to_string())
        })?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response.body_mut().as_reader().take(super::MAX_API_RESPONSE_BYTES + 1).read_to_end(&mut bytes)
            .map_err(|_| ApiError::from("The B2G response was interrupted. Retry to recover its result.".to_string()))?;
        if bytes.len() as u64 > super::MAX_API_RESPONSE_BYTES {
            return Err("B2G returned too much data. Refresh to retry.".to_string().into());
        }
        if !(200..300).contains(&status) {
            let error: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let message = if status == 401 { "Reconnect your B2G account to continue.".into() }
                else { error["error"].as_str().unwrap_or("B2G is temporarily unavailable. Retry shortly.").chars().take(300).collect() };
            return Err(ApiError { message, status: Some(status), code: error["code"].as_str().map(str::to_string) });
        }
        serde_json::from_slice(&bytes).map_err(|_| "B2G returned incomplete data. Refresh to retry.".to_string().into())
    }

    pub fn overview(&self) -> Result<Overview,ApiError> { self.request("/overview",None) }
    pub fn players(&self, query: &str) -> Result<Vec<Player>,ApiError> {
        self.request(&format!("/players?{}", query_string(&[("q",query)])),None)
    }
    pub fn inventory(&self, player: &str, query: &str, kind: &str, cursor: Option<&str>) -> Result<InventoryPage,ApiError> {
        let mut params = vec![("query",query),("limit","48")];
        if !kind.is_empty() { params.push(("kind",kind)); }
        if let Some(cursor) = cursor { params.push(("cursor",cursor)); }
        self.request(&format!("/inventory/{player}?{}", query_string(&params)),None)
    }
    pub fn offers(&self, folder: &str, before: Option<&str>) -> Result<OfferPage,ApiError> {
        let mut params = vec![("folder",folder)];
        if let Some(before) = before { params.push(("before",before)); }
        self.request(&format!("/offers?{}",query_string(&params)),None)
    }
    pub fn offer(&self,id: &str) -> Result<Offer,ApiError> { self.request(&format!("/offers/{id}"),None) }
    pub fn events(&self,offer_id: &str,after: &str) -> Result<EventPage,ApiError> {
        self.request(&format!("/events?{}",query_string(&[("offerId",offer_id),("after",after)])),None)
    }
    pub fn seen(&self,event_id: &str) -> Result<(),ApiError> {
        self.request::<Value>("/seen",Some(&json!({"eventId":event_id}))).map(|_|())
    }
    pub fn preferences(&self,allow: bool) -> Result<Player,ApiError> {
        self.request("/preferences",Some(&json!({"allowOffers":allow})))
    }
    fn pending_path(&self,player_id: &str) -> Result<std::path::PathBuf,ApiError> {
        use sha2::{Digest,Sha256};
        if !valid_uuid(player_id) { return Err("The trading account is invalid.".to_string().into()); }
        #[cfg(test)]
        if let Some(root)=&self.journal_root { return Ok(root.join(format!("{player_id}.json"))); }
        let log = super::launcher_log_path().ok_or_else(|| ApiError::from("Windows could not locate B2G's local data folder.".to_string()))?;
        let root = log.parent().ok_or_else(|| ApiError::from("B2G's local data folder is invalid.".to_string()))?;
        let origin = format!("{:x}",Sha256::digest(self.origin.as_bytes()));
        Ok(root.join("trading").join(format!("{}-{player_id}.json",&origin[..16])))
    }

    pub fn pending(&self,player_id: &str) -> Result<Option<PendingMutation>,ApiError> {
        let path = self.pending_path(player_id)?;
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("B2G could not read the saved trading request. Retry before sending another offer.".to_string().into()),
        };
        let mut bytes = Vec::new();
        file.take(65537).read_to_end(&mut bytes).map_err(|_| ApiError::from("The saved trading request could not be read.".to_string()))?;
        if bytes.len() > 65536 { return Err("The saved trading request is too large.".to_string().into()); }
        let pending: PendingMutation = serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::from("The saved trading request is damaged. Contact B2G support before sending another offer.".to_string()))?;
        pending.request()?;
        if pending.player_id != player_id { return Err("The saved trade belongs to another account.".to_string().into()); }
        Ok(Some(pending))
    }

    // Persist exact consent before making a request. A timeout or launcher
    // restart reuses this UUID and revision; it never invents another trade.
    pub fn mutate(&self,pending: &PendingMutation) -> Result<Offer,ApiError> {
        let (route,body) = pending.request()?;
        if self.overview()?.player.player_id != pending.player_id {
            return Err("Your connected account changed. Reopen Trading to review it.".to_string().into());
        }
        if let Some(saved) = self.pending(&pending.player_id)? {
            if saved != *pending {
                return Err("Recover the previous trading request before sending another one.".to_string().into());
            }
        }
        let path = self.pending_path(&pending.player_id)?;
        let bytes = serde_json::to_vec(pending).map_err(|error| ApiError::from(error.to_string()))?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| ApiError::from("B2G could not save trade recovery data. Check free disk space and retry.".to_string()))?;
        super::atomic_write(&path,&bytes)?;
        let result = self.request::<Offer>(&route,Some(&body));
        if result.is_ok() || result.as_ref().is_err_and(|error| error.status.is_some_and(|status| (400..500).contains(&status))) {
            // If deletion fails, replaying the same request later is safe.
            let _ = std::fs::remove_file(path);
        }
        result
    }
    fn endpoint(&self,path:&str)->Result<String,ApiError> {
        #[cfg(test)]
        if self.journal_root.is_some() {
            let url=url::Url::parse(&self.origin).map_err(|e|ApiError::from(e.to_string()))?;
            if url.scheme()=="http"&&url.host_str()==Some("127.0.0.1")&&url.path()=="/" {
                return Ok(format!("{}/api/launcher/v1/trading{path}",self.origin.trim_end_matches('/')));
            }
        }
        super::api_endpoint(&self.origin,&format!("/api/launcher/v1/trading{path}")).map_err(Into::into)
    }
    #[cfg(test)]
    fn fixture(connection:test_support::Connection)->Self {
        Self {origin:connection.origin,token:connection.token,journal_root:Some(connection.root),
            agent:ureq::Agent::config_builder().max_redirects(0).http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(2))).build().new_agent()}
    }
}

fn query_string(params: &[(&str,&str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params.iter().copied()).finish()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) const ME: &str = "11111111-1111-4111-8111-111111111111";
    pub(crate) const THEM: &str = "22222222-2222-4222-8222-222222222222";
    pub(crate) fn item(owner: &str, id: u64) -> Item {
        serde_json::from_value(json!({
            "assetId":id.to_string(),"ownerId":owner,"ownershipGeneration":"0","itemKind":"cosmetic",
            "definitionIndex":9,"weaponKey":"awp","displayName":"AWP | Dragon Lore","iconPath":null,
            "paintIndex":344,"paintWear":0.03125,"paintSeed":321,"quality":9,"rarity":6,"origin":8,
            "statTrak":true,"statTrakCount":87,"customName":"A familiar name","stickers":[],
            "sprayKitId":null,"sprayTintId":null,"spraysRemaining":null,"equipped":true,
            "tradable":true,"restriction":null,"fingerprint":"a".repeat(64)
        })).unwrap()
    }
    pub(crate) fn composer() -> Composer {
        Composer { partner: Some(Player { player_id:THEM.into(),display_name:"Trade tester".into(),
            trade_code:"0123456789ABCDEF".into(),allow_offers:true }),..Default::default() }
    }
    #[test]
    fn changed_selections_revoke_review_and_gift_confirmation() {
        let mut composer = composer();
        let give = item(ME,8000000000000000001);
        composer.select(&give).unwrap();
        composer.reviewing = true; composer.gift_confirmed = true;
        let receive = item(THEM,8000000000000000002);
        composer.select(&receive).unwrap();
        assert!(!composer.reviewing && !composer.gift_confirmed);
        let terms = composer.terms(ME).unwrap();
        assert_eq!(terms.give_asset_ids,vec![give.asset_id.clone()]);
        assert_eq!(terms.receive_asset_ids,vec![receive.asset_id.clone()]);
        assert_eq!(terms.item_fingerprints.len(),2);
        assert!(give.details().contains("resets to 0"));
        composer.select(&give).unwrap();
        assert!(composer.terms(ME).unwrap().give_asset_ids.is_empty());
    }
    #[test]
    fn composer_enforces_participants_tradability_and_per_side_limits() {
        let mut composer = composer();
        for id in 8000000000000000000..8000000000000000050 { composer.select(&item(ME,id)).unwrap(); }
        assert!(composer.select(&item(ME,8000000000000000051)).is_err());
        composer.select(&item(THEM,8000000000000000052)).unwrap();
        let mut bound = item(THEM,8000000000000000053);
        bound.tradable = false; bound.restriction = Some("Earned medals stay with this account.".into());
        assert!(composer.select(&bound).unwrap_err().contains("medals"));
        composer.selected.insert(bound.asset_id.clone(),bound);
        assert!(composer.terms(ME).is_err());
    }
    #[test]
    fn saved_requests_keep_exact_consent_and_cannot_redirect_to_another_api() {
        let mut composer = composer(); composer.select(&item(ME,8000000000000000001)).unwrap();
        let pending = PendingMutation { version:1,player_id:ME.into(),request_id:THEM.into(),
            mutation: Mutation::Counter { offer_id:THEM.into(),revision:3,terms:composer.terms(ME).unwrap() } };
        let restored: PendingMutation = serde_json::from_slice(&serde_json::to_vec(&pending).unwrap()).unwrap();
        assert_eq!(restored,pending);
        let (route,body) = restored.request().unwrap();
        assert_eq!(route,format!("/offers/{THEM}/counter"));
        assert_eq!(body["revision"],3); assert_eq!(body["requestId"],THEM);
        let invalid = PendingMutation { mutation:Mutation::Respond {
            offer_id:"../../device/revoke".into(),revision:3,response:"accept".into(),confirm_gift:false
        },..pending };
        assert!(invalid.request().is_err());
    }
    #[test]
    fn search_text_is_encoded_as_data_including_ampersands_and_unicode() {
        assert_eq!(query_string(&[("q","Cubs & Co #1")]),"q=Cubs+%26+Co+%231");
    }
    #[cfg(windows)]
    #[test]
    fn windows_assigns_distinct_valid_request_ids() {
        let first = request_uuid().unwrap(); let second = request_uuid().unwrap();
        assert!(valid_uuid(&first) && valid_uuid(&second)); assert_ne!(first,second);
    }
}
