/*
THESIS: Exact player-to-player offers in the existing B2G launcher.
OWN-WORLD: Rajdhani, near-black panels, restrained CT blue, real item art.
STORY: Find a player, compare You give / You receive, approve exact terms.
FIRST VIEWPORT: Compact offer navigation left, actionable inbox right, persistent
Play footer. The composer pairs two searchable inventories and a final review.
FORM: User-requested Steam-style local extension; code-led, incumbent system.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish
review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
*/

use crate::trading::{ApiError, Composer, EventPage, InventoryPage, Item, Mutation, Offer,
    OfferPage, Overview, PendingMutation, Player, TradingApi};

const PLAY_TAB_ID: i32 = 1011;
const TRADE_TAB_ID: i32 = 1012;
const TRADE_TIMER: usize = 2;
const TRADE_NEW: i32 = 2000;
const TRADE_INCOMING: i32 = 2001;
const TRADE_OUTGOING: i32 = 2002;
const TRADE_HISTORY: i32 = 2003;
const TRADE_COPY: i32 = 2004;
const TRADE_SEARCH: i32 = 2005;
const TRADE_BACK: i32 = 2006;
const TRADE_PRIMARY: i32 = 2007;
const TRADE_COUNTER: i32 = 2008;
const TRADE_DECLINE: i32 = 2009;
const TRADE_CANCEL: i32 = 2010;
const TRADE_GIFT: i32 = 2011;
const TRADE_PREVIOUS: i32 = 2012;
const TRADE_NEXT: i32 = 2013;
const TRADE_RECOVER: i32 = 2014;
const TRADE_PREFERENCES: i32 = 2015;
const TRADE_RECEIPT: i32 = 2016;
const TRADE_READ_MESSAGE: i32 = 2017;
const TRADE_IMAGES: u32 = WM_APP + 42;
const TRADE_QUERY: i32 = 2020;
const TRADE_MESSAGE: i32 = 2021;
const TRADE_GIVE_QUERY: i32 = 2022;
const TRADE_RECEIVE_QUERY: i32 = 2023;
const TRADE_GIVE_SEARCH: i32 = 2024;
const TRADE_RECEIVE_SEARCH: i32 = 2025;
const TRADE_GIVE_KIND: i32 = 2026;
const TRADE_RECEIVE_KIND: i32 = 2027;
const TRADE_GIVE_PREV: i32 = 2028;
const TRADE_GIVE_NEXT: i32 = 2029;
const TRADE_RECEIVE_PREV: i32 = 2030;
const TRADE_RECEIVE_NEXT: i32 = 2031;
const TRADE_ROW_BASE: i32 = 2100;
const TRADE_ITEM_BASE: i32 = 2200;
const TRADE_INSPECT: i32 = 2300;

#[derive(Debug, Clone, PartialEq, Eq)]
enum TradeScreen { Offers, FindPlayer, Compose, Offer }

#[derive(Debug, Clone, Default)]
struct TradeInventory {
    items: Vec<Item>,
    query: String,
    kind: String,
    cursor: Option<String>,
    next: Option<String>,
    previous: Vec<Option<String>>,
    offset: usize,
}

#[derive(Debug, Clone)]
struct TradingState {
    window: u64,
    thumbnails: Option<std::sync::Arc<crate::trading::art::Loader>>,
    overview: Option<Overview>,
    screen: TradeScreen,
    folder: String,
    offers: Vec<Offer>,
    offer_cursor: Option<String>,
    offer_next: Option<String>,
    offer_previous: Vec<Option<String>>,
    list_offset: usize,
    players: Vec<Player>,
    query: String,
    composer: Composer,
    inventory: [TradeInventory; 2],
    offer: Option<Offer>,
    history: Option<EventPage>,
    gift_confirmed: bool,
    focused_item: Option<Item>,
    pending: Option<PendingMutation>,
    busy: bool,
    polling: bool,
    poll_error: Option<String>,
    request_epoch: u64,
    deferred: Option<TradeTask>,
    last_seen_requested: String,
    view: u64,
    notice: String,
    error: Option<String>,
}

impl Default for TradingState {
    fn default() -> Self {
        Self { window:0,thumbnails:None,overview:None,screen:TradeScreen::Offers,folder:"incoming".into(),offers:vec![],
            offer_cursor:None,offer_next:None,offer_previous:vec![],list_offset:0,players:vec![],query:String::new(),
            composer:Composer::default(),inventory:Default::default(),offer:None,history:None,
            gift_confirmed:false,focused_item:None,pending:None,busy:false,polling:false,poll_error:None,request_epoch:0,deferred:None,last_seen_requested:"0".into(),view:0,
            notice:"Offers stay available while your trading partner is offline.".into(),error:None }
    }
}

impl TradingState {
    fn me(&self) -> &str { self.overview.as_ref().map(|o|o.player.player_id.as_str()).unwrap_or("") }
    fn enabled(&self) -> bool { self.overview.as_ref().is_some_and(|o|o.enabled) && self.pending.is_none() }
    fn navigate(&mut self,screen: TradeScreen) {
        self.screen = screen; self.view += 1; self.error = None;
        self.gift_confirmed = false; self.focused_item = None; self.list_offset = 0;
        self.notice=match self.screen {
            TradeScreen::FindPlayer=>"Enter a player name or exact trade code to find your trading partner.".into(),
            TradeScreen::Compose=>"Select up to 50 items per player. Right-click an item to inspect its full details.".into(),
            TradeScreen::Offer=>self.offer_guidance(),
            TradeScreen::Offers=>"Offers stay available while your trading partner is offline.".into(),
        };
    }
    fn offer_guidance(&self)->String {
        match self.offer.as_ref().map(|offer|offer.status.as_str()) {
            Some("accepted")=>"Trade completed. View history for the receipt and original StatTrak counts.",
            Some("cancelled")=>"Offer cancelled. No items changed owners.",
            Some("declined")=>"Offer declined. No items changed owners.",
            Some("expired")=>"This offer expired. Create a new offer to trade these items.",
            Some("invalidated")=>"The offered items changed. Create a new offer with the current inventory.",
            _ if self.offer.as_ref().is_some_and(|offer|offer.sender_id==self.me())=>"Offer sent. Your trading partner can respond while you are offline.",
            _=>"Review both sides. Accepting exchanges exactly these items.",
        }.into()
    }
    fn counter_reset_notice(&self)->bool {
        if self.screen==TradeScreen::Offer {
            self.offer.as_ref().is_some_and(|offer|offer.status=="pending"&&offer.items.iter().any(|item|item.stat_trak))
        }else{self.screen==TradeScreen::Compose&&self.composer.reviewing&&self.composer.selected.values().any(|item|item.stat_trak)}
    }
    fn begin_review(&mut self) {
        self.composer.reviewing=true;for side in &mut self.inventory{side.offset=0;}
        self.notice="Review both sides. Sending approves these exact items; your partner can accept while you are offline.".into();
    }
    fn refresh_task(&self) -> TradeTask {
        match self.screen {
            TradeScreen::Offers => TradeTask::Offers { folder:self.folder.clone(),before:self.offer_cursor.clone() },
            TradeScreen::Offer if self.offer.is_some() => TradeTask::Open(self.offer.as_ref().unwrap().id.clone()),
            _ => TradeTask::Overview,
        }
    }
    fn side_items(&self,side: usize) -> Vec<&Item> {
        let me = self.me();
        if self.screen == TradeScreen::Offer {
            self.offer.as_ref().map(|offer| offer.items.iter()
                .filter(|item| (item.owner_id == me) == (side == 0)).collect()).unwrap_or_default()
        } else if self.composer.reviewing {
            self.composer.selected.values().filter(|item|(item.owner_id == me) == (side == 0)).collect()
        } else { self.inventory[side].items.iter().collect() }
    }
    fn apply(&mut self,result: TradeResult) {
        if result.window != self.window { return; }
        self.busy = false;
        if result.view != self.view { return; }
        match result.data {
            Err(error) => {
                self.error = Some(error.message);
                if error.status == Some(401) { self.overview = None; }
                if result.mutation && error.status.is_some_and(|status|(400..500).contains(&status)) { self.pending = None; }
                if matches!(error.code.as_deref(),Some("stale_revision"|"items_changed"|"invalidated")) {
                    self.gift_confirmed=false;self.composer.reviewing=false;self.composer.gift_confirmed=false;
                }
            }
            Ok(data) => {
                self.error = None;
                match data {
                    TradeData::Overview(overview,pending) => self.apply_overview(overview,pending),
                    TradeData::Offers(overview,pending,page,before) => {
                        self.apply_overview(overview,pending);
                        if before != self.offer_cursor {
                            if self.offer_previous.last() == Some(&before) { self.offer_previous.pop(); }
                            else { self.offer_previous.push(self.offer_cursor.clone()); }
                        }
                        self.offer_cursor = before; self.offer_next = page.next_cursor; self.offers = page.offers;
                        self.list_offset = self.list_offset.min(self.offers.len().saturating_sub(1));
                    }
                    TradeData::Players(players) => { self.players = players; self.list_offset = 0; }
                    TradeData::Inventory(side,page,cursor,reset) => {
                        self.reconcile_selection(&page.items);
                        let inventory = &mut self.inventory[side];
                        if reset { inventory.previous.clear(); }
                        else if cursor != inventory.cursor {
                            if inventory.previous.last() == Some(&cursor) { inventory.previous.pop(); }
                            else { inventory.previous.push(inventory.cursor.clone()); }
                        }
                        inventory.items = page.items; inventory.next = page.next_cursor;
                        inventory.cursor = cursor; inventory.offset = 0;
                    }
                    TradeData::Compose(left,right) => {
                        self.reconcile_selection(&left.items); self.reconcile_selection(&right.items);
                        self.inventory = [TradeInventory { items:left.items,next:left.next_cursor,..Default::default() },
                            TradeInventory { items:right.items,next:right.next_cursor,..Default::default() }];
                    }
                    TradeData::RefreshedInventories(pages) => {
                        for (side,page) in pages.into_iter().enumerate() {
                            self.reconcile_selection(&page.items);
                            let inventory=&mut self.inventory[side];
                            inventory.items=page.items;inventory.next=page.next_cursor;
                            inventory.offset=inventory.offset.min(inventory.items.len().saturating_sub(1));
                        }
                    }
                    TradeData::Offer(offer,history) => {
                        let outcome_changed=self.offer.as_ref().is_some_and(|old|old.status!=offer.status);
                        if self.offer.as_ref().is_some_and(|old|old.revision != offer.revision || old.changed_asset_ids != offer.changed_asset_ids
                            || old.items.iter().map(|i|(&i.asset_id,&i.fingerprint,&i.owner_id,i.tradable))
                                .ne(offer.items.iter().map(|i|(&i.asset_id,&i.fingerprint,&i.owner_id,i.tradable)))) {
                            self.gift_confirmed = false;
                            self.notice = "This offer changed. Review the current items before accepting.".into();
                        }
                        self.offer = Some(offer); self.history = Some(history);
                        if outcome_changed {self.notice=self.offer_guidance();}
                    }
                    TradeData::Mutated(offer) => {
                        self.pending = None; self.navigate(TradeScreen::Offer);
                        self.notice = match offer.status.as_str() {
                            "accepted" => "Trade completed. Inventories are synchronizing. StatTrak starts at 0 for each new owner.",
                            "cancelled" => "Offer cancelled. Your items remain in your inventory.",
                            "declined" => "Offer declined. No items changed owners.",
                            _ => "Offer sent. Your trading partner can respond while you are offline.",
                        }.into();
                        self.offer = Some(offer); self.history = None; self.composer = Composer::default();
                    }
                    TradeData::Preferences(player) => {
                        if let Some(overview) = &mut self.overview { overview.player = player; }
                    }
                    TradeData::Seen(event_id) => {
                        self.last_seen_requested=event_id.clone();
                        if let Some(overview)=&mut self.overview {
                            if overview.latest_event_id==event_id {overview.unread_count=0;}
                        }
                    }
                }
            }
        }
    }
    fn apply_overview(&mut self,overview: Overview,pending: Option<PendingMutation>) {
        if self.overview.as_ref().is_some_and(|old|old.player.player_id != overview.player.player_id) {
            let busy = self.busy; let view = self.view;
            let window=self.window;let thumbnails=self.thumbnails.take();
            *self = Self::default(); self.busy = busy; self.view = view;self.window=window;self.thumbnails=thumbnails;
        }
        self.overview = Some(overview); self.pending = pending;
    }
    fn reconcile_selection(&mut self,items:&[Item]) {
        for item in items {
            if let Some(selected)=self.composer.selected.get(&item.asset_id) {
                if selected.fingerprint!=item.fingerprint || !item.tradable {
                    self.composer.selected.remove(&item.asset_id);
                    self.composer.reviewing=false;self.composer.gift_confirmed=false;
                    self.notice="A selected item changed and was removed. Choose it again to review its current details.".into();
                } else { self.composer.selected.insert(item.asset_id.clone(),item.clone()); }
            }
        }
    }
    fn message(&self)->&str {
        if self.screen==TradeScreen::Offer {self.offer.as_ref().map(|offer|offer.message.as_str()).unwrap_or("")}
        else {&self.composer.message}
    }
}

#[derive(Debug, Clone)]
struct TradeInventoryQuery { owner:String,query:String,kind:String,cursor:Option<String> }

#[derive(Debug, Clone)]
enum TradeTask {
    Overview,
    Offers { folder:String,before:Option<String> },
    Players(String),
    Compose { me:String,partner:String },
    RefreshInventories([TradeInventoryQuery;2]),
    Inventory { side:usize,owner:String,query:String,kind:String,cursor:Option<String>,reset:bool },
    Open(String),
    Mutate(PendingMutation),
    Preferences(bool),
    Seen(String),
}
#[derive(Debug)]
enum TradeData {
    Overview(Overview,Option<PendingMutation>),
    Offers(Overview,Option<PendingMutation>,OfferPage,Option<String>),
    Players(Vec<Player>),
    Compose(InventoryPage,InventoryPage),
    RefreshedInventories([InventoryPage;2]),
    Inventory(usize,InventoryPage,Option<String>,bool),
    Offer(Offer,EventPage),
    Mutated(Offer),
    Preferences(Player),
    Seen(String),
}
#[derive(Debug)]
struct TradeResult { window:u64,view:u64,mutation:bool,data:Result<TradeData,ApiError> }

fn execute_trade_task(task: TradeTask) -> Result<TradeData,ApiError> {
    let api = TradingApi::connected()?;
    match task {
        TradeTask::Overview => {
            let overview = api.overview()?; let pending = api.pending(&overview.player.player_id)?;
            Ok(TradeData::Overview(overview,pending))
        }
        TradeTask::Offers {folder,before} => {
            let overview = api.overview()?; let pending = api.pending(&overview.player.player_id)?;
            let page = api.offers(&folder,before.as_deref())?;
            Ok(TradeData::Offers(overview,pending,page,before))
        }
        TradeTask::Players(query) => Ok(TradeData::Players(api.players(&query)?)),
        TradeTask::Compose {me,partner} => Ok(TradeData::Compose(api.inventory(&me,"","",None)?,api.inventory(&partner,"","",None)?)),
        TradeTask::RefreshInventories([left,right]) => {
            let read=|q:TradeInventoryQuery|api.inventory(&q.owner,&q.query,&q.kind,q.cursor.as_deref());
            Ok(TradeData::RefreshedInventories([read(left)?,read(right)?]))
        }
        TradeTask::Inventory {side,owner,query,kind,cursor,reset} => {
            Ok(TradeData::Inventory(side,api.inventory(&owner,&query,&kind,cursor.as_deref())?,cursor,reset))
        }
        TradeTask::Open(id) => {
            let offer=api.offer(&id)?;
            let mut history=api.events(&id,"0")?;
            // At most 100 revisions plus a terminal event. Include the final
            // receipt when an offer reaches the maximum counteroffer count.
            if history.events.len()==100 {
                let next=api.events(&id,&history.next_cursor)?;
                history.events.extend(next.events);history.next_cursor=next.next_cursor;
            }
            Ok(TradeData::Offer(offer,history))
        }
        TradeTask::Mutate(pending) => Ok(TradeData::Mutated(api.mutate(&pending)?)),
        TradeTask::Preferences(allow) => Ok(TradeData::Preferences(api.preferences(allow)?)),
        TradeTask::Seen(event_id) => {api.seen(&event_id)?;Ok(TradeData::Seen(event_id))}
    }
}

fn trade_task(hwnd: HWND,task: TradeTask) {
    let (view,window) = {
        let Ok(mut state) = state().lock() else { return; };
        if state.trading.busy {
            if !matches!(task,TradeTask::Mutate(_)) { state.trading.deferred = Some(task); }
            return;
        }
        state.trading.request_epoch += 1;
        state.trading.busy = true; state.trading.error = None; state.trading.poll_error = None;
        (state.trading.view,state.trading.window)
    };
    let hwnd = hwnd as usize;
    thread::spawn(move || {
        let mutation=matches!(task,TradeTask::Mutate(_));
        let data = execute_trade_task(task);
        post_event(hwnd as HWND,UiEvent::Trading(TradeResult {window,view,mutation,data}));
    });
    sync_controls(hwnd as HWND);
    unsafe { InvalidateRect(hwnd as HWND,ptr::null(),0); }
}

fn refresh_trading(hwnd: HWND,manual:bool) {
    let task = state().lock().ok().map(|state| {
        let t=&state.trading;
        if manual && t.screen==TradeScreen::Compose && t.composer.partner.is_some() {
            TradeTask::RefreshInventories(std::array::from_fn(|side| {
                let inventory=&t.inventory[side];
                TradeInventoryQuery {owner:if side==0{t.me().into()}else{t.composer.partner.as_ref().unwrap().player_id.clone()},
                    query:inventory.query.clone(),kind:inventory.kind.clone(),cursor:inventory.cursor.clone()}
            }))
        } else {t.refresh_task()}
    });
    if let Some(task) = task {
        if manual || state().lock().is_ok_and(|s|s.trading.overview.is_none()) { trade_task(hwnd,task); }
        else { poll_trading(hwnd,task); }
    }
}

// Background reads keep controls enabled and existing content in place. A
// foreground request or navigation fences out a response that is now stale.
fn poll_trading(hwnd:HWND,task:TradeTask) {
    let (window,view,epoch) = {
        let Ok(mut s)=state().lock() else{return;};
        let t=&mut s.trading;
        if t.busy||t.polling{return;}
        t.polling=true;
        (t.window,t.view,t.request_epoch)
    };
    let handle=hwnd as usize;
    thread::spawn(move|| {
        let data=execute_trade_task(task);
        post_event(handle as HWND,UiEvent::TradePolled{epoch,result:TradeResult{window,view,mutation:false,data}});
    });
}

fn apply_trade_poll(t:&mut TradingState,epoch:u64,result:TradeResult)->bool {
    if result.window!=t.window{return false;}
    t.polling=false;
    if result.view!=t.view||epoch!=t.request_epoch||t.busy{return false;}
    // Compare payloads before touching state or native controls. Idle polls
    // produce no layout, focus, selection, or repaint work.
    let changed=match &result.data {
        Ok(TradeData::Overview(o,p))=>serde_json::to_value(o).ok()!=t.overview.as_ref().and_then(|o|serde_json::to_value(o).ok())||p!=&t.pending,
        Ok(TradeData::Offers(o,p,page,before))=>serde_json::to_value(o).ok()!=t.overview.as_ref().and_then(|o|serde_json::to_value(o).ok())
            ||p!=&t.pending||page.offers!=t.offers||page.next_cursor!=t.offer_next||before!=&t.offer_cursor,
        Ok(TradeData::Offer(offer,_))=>t.offer.as_ref()!=Some(offer),
        Err(error)=>t.poll_error.as_deref()!=Some(&error.message),
        _=>true,
    }||t.poll_error.is_some()&&result.data.is_ok();
    if changed {
        let local_error=if t.error!=t.poll_error {t.error.clone()}else{None};
        t.poll_error=result.data.as_ref().err().map(|e|e.message.clone());
        t.apply(result);
        if local_error.is_some(){t.error=local_error;}
    }
    changed
}

struct TradeLayout { sidebar:BoxRect,main:BoxRect,side:[BoxRect;2],rows:usize,columns:usize }
fn trade_layout(width:i32,height:i32) -> TradeLayout {
    let sidebar = box_rect(16,73,if width >= 1280 { 224 } else { 196 },height-186);
    let main = box_rect(sidebar.right+16,73,width-sidebar.right-32,height-186);
    let side_width = (main.width()-16)/2;
    let sides = [box_rect(main.left,main.top+86,side_width,main.height()-164),
        box_rect(main.left+side_width+16,main.top+86,side_width,main.height()-164)];
    TradeLayout { sidebar,main,side:sides,rows:((sides[0].height()-50)/126).clamp(1,4) as usize,columns:2 }
}
struct TradeControl { id:i32,rect:BoxRect,label:String,enabled:bool,edit:bool }
fn trade_controls(width:i32,height:i32,trading:&TradingState) -> Vec<TradeControl> {
    let l = trade_layout(width,height);
    let mut controls = vec![];
    let mut add = |id,rect,label:String,enabled,edit| controls.push(TradeControl {id,rect,label,enabled,edit});
    let r = l.sidebar;
    add(TRADE_NEW,box_rect(r.left+12,r.top+16,r.width()-24,40),"NEW OFFER".into(),trading.enabled()&&!trading.busy,false);
    for (index,(id,label)) in [(TRADE_INCOMING,"Incoming"),(TRADE_OUTGOING,"Outgoing"),(TRADE_HISTORY,"History")].iter().enumerate() {
        let count = trading.overview.as_ref().map_or(0,|o|o.incoming_count);
        let label = if *id == TRADE_INCOMING && count > 0 { format!("{label} ({count})") } else { (*label).into() };
        add(*id,box_rect(r.left+12,r.top+74+index as i32*42,r.width()-24,36),label,true,false);
    }
    add(TRADE_COPY,box_rect(r.left+12,r.bottom-116,r.width()-24,32),"COPY TRADE CODE".into(),trading.overview.is_some(),false);
    add(TRADE_PREFERENCES,box_rect(r.left+12,r.bottom-70,r.width()-24,36),
        if trading.overview.as_ref().is_some_and(|o|o.player.allow_offers) {"OFFERS ALLOWED"} else {"OFFERS PAUSED"}.into(),trading.overview.is_some()&&!trading.busy,false);
    let main = l.main;
    if trading.pending.is_some() && !trading.busy {
        add(TRADE_RECOVER,box_rect(r.left+12,r.top+232,r.width()-24,36),"RECOVER REQUEST".into(),true,false);
    }
    match trading.screen {
        TradeScreen::Offers|TradeScreen::FindPlayer => {
            let finding = trading.screen == TradeScreen::FindPlayer;
            if finding {
                add(TRADE_QUERY,box_rect(main.left,main.top+52,main.width()-108,34),"Player name or exact trade code".into(),true,true);
                add(TRADE_SEARCH,box_rect(main.right-96,main.top+52,96,34),"FIND PLAYER".into(),!trading.busy,false);
            }
            let top = main.top+if finding {106} else {62};
            let rows = ((main.bottom-top-62)/68).clamp(1,8) as usize;
            for index in 0..rows {
                let actual = trading.list_offset+index;
                let label = if finding {
                    trading.players.get(actual).map(|p|format!("{} · {}",p.display_name,p.trade_code))
                } else {
                    trading.offers.get(actual).map(|o|format!("{} · {} · {} items",o.partner(trading.me()).map(|p|p.display_name.as_str()).unwrap_or("B2G player"),o.status,o.total_items()))
                };
                if let Some(label) = label { add(TRADE_ROW_BASE+index as i32,box_rect(main.left,top+index as i32*68,main.width(),60),label,!trading.busy,false); }
            }
            add(TRADE_PREVIOUS,box_rect(main.left,main.bottom-36,100,32),"PREVIOUS".into(),!trading.busy&&(trading.list_offset>0||!trading.offer_previous.is_empty()),false);
            let count = if finding {trading.players.len()} else {trading.offers.len()};
            add(TRADE_NEXT,box_rect(main.right-100,main.bottom-36,100,32),"NEXT".into(),!trading.busy&&(trading.list_offset+rows<count||!finding&&trading.offer_next.is_some()),false);
        }
        TradeScreen::Compose|TradeScreen::Offer => {
            let reviewing = trading.screen == TradeScreen::Offer||trading.composer.reviewing;
            if reviewing && !trading.message().is_empty() {
                add(TRADE_READ_MESSAGE,box_rect(main.left,main.top+55,main.width(),28),format!("Message: {}",trading.message()),true,false);
            }
            for side in 0..2 {
                let r = l.side[side];
                if !reviewing {
                    add(TRADE_GIVE_QUERY+side as i32,box_rect(r.left,r.top-34,r.width()-118,30),"Search items".into(),true,true);
                    add(TRADE_GIVE_SEARCH+side as i32,box_rect(r.right-108,r.top-34,44,30),"FIND".into(),!trading.busy,false);
                    add(TRADE_GIVE_KIND+side as i32,box_rect(r.right-60,r.top-34,60,30),
                        match trading.inventory[side].kind.as_str(){"case"=>"CASES","cosmetic"=>"ITEMS",_=>"ALL"}.into(),!trading.busy,false);
                }
                let items = trading.side_items(side);
                let offset = trading.inventory[side].offset;
                let visible = l.rows*l.columns;
                let tile_width = (r.width()-10)/2;
                for index in 0..visible {
                    if let Some(item) = items.get(offset+index) {
                        let selected = trading.composer.selected.contains_key(&item.asset_id);
                        let label = format!("{}{} · {}{}",if selected {"Selected: "} else {""},item.display_name,item.condition(),
                            if !item.tradable {" · Cannot trade"} else {""});
                        add(TRADE_ITEM_BASE+(side*12+index) as i32,box_rect(r.left+(index%2) as i32*(tile_width+10),r.top+32+(index/2) as i32*126,tile_width,116),label,!trading.busy,false);
                    }
                }
                add(if side==0{TRADE_GIVE_PREV}else{TRADE_RECEIVE_PREV},box_rect(r.left,r.bottom-28,72,28),"PREV".into(),!trading.busy&&(offset>0||!reviewing&&!trading.inventory[side].previous.is_empty()),false);
                add(if side==0{TRADE_GIVE_NEXT}else{TRADE_RECEIVE_NEXT},box_rect(r.right-72,r.bottom-28,72,28),"NEXT".into(),!trading.busy&&(offset+visible<items.len()||!reviewing&&trading.inventory[side].next.is_some()),false);
            }
            if trading.screen==TradeScreen::Compose {
                if !trading.composer.reviewing {
                    add(TRADE_MESSAGE,box_rect(main.left,main.bottom-54,main.width()-206,36),"Optional message".into(),true,true);
                } else {
                    let gift = trading.composer.terms(trading.me()).is_ok_and(|terms|terms.give_asset_ids.is_empty()||terms.receive_asset_ids.is_empty());
                    if gift { add(TRADE_GIFT,box_rect(main.left,main.bottom-54,main.width()-206,36),
                        if trading.composer.gift_confirmed{"GIFT CONFIRMED"}else{"CONFIRM THIS IS A GIFT"}.into(),true,false); }
                    add(TRADE_BACK,box_rect(main.left,main.top+4,72,28),"EDIT".into(),!trading.busy,false);
                }
                add(TRADE_PRIMARY,box_rect(main.right-190,main.bottom-54,190,40),
                    if trading.composer.reviewing{"SEND OFFER"}else{"REVIEW OFFER"}.into(),trading.enabled()&&!trading.busy&&!trading.composer.selected.is_empty(),false);
            } else if let Some(offer)=&trading.offer {
                if offer.status=="pending" {
                    if offer.sender_id==trading.me() {
                        add(TRADE_CANCEL,box_rect(main.right-180,main.bottom-54,180,40),"CANCEL OFFER".into(),!trading.busy&&trading.pending.is_none(),false);
                    } else {
                        add(TRADE_PRIMARY,box_rect(main.right-180,main.bottom-54,180,40),"ACCEPT TRADE".into(),trading.enabled()&&!trading.busy&&offer.can_accept(trading.me()),false);
                        add(TRADE_COUNTER,box_rect(main.right-310,main.bottom-54,118,40),"COUNTER".into(),trading.enabled()&&!trading.busy&&offer.fully_loaded(),false);
                        add(TRADE_DECLINE,box_rect(main.right-436,main.bottom-54,114,40),"DECLINE".into(),!trading.busy&&trading.pending.is_none(),false);
                        if offer.is_gift() { add(TRADE_GIFT,box_rect(main.left,main.top+4,176,28),
                            if trading.gift_confirmed{"GIFT CONFIRMED"}else{"CONFIRM GIFT"}.into(),!trading.busy,false); }
                    }
                }
                add(TRADE_RECEIPT,box_rect(main.left,main.bottom-54,136,40),"VIEW HISTORY".into(),trading.history.is_some(),false);
            }
            if trading.focused_item.is_some() { add(TRADE_INSPECT,box_rect(main.right-120,main.top+4,120,28),"ITEM DETAILS".into(),true,false); }
        }
    }
    controls
}

fn trade_text(dc:HDC,p:&mut PaintObjects,text:&str,rect:BoxRect,size:i32,color:COLORREF) {
    text_row(dc,p,text,rect,size,500,false,color,DT_WORDBREAK|DT_END_ELLIPSIS|DT_NOPREFIX,0);
}
fn paint_trading(dc:HDC,width:i32,height:i32,trading:&TradingState) {
    let mut p = PaintObjects::new(); let l = trade_layout(width,height);
    fill(dc,&mut p,l.sidebar,PANEL);
    let r = l.sidebar;
    trade_text(dc,&mut p,"YOUR TRADE CODE",box_rect(r.left+12,r.bottom-176,r.width()-24,20),12,MUTED);
    text_row(dc,&mut p,trading.overview.as_ref().map(|o|o.player.trade_code.as_str()).unwrap_or("Connect account"),
        box_rect(r.left+12,r.bottom-150,r.width()-24,26),12,500,true,INK,SINGLE,0);
    let main = l.main;
    let title = match trading.screen {
        TradeScreen::FindPlayer => "New offer",
        TradeScreen::Compose if trading.composer.reviewing => "Review your offer",
        TradeScreen::Compose => "Choose your items",
        TradeScreen::Offer => "Review trade",
        _ => match trading.folder.as_str(){"outgoing"=>"Sent offers","history"=>"Trade history",_=>"Incoming offers"},
    };
    let header_offset = if trading.screen==TradeScreen::Compose&&trading.composer.reviewing {88} else if trading.screen==TradeScreen::Offer&&trading.offer.as_ref().is_some_and(|o|o.is_gift()) {184} else {0};
    trade_text(dc,&mut p,title,box_rect(main.left+header_offset,main.top,main.width()-header_offset-130,34),24,INK);
    let subtitle = if let Some(error) = &trading.error { error.as_str() }
        else if trading.busy { "Synchronizing trading…" }
        else if trading.pending.is_some() { "A request needs recovery. Its original terms are saved." }
        else if trading.overview.is_none() { "Connect your B2G account to send and receive item offers." }
        else if !trading.overview.as_ref().unwrap().enabled { "Trading is paused. You can still review history, decline or cancel offers." }
        else { &trading.notice };
    text_row(dc,&mut p,subtitle,box_rect(main.left,main.bottom+2,main.width(),14),12,500,false,
        if trading.error.is_some(){ERROR}else{MUTED},SINGLE|DT_NOPREFIX,0);
    match trading.screen {
        TradeScreen::Offers|TradeScreen::FindPlayer => {
            let finding = trading.screen==TradeScreen::FindPlayer;
            let empty = if finding {trading.players.is_empty()} else {trading.offers.is_empty()};
            if empty && !trading.busy {
                trade_text(dc,&mut p,if finding {"Find your trading partner"} else {"No offers here yet"},
                    box_rect(main.left+24,main.top+150,main.width()-48,36),22,INK);
                trade_text(dc,&mut p,if finding {"Enter a player name or their 16-character B2G trade code. Check their identity before choosing items."}
                    else if trading.folder=="incoming" {"Share your trade code, or choose New Offer to start an exchange."}
                    else if trading.folder=="outgoing" {"Offers you send will appear here until your partner responds."}
                    else {"Completed, cancelled, declined and expired offers will appear here."},
                    box_rect(main.left+24,main.top+192,(main.width()-48).min(550),70),16,MUTED);
            }
        }
        TradeScreen::Compose|TradeScreen::Offer => {
            let partner = if trading.screen==TradeScreen::Compose {trading.composer.partner.as_ref()}
                else {trading.offer.as_ref().and_then(|offer|offer.partner(trading.me()))};
            if let Some(partner) = partner {
                let partner_line = format!("With {} · {}",partner.display_name,partner.trade_code);
                trade_text(dc,&mut p,&partner_line,box_rect(main.left,main.top+34,main.width(),20),14,MUTED);
            }
            for side in 0..2 {
                let r = l.side[side]; let items = trading.side_items(side);
                let count = if trading.screen==TradeScreen::Offer {items.len()} else {
                    trading.composer.selected.values().filter(|item|(item.owner_id==trading.me())==(side==0)).count()
                };
                trade_text(dc,&mut p,&format!("{} ({count})",if side==0{"You give"}else{"You receive"}),box_rect(r.left,r.top,r.width(),24),18,INK);
                if items.is_empty() && !trading.busy {
                    trade_text(dc,&mut p,if trading.screen==TradeScreen::Offer&&trading.offer.as_ref().is_some_and(|o|!o.fully_loaded()) {"Item details unavailable.\nUse Refresh to retry."}
                        else if trading.screen==TradeScreen::Offer||trading.composer.reviewing {"No items on this side.\nThis is a gift."}else{"No matching items.\nTry another search or item type."},
                        box_rect(r.left+16,r.top+68,r.width()-32,90),16,MUTED);
                }
            }
            if let Some(offer)=&trading.offer {
                if trading.screen==TradeScreen::Offer {
                    let mut status = if !offer.changed_asset_ids.is_empty(){"Items changed. Counter with fresh items or decline this offer.".into()}
                        else if offer.status=="pending" {format!("Revision {} · Expires {}",offer.revision,&offer.expires_at[..offer.expires_at.len().min(10)])}
                        else {format!("{} · {}",offer.status.to_uppercase(),offer.status_reason.as_deref().unwrap_or("Recorded in trade history"))};
                    if trading.counter_reset_notice()&&offer.changed_asset_ids.is_empty() {
                        status.push_str(" · StatTrak resets to 0 for the new owner.");
                    }
                    trade_text(dc,&mut p,&status,box_rect(main.left,main.bottom-76,main.width(),20),14,
                        if !offer.changed_asset_ids.is_empty(){GOLD}else if trading.counter_reset_notice(){INK}else{MUTED});
                }
            }
            if trading.screen==TradeScreen::Compose&&trading.counter_reset_notice() {
                trade_text(dc,&mut p,"StatTrak resets to 0 for the new owner. Original counts stay in history.",
                    box_rect(main.left,main.bottom-76,main.width(),20),14,INK);
            }
        }
    }
    for control in trade_controls(width,height,trading) {
        if !control.edit { paint_trade_button(dc,control.rect,control.id,trading,false,false,control.enabled,false,&control.label); }
    }
}

fn trade_item_for_control(trading:&TradingState,id:i32) -> Option<&Item> {
    let index = (id-TRADE_ITEM_BASE) as usize;
    if index >= 24 { return None; }
    let side = index/12;
    trading.side_items(side).get(trading.inventory[side].offset+index%12).copied()
}
fn paint_trade_button(dc:HDC,r:BoxRect,id:i32,trading:&TradingState,pressed:bool,focused:bool,enabled:bool,hovered:bool,label:&str) {
    let mut p = PaintObjects::new();
    // Control rectangles here are local on WM_DRAWITEM and absolute in fixture
    // renders, so only the ID determines data; geometry never changes identity.
    let selected_folder = match id {TRADE_INCOMING=>trading.folder=="incoming",TRADE_OUTGOING=>trading.folder=="outgoing",TRADE_HISTORY=>trading.folder=="history",_=>false}
        &&trading.screen==TradeScreen::Offers;
    let primary = matches!(id,TRADE_NEW|TRADE_PRIMARY);
    let selected = trade_item_for_control(trading,id).is_some_and(|item|trading.composer.selected.contains_key(&item.asset_id));
    let item_tile=trade_item_for_control(trading,id).is_some();
    let background = if item_tile{PANEL}else if !enabled{INSET}else if primary&&hovered{rgb(131,179,241)}else if primary {BLUE}else if pressed||selected_folder||selected||hovered{INSET}else{PANEL};
    fill(dc,&mut p,r,background);
    if focused||selected { unsafe { FrameRect(dc,&r.inset(1).native(),p.brush(BLUE)); } }
    if let Some(item)=trade_item_for_control(trading,id) {
        let color = match item.rarity {1=>rgb(176,195,217),2=>rgb(94,152,217),3=>rgb(75,105,255),4=>rgb(136,71,255),5=>rgb(211,44,230),6=>rgb(235,75,75),7=>rgb(228,174,57),_=>MUTED};
        fill(dc,&mut p,box_rect(r.left+8,r.bottom-3,r.width()-16,1),color);
        if hovered&&!selected&&!focused { unsafe {FrameRect(dc,&r.inset(1).native(),p.brush(MUTED));} }
        if let Some(image)=item.image_url.as_deref().and_then(|path|trading.thumbnails.as_ref()?.image(path)) {
            paint_trade_image(dc,&image,box_rect(r.left+10,r.top+8,r.width()-20,57));
        } else {
            let missing=if let Some(path)=&item.image_url {
                if trading.thumbnails.as_ref().is_some_and(|loader|loader.failed(path)){"IMAGE UNAVAILABLE"}else{"LOADING IMAGE"}
            }else{"NO ITEM IMAGE"};
            text_row(dc,&mut p,missing,
                box_rect(r.left+10,r.top+24,r.width()-20,20),10,500,false,MUTED,SINGLE|DT_CENTER,0);
        }
        trade_text(dc,&mut p,&item.display_name,box_rect(r.left+10,r.top+67,r.width()-20,30),14,if enabled{INK}else{MUTED});
        trade_text(dc,&mut p,if item.tradable{item.condition()}else{"ACCOUNT-BOUND"},box_rect(r.left+10,r.top+97,r.width()-20,16),11,MUTED);
        if selected {trade_text(dc,&mut p,"SELECTED",box_rect(r.right-78,r.top+2,68,14),10,BLUE);}
        return;
    }
    if id==TRADE_READ_MESSAGE {
        text_row(dc,&mut p,label,box_rect(r.left+8,r.top+4,r.width()-122,20),14,400,false,INK,SINGLE|DT_NOPREFIX,0);
        text_row(dc,&mut p,"READ MESSAGE",box_rect(r.right-110,r.top+4,102,20),11,600,false,BLUE,SINGLE|DT_RIGHT,0);
        return;
    }
    let label = if (TRADE_ROW_BASE..TRADE_ROW_BASE+8).contains(&id) {
        let index = trading.list_offset+(id-TRADE_ROW_BASE) as usize;
        if trading.screen==TradeScreen::FindPlayer {trading.players.get(index).map(|p|format!("{}\n{}",p.display_name,p.trade_code))}
        else {trading.offers.get(index).map(|o|format!("{}\n{} · {} items · Revision {}",o.partner(trading.me()).map(|p|p.display_name.as_str()).unwrap_or("B2G player"),o.status,o.total_items(),o.revision))}
    } else { Some(label.to_string()) }.unwrap_or_default();
    let row=(TRADE_ROW_BASE..TRADE_ROW_BASE+8).contains(&id);
    let text_box=if row{r.inset(8)}else{box_rect(r.left+8,r.top+4,r.width()-16,r.height()-8)};
    text_row(dc,&mut p,&label,text_box,if row{16}else{13},600,false,
        if !enabled{MUTED}else if primary{BLUE_INK}else if selected_folder{BLUE}else{INK},
        DT_END_ELLIPSIS|DT_NOPREFIX|if row{DT_WORDBREAK}else{DT_SINGLELINE|DT_VCENTER|DT_CENTER},0);
}

fn paint_trade_image(dc:HDC,image:&crate::trading::art::Thumbnail,r:BoxRect) {
    let factor=(r.width() as f64/image.width as f64).min(r.height() as f64/image.height as f64);
    let width=(image.width as f64*factor) as i32;let height=(image.height as f64*factor) as i32;
    unsafe {
        SetStretchBltMode(dc,HALFTONE);
        StretchDIBits(dc,r.left+(r.width()-width)/2,r.top+(r.height()-height)/2,width,height,0,0,image.width,image.height,
            image.pixels.as_ptr().cast(),&bitmap_info(image.width,image.height),DIB_RGB_COLORS,SRCCOPY);
    }
}
fn trade_control_ids() -> Vec<i32> {
    (2000..=2017).chain(2020..=2031).chain(2100..2108).chain(2200..2224).chain([TRADE_INSPECT]).collect()
}
fn trade_is_edit(id:i32) -> bool { matches!(id,TRADE_QUERY|TRADE_MESSAGE|TRADE_GIVE_QUERY|TRADE_RECEIVE_QUERY) }
fn create_trade_controls(hwnd:HWND) {
    for id in trade_control_ids() {
        let edit = trade_is_edit(id);
        unsafe {
            let child = CreateWindowExW(0,wide(if edit{"EDIT"}else{"BUTTON"}).as_ptr(),wide("").as_ptr(),
                WS_CHILD|WS_TABSTOP|if edit{ES_AUTOHSCROLL as u32}else{BS_OWNERDRAW as u32},
                0,0,1,1,hwnd,id as usize as HMENU,GetModuleHandleW(ptr::null()),ptr::null());
            if !child.is_null() {
                if edit { SendMessageW(child,windows_sys::Win32::UI::Controls::EM_SETLIMITTEXT,if id==TRADE_MESSAGE{240}else{80},0); }
                else { SetWindowSubclass(child,Some(button_proc),id as usize,0); }
                SetWindowSubclass(child,Some(trade_child_proc),id as usize,0);
            }
        }
    }
    sync_trade_controls(hwnd);
}
fn sync_trade_controls(hwnd:HWND) {
    let client = logical_client(hwnd);
    let (open,controls,values) = {
        let Ok(s)=state().lock() else{return;};
        ((s.tab == LauncherTab::Trading),trade_controls(client.right,client.bottom,&s.trading),[
            (TRADE_QUERY,s.trading.query.clone()),(TRADE_MESSAGE,s.trading.composer.message.clone()),
            (TRADE_GIVE_QUERY,s.trading.inventory[0].query.clone()),(TRADE_RECEIVE_QUERY,s.trading.inventory[1].query.clone())])
    };
    let dpi=unsafe{GetDpiForWindow(hwnd)}.max(96) as i32;
    let mut p=PaintObjects::new(); let font=p.typeface(15*dpi/96,400,false);
    for id in trade_control_ids() {
        let child=unsafe{GetDlgItem(hwnd,id)};
        if child.is_null(){continue;}
        let control=controls.iter().find(|c|c.id==id);
        unsafe {
            if !open||control.is_none() { ShowWindow(child,SW_HIDE); continue; }
            let control=control.unwrap(); let r=control.rect;
            MoveWindow(child,r.left*dpi/96,r.top*dpi/96,r.width()*dpi/96,r.height()*dpi/96,1);
            EnableWindow(child,i32::from(control.enabled));
            SendMessageW(child,WM_SETFONT,font as usize,0);
            if control.edit {
                if let Some((_,value))=values.iter().find(|(key,_)|*key==id) {
                    if trade_edit_text(hwnd,id)!=*value {SetWindowTextW(child,wide(value).as_ptr());}
                }
            } else { SetWindowTextW(child,wide(&control.label).as_ptr()); }
            ShowWindow(child,SW_SHOWNOACTIVATE);
            InvalidateRect(child,ptr::null(),0);
        }
    }
    request_trade_images(hwnd,client.right,client.bottom);
}
fn request_trade_images(hwnd:HWND,width:i32,height:i32) {
    let Ok(mut state)=state().lock() else{return;};
    if state.tab == LauncherTab::Trading  && state.trading.thumbnails.is_none() {
        let handle=hwnd as usize;let window=state.trading.window;
        state.trading.thumbnails=Some(std::sync::Arc::new(crate::trading::art::Loader::new(move || unsafe {
            PostMessageW(handle as HWND,TRADE_IMAGES,window as usize,0);
        })));
    }
    if let Some(loader)=&state.trading.thumbnails {
        let paths=if state.tab == LauncherTab::Trading  {trade_controls(width,height,&state.trading).iter()
            .filter_map(|c|trade_item_for_control(&state.trading,c.id)?.image_url.clone()).collect::<Vec<_>>()}else{vec![]};
        loader.request(&paths);
    }
}
fn trade_edit_text(hwnd:HWND,id:i32)->String {
    let mut text=[0u16;512];
    let length=unsafe{GetWindowTextW(GetDlgItem(hwnd,id),text.as_mut_ptr(),text.len() as i32)}.max(0) as usize;
    String::from_utf16_lossy(&text[..length])
}
fn trade_edit_changed(hwnd:HWND,id:i32) {
    if !trade_is_edit(id){return;}
    let value=trade_edit_text(hwnd,id);
    if let Ok(mut s)=state().lock(){
        match id {
            TRADE_QUERY=>s.trading.query=value,
            TRADE_MESSAGE=>{s.trading.composer.message=value;s.trading.composer.reviewing=false;s.trading.composer.gift_confirmed=false;}
            TRADE_GIVE_QUERY=>s.trading.inventory[0].query=value,
            TRADE_RECEIVE_QUERY=>s.trading.inventory[1].query=value,
            _=>{}
        }
    }
}
fn trade_edit_colors(dc:HDC)->LRESULT {
    static BRUSH:OnceLock<usize>=OnceLock::new();
    unsafe{SetTextColor(dc,INK);SetBkColor(dc,INSET);}
    *BRUSH.get_or_init(||unsafe{CreateSolidBrush(INSET) as usize}) as LRESULT
}
unsafe extern "system" fn trade_child_proc(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM,id:usize,_data:usize)->LRESULT {
    unsafe {
        let parent=GetParent(hwnd);
        match message {
            WM_PAINT|WM_PRINTCLIENT if trade_is_edit(id as i32)=>{
                let result=DefSubclassProc(hwnd,message,wparam,lparam);
                if GetWindowTextLengthW(hwnd)==0 {
                    let dc=if message==WM_PRINTCLIENT{wparam as HDC}else{GetDC(hwnd)};
                    if !dc.is_null(){paint_trade_cue(hwnd,dc,id as i32);if message!=WM_PRINTCLIENT{ReleaseDC(hwnd,dc);}}
                }
                return result;
            }
            WM_KEYDOWN if wparam==13&&trade_is_edit(id as i32)=>{
                let command=match id as i32{TRADE_GIVE_QUERY=>TRADE_GIVE_SEARCH,TRADE_RECEIVE_QUERY=>TRADE_RECEIVE_SEARCH,TRADE_MESSAGE=>TRADE_PRIMARY,_=>TRADE_SEARCH};
                trade_command(parent,command);return 0;
            }
            WM_SETFOCUS if (TRADE_ITEM_BASE..TRADE_ITEM_BASE+24).contains(&(id as i32))=>{
                if let Ok(mut s)=state().lock(){s.trading.focused_item=trade_item_for_control(&s.trading,id as i32).cloned();}
                sync_trade_controls(parent);
            }
            WM_CONTEXTMENU if (TRADE_ITEM_BASE..TRADE_ITEM_BASE+24).contains(&(id as i32))=>{
                if let Ok(mut s)=state().lock(){s.trading.focused_item=trade_item_for_control(&s.trading,id as i32).cloned();}
                trade_command(parent,TRADE_INSPECT);return 0;
            }
            WM_MOUSEWHEEL=>{trade_scroll(parent,wparam,lparam);return 0;}
            WM_NCDESTROY=>{RemoveWindowSubclass(hwnd,Some(trade_child_proc),id);}
            _=>{}
        }
        DefSubclassProc(hwnd,message,wparam,lparam)
    }
}
fn paint_trade_cue(hwnd:HWND,dc:HDC,id:i32){
    // Draw empty-field hints even without themed common controls, including
    // native PrintWindow captures. The real EDIT retains its caret and text.
    unsafe {
        let cue=match id{TRADE_QUERY=>"Player name or exact trade code",TRADE_MESSAGE=>"Optional message",_=>"Search items"};
        let dpi=GetDpiForWindow(hwnd).max(96) as i32;let mut r:RECT=std::mem::zeroed();GetClientRect(hwnd,&mut r);
        r.left+=6*dpi/96;r.right-=6*dpi/96;
        let saved=SaveDC(dc);let font=SendMessageW(hwnd,WM_GETFONT,0,0) as HGDIOBJ;
        if !font.is_null(){SelectObject(dc,font);}SetBkMode(dc,TRANSPARENT as i32);SetTextColor(dc,MUTED);
        let mut text=wide(cue);DrawTextW(dc,text.as_mut_ptr(),(text.len()-1) as i32,&mut r,DT_SINGLELINE|DT_VCENTER|DT_END_ELLIPSIS|DT_NOPREFIX);
        RestoreDC(dc,saved);
    }
}
fn trade_clipboard(hwnd:HWND,value:&str)->bool {
    use windows_sys::Win32::System::DataExchange::{OpenClipboard,EmptyClipboard,SetClipboardData,CloseClipboard};
    use windows_sys::Win32::System::Memory::{GlobalAlloc,GlobalLock,GlobalUnlock,GMEM_MOVEABLE};
    unsafe {
        let text=wide(value);let memory=GlobalAlloc(GMEM_MOVEABLE,text.len()*2);
        if memory.is_null(){return false;}
        let target=GlobalLock(memory) as *mut u16;
        if target.is_null(){windows_sys::Win32::Foundation::GlobalFree(memory);return false;}
        ptr::copy_nonoverlapping(text.as_ptr(),target,text.len());GlobalUnlock(memory);
        if OpenClipboard(hwnd)==0{windows_sys::Win32::Foundation::GlobalFree(memory);return false;}
        let okay=EmptyClipboard()!=0&&!SetClipboardData(13,memory).is_null(); // CF_UNICODETEXT
        CloseClipboard();if !okay{windows_sys::Win32::Foundation::GlobalFree(memory);}okay
    }
}
fn trade_inventory_task(trading:&TradingState,side:usize,cursor:Option<String>,reset:bool)->Option<TradeTask> {
    let owner=if side==0{trading.me().to_string()}else{trading.composer.partner.as_ref()?.player_id.clone()};
    let inventory=&trading.inventory[side];
    Some(TradeTask::Inventory{side,owner,query:inventory.query.clone(),kind:inventory.kind.clone(),cursor,reset})
}
fn trade_command(hwnd:HWND,id:i32) {
    let client=logical_client(hwnd);let layout=trade_layout(client.right,client.bottom);
    let mut task=None;let mut copy=None;let mut inspect=None;let mut receipt=None;let mut message=None;
    {
        let Ok(mut state)=state().lock() else{return;};let t=&mut state.trading;
        if t.busy&&!matches!(id,TRADE_COPY|TRADE_INSPECT){return;}
        t.error=None;
        match id {
            TRADE_NEW if t.enabled()=>{
                t.navigate(TradeScreen::FindPlayer);t.players.clear();t.query.clear();
                t.composer=Composer::default();t.notice="Enter a name or exact trade code to find another B2G player.".into();
            }
            TRADE_INCOMING|TRADE_OUTGOING|TRADE_HISTORY=>{
                t.navigate(TradeScreen::Offers);t.folder=match id{TRADE_OUTGOING=>"outgoing",TRADE_HISTORY=>"history",_=>"incoming"}.into();
                t.offer_cursor=None;t.offer_next=None;t.offer_previous.clear();t.offers.clear();task=Some(t.refresh_task());
            }
            TRADE_COPY=>copy=t.overview.as_ref().map(|o|o.player.trade_code.clone()),
            TRADE_SEARCH=>{
                if t.query.trim().chars().count()<2{t.error=Some("Enter at least two characters, or paste an exact trade code.".into());}
                else{t.view+=1;task=Some(TradeTask::Players(t.query.trim().to_string()));}
            }
            TRADE_RECOVER=>task=t.pending.clone().map(TradeTask::Mutate),
            TRADE_PREFERENCES=>task=t.overview.as_ref().map(|o|TradeTask::Preferences(!o.player.allow_offers)),
            TRADE_INSPECT=>inspect=t.focused_item.clone(),
            TRADE_RECEIPT=>receipt=t.history.as_ref().map(|page|trade_history_text(page,t.offer.as_ref())),
            TRADE_READ_MESSAGE=>message=Some(t.message().to_string()),
            TRADE_BACK=>{t.composer.reviewing=false;t.composer.gift_confirmed=false;for side in &mut t.inventory{side.offset=0;}
                t.notice="Select up to 50 items per player. Right-click an item to inspect its full details.".into();}
            TRADE_GIFT=>{
                if t.screen==TradeScreen::Compose{t.composer.gift_confirmed=!t.composer.gift_confirmed;}
                else{t.gift_confirmed=!t.gift_confirmed;}
            }
            TRADE_PRIMARY if t.enabled()=>{
                if t.screen==TradeScreen::Compose{
                    match t.composer.terms(t.me()){
                        Err(error)=>t.error=Some(error),
                        Ok(terms) if !t.composer.reviewing=>{
                            t.begin_review();
                        }
                        Ok(terms)=>{
                            if (terms.give_asset_ids.is_empty()||terms.receive_asset_ids.is_empty())&&!terms.confirm_gift{
                                t.error=Some("Confirm this one-way gift before sending it.".into());
                            }else{
                                let mutation=if let Some((offer_id,revision))=&t.composer.counter{Mutation::Counter{offer_id:offer_id.clone(),revision:*revision,terms}}
                                    else{Mutation::Send{recipient_id:t.composer.partner.as_ref().unwrap().player_id.clone(),terms}};
                                match PendingMutation::new(t.me().to_string(),mutation){Ok(pending)=>{t.pending=Some(pending.clone());task=Some(TradeTask::Mutate(pending));},Err(error)=>t.error=Some(error)}
                            }
                        }
                    }
                }else if let Some(offer)=&t.offer{
                    if offer.can_accept(t.me()){
                        if offer.is_gift()&&!t.gift_confirmed{t.error=Some("Confirm the empty side of this gift before accepting.".into());}
                        else{
                            let mutation=Mutation::Respond{offer_id:offer.id.clone(),revision:offer.revision,response:"accept".into(),confirm_gift:t.gift_confirmed};
                            match PendingMutation::new(t.me().into(),mutation){Ok(pending)=>{t.pending=Some(pending.clone());task=Some(TradeTask::Mutate(pending));},Err(error)=>t.error=Some(error)}
                        }
                    }
                }
            }
            TRADE_COUNTER if t.enabled()=>{
                if let Some(offer)=t.offer.clone(){
                    if offer.status=="pending"&&offer.sender_id!=t.me(){
                        t.composer=Composer{partner:offer.partner(t.me()).cloned(),counter:Some((offer.id.clone(),offer.revision)),
                            selected:offer.items.iter().filter(|item|!offer.changed_asset_ids.contains(&item.asset_id))
                                .map(|item|(item.asset_id.clone(),item.clone())).collect(),..Default::default()};
                        t.navigate(TradeScreen::Compose);
                        t.notice=if offer.changed_asset_ids.is_empty(){"Choose new terms. Your partner will need to review the counteroffer."}
                            else{"Changed items were removed. Choose replacements before sending a counteroffer."}.into();
                        if let Some(partner)=&t.composer.partner{task=Some(TradeTask::Compose{me:t.me().into(),partner:partner.player_id.clone()});}
                    }
                }
            }
            TRADE_CANCEL|TRADE_DECLINE if t.pending.is_none()=>{
                if let Some(offer)=&t.offer{
                    let response=if id==TRADE_CANCEL{"cancel"}else{"decline"};
                    let mutation=Mutation::Respond{offer_id:offer.id.clone(),revision:offer.revision,response:response.into(),confirm_gift:false};
                    match PendingMutation::new(t.me().into(),mutation){Ok(pending)=>{t.pending=Some(pending.clone());task=Some(TradeTask::Mutate(pending));},Err(error)=>t.error=Some(error)}
                }
            }
            TRADE_GIVE_SEARCH|TRADE_RECEIVE_SEARCH|TRADE_GIVE_KIND|TRADE_RECEIVE_KIND=>{
                let side=usize::from(matches!(id,TRADE_RECEIVE_SEARCH|TRADE_RECEIVE_KIND));
                if matches!(id,TRADE_GIVE_KIND|TRADE_RECEIVE_KIND){t.inventory[side].kind=match t.inventory[side].kind.as_str(){""=>"cosmetic","cosmetic"=>"case",_=>""}.into();}
                t.view+=1;task=trade_inventory_task(t,side,None,true);
            }
            TRADE_GIVE_PREV|TRADE_GIVE_NEXT|TRADE_RECEIVE_PREV|TRADE_RECEIVE_NEXT=>{
                let side=usize::from(matches!(id,TRADE_RECEIVE_PREV|TRADE_RECEIVE_NEXT));let next=matches!(id,TRADE_GIVE_NEXT|TRADE_RECEIVE_NEXT);
                let visible=layout.rows*layout.columns;let count=t.side_items(side).len();let inventory=&mut t.inventory[side];
                if next&&inventory.offset+visible<count{inventory.offset+=visible;}
                else if !next&&inventory.offset>0{inventory.offset=inventory.offset.saturating_sub(visible);}
                else if t.screen==TradeScreen::Compose&&!t.composer.reviewing{
                    if next{if let Some(cursor)=inventory.next.clone(){task=trade_inventory_task(t,side,Some(cursor),false);}}
                    else if let Some(cursor)=inventory.previous.last().cloned(){task=trade_inventory_task(t,side,cursor,false);}
                }
                t.focused_item=None;
            }
            TRADE_PREVIOUS|TRADE_NEXT=>{
                let finding=t.screen==TradeScreen::FindPlayer;let top=layout.main.top+if finding{106}else{62};
                let rows=((layout.main.bottom-top-62)/68).clamp(1,8) as usize;let count=if finding{t.players.len()}else{t.offers.len()};
                if id==TRADE_NEXT&&t.list_offset+rows<count{t.list_offset+=rows;}
                else if id==TRADE_PREVIOUS&&t.list_offset>0{t.list_offset=t.list_offset.saturating_sub(rows);}
                else if !finding{
                    let before=if id==TRADE_NEXT{t.offer_next.clone().map(Some)}else{t.offer_previous.last().cloned()};
                    if let Some(before)=before{t.list_offset=0;task=Some(TradeTask::Offers{folder:t.folder.clone(),before});}
                }
            }
            id if (TRADE_ROW_BASE..TRADE_ROW_BASE+8).contains(&id)=>{
                let index=t.list_offset+(id-TRADE_ROW_BASE) as usize;
                if t.screen==TradeScreen::FindPlayer{
                    if let Some(partner)=t.players.get(index).cloned(){
                        if partner.player_id==t.me(){t.error=Some("Choose another B2G player.".into());}
                        else{t.composer=Composer{partner:Some(partner.clone()),..Default::default()};t.navigate(TradeScreen::Compose);
                            t.notice="Select up to 50 items per player. Right-click an item to inspect its full details.".into();
                            task=Some(TradeTask::Compose{me:t.me().into(),partner:partner.player_id});}
                    }
                }else if let Some(offer)=t.offers.get(index).cloned(){
                    let id=offer.id.clone();t.offer=Some(offer);t.history=None;t.navigate(TradeScreen::Offer);
                    for side in &mut t.inventory{side.offset=0;}task=Some(TradeTask::Open(id));
                }
            }
            id if (TRADE_ITEM_BASE..TRADE_ITEM_BASE+24).contains(&id)=>{
                if let Some(item)=trade_item_for_control(t,id).cloned(){
                    t.focused_item=Some(item.clone());
                    if t.screen==TradeScreen::Compose&&!t.composer.reviewing{
                        if let Err(error)=t.composer.select(&item){t.error=Some(error);}
                    }else{inspect=Some(item);}
                }
            }
            _=>{}
        }
    }
    if let Some(value)=copy{
        let copied=trade_clipboard(hwnd,&value);
        if let Ok(mut s)=state().lock(){s.trading.notice=if copied{"Trade code copied. Share it with your trading partner."}else{"The clipboard is busy. Try copying your code again."}.into();}
    }
    if let Some(item)=inspect{show_text_details(hwnd,"B2G · Item details",&item.details());}
    if let Some(receipt)=receipt{show_text_details(hwnd,"B2G · Trade history",&receipt);}
    if let Some(message)=message{show_text_details(hwnd,"B2G · Offer message",&message);}
    sync_controls(hwnd);unsafe{InvalidateRect(hwnd,ptr::null(),0);}
    if let Some(task)=task{trade_task(hwnd,task);}
}

fn trade_history_text(page:&EventPage,offer:Option<&Offer>)->String {
    let mut text=String::new();
    for event in &page.events {
        text.push_str(&format!("{} · {} · Revision {}\nOffer {}\n",event.created_at,event.kind.to_uppercase(),event.revision,event.offer_id));
        if let Some(actor)=&event.actor_id{
            let name=offer.and_then(|offer|offer.participants.iter().find(|p|p.player_id==*actor))
                .map(|p|format!("{} · {}",p.display_name,p.trade_code)).unwrap_or_else(||actor.clone());
            text.push_str(&format!("Player: {name}\n"));
        }
        if let Some(items)=event.detail.get("items").and_then(Value::as_array){
            for item in items.iter().take(100){
                let before=&item["before"];
                let name=before["displayName"].as_str().unwrap_or("B2G item");
                text.push_str(&format!("{name} · Item {}\n",before["assetId"].as_str().unwrap_or("")));
                if let Some(count)=before["statTrakCount"].as_u64(){text.push_str(&format!("StatTrak: {count} kills before trade → 0 for the new owner\n"));}
            }
        }
        if let Some(reason)=event.detail.get("reason").and_then(Value::as_str){text.push_str(reason);text.push('\n');}
        text.push_str(&format!("Receipt {}\n\n",event.id));
    }
    text
}
fn trade_scroll(hwnd:HWND,wparam:WPARAM,lparam:LPARAM){
    let client=logical_client(hwnd);let l=trade_layout(client.right,client.bottom);
    let mut point=windows_sys::Win32::Foundation::POINT{x:(lparam as u32&0xffff) as i16 as i32,y:((lparam as u32>>16)&0xffff) as i16 as i32};
    unsafe{ScreenToClient(hwnd,&mut point);}
    let dpi=unsafe{GetDpiForWindow(hwnd)}.max(96) as i32;point.x=point.x*96/dpi;
    let down=(((wparam>>16)&0xffff) as i16)<0;
    if let Ok(mut s)=state().lock(){
        let t=&mut s.trading;if t.busy{return;}
        if matches!(t.screen,TradeScreen::Compose|TradeScreen::Offer){
            let side=usize::from(point.x>l.side[0].right);let count=t.side_items(side).len();let shown=l.rows*l.columns;
            let offset=&mut t.inventory[side].offset;
            *offset=if down{(*offset+2).min(count.saturating_sub(shown))}else{offset.saturating_sub(2)};
            t.focused_item=None;
        }else{
            let count=if t.screen==TradeScreen::FindPlayer{t.players.len()}else{t.offers.len()};
            t.list_offset=if down{(t.list_offset+3).min(count.saturating_sub(1))}else{t.list_offset.saturating_sub(3)};
        }
    }
    sync_trade_controls(hwnd);unsafe{InvalidateRect(hwnd,ptr::null(),0);}
}

#[cfg(test)]
mod trading_state_tests {
    use super::*;
    use crate::trading::tests::{item,composer,ME,THEM};

    pub(super) fn fixture()->TradingState {
        let composer=composer();
        let mut me=composer.partner.clone().unwrap();me.player_id=ME.into();me.display_name="Local fixture".into();
        TradingState {overview:Some(Overview{enabled:true,player:me,incoming_count:1,unread_count:1,latest_event_id:"10".into()}),
            screen:TradeScreen::Compose,composer,inventory:[TradeInventory{items:(0..48).map(|id|item(ME,8000000000000000000+id)).collect(),..Default::default()},
                TradeInventory{items:(0..48).map(|id|item(THEM,8000000000000000100+id)).collect(),..Default::default()}],..Default::default()}
    }
    pub(super) fn offer(t:&TradingState)->Offer {
        Offer {id:THEM.into(),revision:1,status:"pending".into(),status_reason:None,sender_id:THEM.into(),
            participants:vec![t.overview.as_ref().unwrap().player.clone(),t.composer.partner.clone().unwrap()],message:"Fixture trade".into(),
            item_count:None,items:vec![item(ME,8000000000000000001),item(THEM,8000000000000000101)],changed_asset_ids:vec![],
            created_at:"2026-09-07T00:00:00Z".into(),updated_at:"2026-09-07T00:00:00Z".into(),expires_at:"2026-09-14T00:00:00Z".into(),completed_at:None}
    }
    #[test]
    fn trade_controls_fit_each_supported_window_and_do_not_overlap(){
        for (width,height) in [(1024,664),(1280,780),(1360,800)]{
            for screen in [TradeScreen::Offers,TradeScreen::FindPlayer,TradeScreen::Compose,TradeScreen::Offer]{
                for reviewing in [false,true]{
                    let mut t=fixture();t.screen=screen.clone();t.composer.reviewing=reviewing;t.offer=Some(offer(&t));
                    t.players=vec![t.composer.partner.clone().unwrap()];t.offers=vec![offer(&t)];
                    t.composer.select(&item(ME,8000000000000000001)).unwrap();t.composer.reviewing=reviewing;
                    let controls=trade_controls(width,height,&t);
                    for control in &controls{
                        let r=control.rect;
                        assert!(r.left>=16&&r.right<=width-16&&r.top>=73&&r.bottom<=height-97,"control {} outside {width}x{height}: {r:?}",control.id);
                    }
                    for (index,a) in controls.iter().enumerate(){for b in &controls[index+1..]{
                        let (a_rect,b_rect)=(a.rect,b.rect);
                        assert!(a_rect.right<=b_rect.left||b_rect.right<=a_rect.left||a_rect.bottom<=b_rect.top||b_rect.bottom<=a_rect.top,
                            "controls {} and {} overlap in {screen:?}, review={reviewing}, {width}x{height}",a.id,b.id);
                    }}
                }
            }
        }
    }
    #[test]
    fn changing_offer_revision_revokes_gift_confirmation_and_stale_views_cannot_replace_it(){
        let mut t=fixture();t.screen=TradeScreen::Offer;t.offer=Some(offer(&t));t.gift_confirmed=true;t.busy=true;
        let mut changed=t.offer.clone().unwrap();changed.revision=2;
        t.apply(TradeResult{window:0,view:t.view,mutation:false,data:Ok(TradeData::Offer(changed.clone(),EventPage{events:vec![],next_cursor:"0".into()}))});
        assert!(!t.gift_confirmed);assert_eq!(t.offer.as_ref().unwrap().revision,2);
        let previous_view=t.view;t.navigate(TradeScreen::FindPlayer);
        t.apply(TradeResult{window:0,view:previous_view,mutation:false,data:Ok(TradeData::Offer(changed,EventPage{events:vec![],next_cursor:"0".into()}))});
        assert_eq!(t.screen,TradeScreen::FindPlayer);
    }
    #[test]
    fn pending_mutation_survives_transport_failures_and_unrelated_read_errors(){
        let mut t=fixture();let pending=PendingMutation::new(ME.into(),Mutation::Respond{offer_id:THEM.into(),revision:1,response:"accept".into(),confirm_gift:false}).unwrap();
        t.pending=Some(pending.clone());
        t.apply(TradeResult{window:0,view:t.view,mutation:true,data:Err(ApiError{message:"Response lost".into(),status:None,code:None})});
        assert_eq!(t.pending,Some(pending.clone()));assert!(!t.enabled());
        t.apply(TradeResult{window:0,view:t.view,mutation:false,data:Err(ApiError{message:"Offer unavailable".into(),status:Some(404),code:None})});
        assert_eq!(t.pending,Some(pending));
        t.apply(TradeResult{window:0,view:t.view,mutation:true,data:Err(ApiError{message:"Offer changed".into(),status:Some(409),code:Some("stale_revision".into())})});
        assert!(t.pending.is_none());assert!(!t.composer.reviewing);
    }
    #[test]
    fn trading_tab_state_does_not_change_the_running_game(){
        let mut state=render_tests::fixture();state.begin_play();state.apply_event(UiEvent::GameReady);
        state.tab=LauncherTab::Trading;let t=fixture();
        state.apply_event(UiEvent::Trading(TradeResult{window:0,view:0,mutation:false,data:Ok(TradeData::Overview(t.overview.unwrap(),None))}));
        assert!(state.playing&&state.game_ready);assert_eq!(state.primary_label(),"GAME RUNNING");
        state.tab=LauncherTab::Play;assert!(state.playing&&state.game_ready);
    }
    #[test]
    fn a_closed_windows_worker_cannot_unlock_or_change_a_new_window(){
        let mut t=fixture();t.window=2;t.busy=true;
        t.apply(TradeResult{window:1,view:t.view,mutation:false,data:Err(ApiError::from("Late response".to_string()))});
        assert!(t.busy);assert!(t.error.is_none());
    }
    #[test]
    fn an_inbox_summary_cannot_be_accepted_without_loading_exact_items(){
        let t=fixture();let mut offer=offer(&t);offer.item_count=Some(100);offer.items.clear();
        assert_eq!(offer.total_items(),100);assert!(!offer.fully_loaded());assert!(!offer.can_accept(ME));
    }
    #[test]
    fn inventory_refresh_revokes_changed_terms_but_preserves_new_kill_counts(){
        let mut t=fixture();let mut selected=t.inventory[0].items[0].clone();t.composer.select(&selected).unwrap();
        t.composer.reviewing=true;t.composer.gift_confirmed=true;selected.stat_trak_count=Some(100);
        t.reconcile_selection(&[selected.clone()]);assert!(t.composer.reviewing);
        assert_eq!(t.composer.selected[&selected.asset_id].stat_trak_count,Some(100));
        selected.custom_name=Some("Changed name".into());selected.fingerprint="b".repeat(64);
        t.reconcile_selection(&[selected]);assert!(!t.composer.reviewing&&!t.composer.gift_confirmed);
        assert!(t.composer.selected.is_empty());
    }
    #[test]
    fn failed_notification_acknowledgement_can_be_retried(){
        let mut state=render_tests::fixture();state.trading=fixture();state.tab=LauncherTab::Trading;
        state.trading.screen=TradeScreen::Offers;
        let page=||OfferPage{offers:vec![],next_cursor:None};let overview=state.trading.overview.clone().unwrap();
        state.apply_event(UiEvent::Trading(TradeResult{window:0,view:0,mutation:false,data:Ok(TradeData::Offers(overview.clone(),None,page(),None))}));
        assert!(matches!(state.trading.deferred.take(),Some(TradeTask::Seen(_))));
        state.apply_event(UiEvent::Trading(TradeResult{window:0,view:0,mutation:false,data:Err(ApiError::from("Offline".to_string()))}));
        state.apply_event(UiEvent::Trading(TradeResult{window:0,view:0,mutation:false,data:Ok(TradeData::Offers(overview,None,page(),None))}));
        assert!(matches!(state.trading.deferred,Some(TradeTask::Seen(_))));
        state.trading.deferred=None;
        state.apply_event(UiEvent::Trading(TradeResult{window:0,view:0,mutation:false,data:Ok(TradeData::Seen("10".into()))}));
        assert_eq!(state.trading.last_seen_requested,"10");assert_eq!(state.trading.overview.unwrap().unread_count,0);
    }
}
