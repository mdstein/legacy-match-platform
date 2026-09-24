use super::*;
use crate::trading::tests::{ME,THEM};
use std::sync::Arc;

pub(super) fn fixture()->UiState {
    let mut state=render_tests::fixture();state.tab=LauncherTab::Trading;state.trading=trading_state_tests::fixture();
    state.trading.notice="Select up to 50 items per player. Right-click an item to inspect its full details.".into();
    let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let images:Value=serde_json::from_slice(&std::fs::read(root.join("packages/db/src/trading-item-images.json")).unwrap()).unwrap();
    let catalog=[
        (9,344,"AWP | Dragon Lore",6,0.027,"cosmetic"),
        (7,282,"StatTrak™ AK-47 | Redline",5,0.162,"cosmetic"),
        (60,326,"M4A1-S | Knight",5,0.031,"cosmetic"),
        (4,623,"Glock-18 | Ironwork",3,0.024,"cosmetic"),
        (500,38,"★ Bayonet | Fade",6,0.016,"cosmetic"),
        (4001,0,"CS:GO Weapon Case",0,0.0,"case"),
        (4235,0,"Collectible Pins Capsule Series 1",0,0.0,"case"),
        (4027,0,"ESL One Cologne 2014 Cobblestone Souvenir Package",0,0.0,"case"),
    ];
    let mut decoded=vec![];
    for (definition,paint,_,_,_,_) in catalog {
        let path=images[format!("{definition}:{paint}")].as_str().expect("Real catalog image");
        let bytes=std::fs::read(root.join("apps/web/public").join(path.trim_start_matches('/'))).unwrap();
        decoded.push((path.to_string(),crate::trading::art::decode(path,&bytes).unwrap()));
    }
    state.trading.thumbnails=Some(Arc::new(crate::trading::art::Loader::fixture(decoded)));
    for side in 0..2 {
        for (index,item) in state.trading.inventory[side].items.iter_mut().enumerate() {
            let (definition,paint,name,rarity,wear,kind)=catalog[(index+side*4)%catalog.len()];
            item.definition_index=definition;item.paint_index=(paint>0).then_some(paint);
            item.paint_wear=(paint>0).then_some(wear);item.display_name=name.into();item.rarity=rarity;
            item.item_kind=kind.into();item.stat_trak=definition==7;item.stat_trak_count=item.stat_trak.then_some(1234);
            item.custom_name=None;item.image_url=images[format!("{definition}:{paint}")].as_str().map(str::to_string);
        }
    }
    state
}

fn offer(state:&UiState)->Offer {
    let mut offer=trading_state_tests::offer(&state.trading);
    offer.items=vec![state.trading.inventory[0].items[0].clone(),state.trading.inventory[0].items[1].clone(),
        state.trading.inventory[1].items[0].clone(),state.trading.inventory[1].items[1].clone()];
    offer.message="Would you trade the Dragon Lore and Redline for my Bayonet and this case? The Redline counter resets for its next owner.".into();
    offer
}

#[test]
fn render_trading_states_offscreen() {
    load_fonts();let compose=fixture();let mut review=compose.clone();
    for item in offer(&compose).items {review.trading.composer.select(&item).unwrap();}
    review.trading.composer.message="Thanks for the trade. Please check the wear and pattern before accepting.".into();
    review.trading.begin_review();
    let mut incoming=compose.clone();incoming.trading.offer=Some(offer(&compose));incoming.trading.navigate(TradeScreen::Offer);
    incoming.trading.history=Some(EventPage{events:vec![],next_cursor:"0".into()});
    let mut cases=vec![];
    for (width,height) in [(1024,664),(1280,780),(1360,800)] {
        for dpi in [96,120,144,192] {
            for (name,state) in [("compose",&compose),("review",&review),("incoming",&incoming)] {
                cases.push((format!("trade-{name}-{width}-{dpi}"),width,height,dpi,state.clone()));
            }
        }
    }
    let mut inbox=compose.clone();inbox.trading.navigate(TradeScreen::Offers);inbox.trading.offers=vec![offer(&compose)];
    let mut empty=inbox.clone();empty.trading.offers.clear();
    let mut offline=incoming.clone();offline.trading.error=Some("Trading could not reach B2G. Check your connection and retry.".into());
    let mut paused=inbox.clone();paused.trading.overview.as_mut().unwrap().enabled=false;
    let mut gift=review.clone();gift.trading.composer.selected.retain(|_,item|item.owner_id==ME);gift.trading.composer.message.clear();
    let mut recover=incoming.clone();recover.trading.pending=Some(PendingMutation::new(ME.into(),Mutation::Respond{offer_id:THEM.into(),revision:1,response:"accept".into(),confirm_gift:false}).unwrap());
    let mut completed=incoming.clone();completed.trading.offer.as_mut().unwrap().status="accepted".into();completed.trading.navigate(TradeScreen::Offer);
    let mut changed=incoming.clone();changed.trading.offer.as_mut().unwrap().changed_asset_ids=vec![changed.trading.offer.as_ref().unwrap().items[0].asset_id.clone()];
    let mut finding=compose.clone();finding.trading.navigate(TradeScreen::FindPlayer);finding.trading.query="Trade".into();finding.trading.players=vec![finding.trading.composer.partner.clone().unwrap()];
    let mut loading=compose.clone();loading.trading.busy=true;
    let mut bound=compose.clone();bound.trading.inventory[0].items[0].tradable=false;bound.trading.inventory[0].items[0].restriction=Some("Account-bound fixture".into());
    for (name,state) in [("inbox",inbox),("empty",empty),("offline",offline),("paused",paused),("gift",gift),
        ("recover",recover),("completed",completed),("changed",changed),("find",finding),("loading",loading),("bound",bound)] {
        cases.push((format!("trade-{name}-1024-96"),1024,664,96,state));
    }
    for (name,width,height,dpi,state) in cases {
        let surface=Surface::new(width*dpi/96,height*dpi/96).unwrap();scale_dc(surface.dc,dpi as u32);
        paint_surface(surface.dc,width,height,&state);
        // Offscreen renders include edit content, which production paints in
        // real EDIT HWNDs. Geometry and fonts are shared with those controls.
        for control in trade_controls(width,height,&state.trading).into_iter().filter(|control|control.edit) {
            let mut p=PaintObjects::new();fill(surface.dc,&mut p,control.rect,INSET);
            let value=match control.id {TRADE_QUERY=>state.trading.query.as_str(),TRADE_MESSAGE=>state.trading.composer.message.as_str(),
                TRADE_GIVE_QUERY=>state.trading.inventory[0].query.as_str(),_=>state.trading.inventory[1].query.as_str()};
            text_row(surface.dc,&mut p,if value.is_empty(){&control.label}else{value},control.rect.inset(6),15,400,false,
                if value.is_empty(){MUTED}else{INK},SINGLE|DT_NOPREFIX,0);
        }
        unsafe{GdiFlush();}
        if let Some(directory)=std::env::var_os("B2G_RENDER_TEST_DIR") {
            let directory=std::path::PathBuf::from(directory);std::fs::create_dir_all(&directory).unwrap();
            let bytes=unsafe{std::slice::from_raw_parts(surface.bits,(surface.width*surface.height*4) as usize)};
            let mut output=vec![];output.extend_from_slice(&(surface.width as u32).to_le_bytes());output.extend_from_slice(&(surface.height as u32).to_le_bytes());output.extend_from_slice(bytes);
            std::fs::write(directory.join(format!("{name}.bgra")),output).unwrap();
        }
    }
}

#[test]
fn review_consequences_and_details_labels_fit_at_every_scale(){
    load_fonts();let mut state=fixture();state.trading.offer=Some(offer(&state));state.trading.navigate(TradeScreen::Offer);
    assert!(state.trading.counter_reset_notice());assert!(state.trading.notice.starts_with("Review both sides"));
    state.trading.offer.as_mut().unwrap().status="accepted".into();state.trading.navigate(TradeScreen::Offer);
    assert!(state.trading.notice.starts_with("Trade completed"));assert!(!state.trading.counter_reset_notice());
    state.trading.navigate(TradeScreen::Offers);assert!(state.trading.notice.starts_with("Offers stay"));
    state.trading.navigate(TradeScreen::Compose);assert!(state.trading.notice.starts_with("Select up to"));
    let item=state.trading.inventory[0].items[1].clone();state.trading.composer.select(&item).unwrap();
    assert!(!state.trading.counter_reset_notice());state.trading.begin_review();assert!(state.trading.counter_reset_notice());
    assert!(state.trading.notice.starts_with("Review both sides. Sending"));
    for (width,height) in [(1024,664),(1280,780),(1360,800)] {for dpi in [96,120,144,192] {
        let surface=Surface::new(width*dpi/96,height*dpi/96).unwrap();scale_dc(surface.dc,dpi as u32);
        let mut p=PaintObjects::new();let layout=trade_layout(width,height);
        assert!(text_height(surface.dc,&mut p,"ITEM DETAILS",104,13,600)<=20,"Details label clips at {width}/{dpi}");
        for text in ["Revision 1 · Expires 2026-09-14 · StatTrak resets to 0 for the new owner.",
            "StatTrak resets to 0 for the new owner. Original counts stay in history."] {
            assert!(text_height(surface.dc,&mut p,text,layout.main.width(),14,400)<=20,"Reset notice clips at {width}/{dpi}");
        }
    }}
}

#[derive(Default)]
struct RemoteFixture { offer:Option<Offer>,requests:Vec<crate::trading::test_support::Request>,lose_accept:bool,settlements:usize }

fn remote_server(base:&UiState,remote:Arc<Mutex<RemoteFixture>>)->crate::trading::test_support::Server {
    use crate::trading::test_support::{Server,Response};
    let overview=base.trading.overview.clone().unwrap();
    let inventory=base.trading.inventory.clone();let partner=base.trading.composer.partner.clone().unwrap();
    let template=offer(base);
    Server::new(move |request| {
        assert_eq!(request.bearer,"Bearer native-fixture");
        let route=request.path.strip_prefix("/api/launcher/v1/trading").unwrap().split('?').next().unwrap().to_string();
        let mut state=remote.lock().unwrap();state.requests.push(request.clone());
        let body=match (request.method.as_str(),route.as_str()) {
            ("GET","/overview")=>serde_json::to_value(&overview).unwrap(),
            ("GET","/players")=>serde_json::json!([partner]),
            ("GET","/offers")=>serde_json::json!({"offers":state.offer.iter().collect::<Vec<_>>(),"nextCursor":null}),
            ("GET","/events")=>serde_json::json!({"events":state.offer.iter().filter(|o|o.status=="accepted").map(|o|serde_json::json!({
                "id":"11","offerId":o.id,"revision":o.revision,"actorId":ME,"kind":"accepted","createdAt":"2026-09-07T00:00:00Z",
                "detail":{"items":o.items.iter().map(|item|serde_json::json!({"before":item})).collect::<Vec<_>>()}
            })).collect::<Vec<_>>(),"nextCursor":"11"}),
            ("POST","/seen")=>serde_json::json!({"ok":true}),
            ("GET",path) if path.starts_with("/inventory/")=> {
                let side=usize::from(path.ends_with(THEM));
                serde_json::json!({"items":inventory[side].items,"nextCursor":null})
            }
            ("GET",path) if path.starts_with("/offers/")=>serde_json::to_value(state.offer.as_ref().unwrap()).unwrap(),
            ("POST",path) if path=="/offers"||path.ends_with("/counter")=> {
                let terms:crate::trading::Terms=serde_json::from_value(request.body["terms"].clone()).unwrap();
                let mut offer=state.offer.clone().unwrap_or_else(||template.clone());
                if path.ends_with("/counter") {assert_eq!(request.body["revision"],offer.revision);offer.revision+=1;}
                offer.sender_id=ME.into();offer.message=terms.message;offer.status="pending".into();
                offer.items=inventory.iter().flat_map(|i|i.items.iter()).filter(|item|
                    terms.give_asset_ids.contains(&item.asset_id)||terms.receive_asset_ids.contains(&item.asset_id)).cloned().collect();
                assert_eq!(offer.items.len(),terms.give_asset_ids.len()+terms.receive_asset_ids.len());
                for item in &offer.items {assert_eq!(terms.item_fingerprints[&item.asset_id],item.fingerprint);}
                if offer.is_gift(){assert!(terms.confirm_gift);}
                state.offer=Some(offer.clone());serde_json::to_value(offer).unwrap()
            }
            ("POST",path) if path.ends_with("/accept")=> {
                let offer=state.offer.as_mut().unwrap();assert_eq!(request.body["revision"],offer.revision);
                if offer.is_gift(){assert_eq!(request.body["confirmGift"],true);}
                let first=offer.status!="accepted";offer.status="accepted".into();
                offer.completed_at=Some("2026-09-07T00:00:00Z".into());let body=serde_json::to_value(offer).unwrap();
                if first {state.settlements+=1;}
                if state.lose_accept {state.lose_accept=false;return Response{drop_response:true,..Response::okay(body)};}
                body
            }
            _=>panic!("Unexpected native fixture request: {request:?}"),
        };
        Response{delay:std::time::Duration::from_millis(15),..Response::okay(body)}
    })
}

unsafe extern "system" fn native_proc(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM)->LRESULT {
    if message==WM_CREATE {create_controls(hwnd);create_trade_controls(hwnd);sync_controls(hwnd);return 0;}
    if message==WM_COMMAND&&(wparam&0xffff)>=2000&&(wparam>>16)==0 {eprintln!("NATIVE_TRADE_COMMAND={}",wparam&0xffff);}
    unsafe{window_proc(hwnd,message,wparam,lparam)}
}
fn pump(){unsafe {
    let mut message:MSG=std::mem::zeroed();
    while PeekMessageW(&mut message,ptr::null_mut(),0,0,PM_REMOVE)!=0 {
        TranslateMessage(&message);DispatchMessageW(&message);
    }
}}
fn settled(){
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(5);
    loop {pump();if state().lock().is_ok_and(|s|!s.trading.busy&&s.trading.deferred.is_none()){break;}
        assert!(std::time::Instant::now()<deadline,"Native trading worker did not complete");
        thread::sleep(std::time::Duration::from_millis(5));
    }
}
fn click(hwnd:HWND,id:i32){unsafe {
    // BM_CLICK is undefined for an inactive dialog/window. Activate only this
    // offscreen fixture on its own thread; never change foreground ownership.
    windows_sys::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow(hwnd);
    let control=GetDlgItem(hwnd,id);assert!(!control.is_null());assert_ne!(IsWindowVisible(control),0,"Hidden control {id}");
    assert_ne!(IsWindowEnabled(control),0,"Disabled control {id}");SendMessageW(control,BM_CLICK,0,0);
}pump();}
fn capture(hwnd:HWND,name:&str){
    if let Some(directory)=std::env::var_os("B2G_RENDER_TEST_DIR") {unsafe {
        UpdateWindow(hwnd);let mut client:RECT=std::mem::zeroed();GetClientRect(hwnd,&mut client);
        let surface=Surface::new(client.right,client.bottom).unwrap();
        assert_ne!(windows_sys::Win32::Storage::Xps::PrintWindow(hwnd,surface.dc,0),0);GdiFlush();
        let bytes=std::slice::from_raw_parts(surface.bits,(surface.width*surface.height*4) as usize);
        let mut output=vec![];output.extend_from_slice(&(surface.width as u32).to_le_bytes());output.extend_from_slice(&(surface.height as u32).to_le_bytes());output.extend_from_slice(bytes);
        let directory=std::path::PathBuf::from(directory);std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(format!("native-trade-{name}.bgra")),output).unwrap();
    }}
}

// A separate process bounds Win32 reentrancy failures and isolates test-only
// credentials, loopback workers and fixture state from every other test.
#[test]
fn native_trading_journey_is_responsive_and_recovers_lost_acceptance(){
    let _serial=NATIVE_TEST_LOCK.lock().unwrap_or_else(|error|error.into_inner());
    use std::os::windows::process::CommandExt;
    use std::process::{Command,Stdio};use std::time::{Instant,Duration};
    let mut child=Command::new(std::env::current_exe().unwrap())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .args(["--exact","launcher_ui::windows::trading_tests::native_trading_child","--ignored","--nocapture"])
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let deadline=Instant::now()+Duration::from_secs(25);let mut timed_out=false;
    while child.try_wait().unwrap().is_none(){if Instant::now()>deadline{child.kill().unwrap();timed_out=true;break;}
        thread::sleep(Duration::from_millis(30));}
    let output=child.wait_with_output().unwrap();
    assert!(!timed_out&&output.status.success(),"Native trading failure (timeout={timed_out}):\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
    eprintln!("{}",String::from_utf8_lossy(&output.stderr));
}

#[test]
#[ignore="only run inside the native-trading watchdog"]
fn native_trading_child(){
    use crate::trading::test_support::set_connection;
    use std::time::Instant;
    unsafe{SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);}
    load_fonts();let baseline=fixture();let remote=Arc::new(Mutex::new(RemoteFixture::default()));
    let server=remote_server(&baseline,remote.clone());set_connection(Some(server.connection("native-fixture")));
    let mut initial=baseline.clone();initial.tab=LauncherTab::Play;initial.trading.screen=TradeScreen::Offers;initial.trading.window=77;
    initial.begin_play();initial.apply_event(UiEvent::GameReady);
    *state().lock().unwrap()=initial;events().lock().unwrap().clear();
    let instance=unsafe{GetModuleHandleW(ptr::null())};let class_name=wide("B2GNativeTradingFixture");
    let class=WNDCLASSEXW{cbSize:size_of::<WNDCLASSEXW>() as u32,lpfnWndProc:Some(native_proc),hInstance:instance,lpszClassName:class_name.as_ptr(),..unsafe{std::mem::zeroed()}};
    assert_ne!(unsafe{RegisterClassExW(&class)},0);
    let hwnd=unsafe{CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,class_name.as_ptr(),wide("B2G trading fixture").as_ptr(),
        WS_OVERLAPPEDWINDOW|WS_CLIPCHILDREN,GetSystemMetrics(SM_XVIRTUALSCREEN)-3000,GetSystemMetrics(SM_YVIRTUALSCREEN)-3000,
        1280,780,ptr::null_mut(),ptr::null_mut(),instance,ptr::null())};
    assert!(!hwnd.is_null());unsafe{ShowWindow(hwnd,SW_SHOWNOACTIVATE);UpdateWindow(hwnd);}pump();
    let load=Instant::now();click(hwnd,TRADE_TAB_ID);settled();eprintln!("B2G_TRADE_INITIAL_MS={:.3}",load.elapsed().as_secs_f64()*1000.0);
    click(hwnd,TRADE_NEW);
    unsafe{SetWindowTextW(GetDlgItem(hwnd,TRADE_QUERY),wide("Trade tester").as_ptr());SendMessageW(GetDlgItem(hwnd,TRADE_QUERY),WM_KEYDOWN,13,0);}settled();
    assert_eq!(state().lock().unwrap().trading.players.len(),1);
    click(hwnd,TRADE_ROW_BASE);settled();
    assert_eq!(state().lock().unwrap().trading.inventory[0].items.len(),48);
    capture(hwnd,"compose");
    let interaction=Instant::now();click(hwnd,TRADE_ITEM_BASE);click(hwnd,TRADE_ITEM_BASE+12);
    unsafe{SetWindowTextW(GetDlgItem(hwnd,TRADE_MESSAGE),wide("Native trade note & exact terms").as_ptr());}
    click(hwnd,TRADE_PRIMARY);assert!(state().lock().unwrap().trading.composer.reviewing);
    capture(hwnd,"review");
    eprintln!("B2G_TRADE_SELECT_REVIEW_MS={:.3}",interaction.elapsed().as_secs_f64()*1000.0);
    click(hwnd,TRADE_READ_MESSAGE);
    let details=show_text_details(hwnd,"B2G · Offer message","Native trade note & exact terms");
    assert!(!details.is_null());
    assert_eq!(unsafe{GetWindowTextLengthW(GetDlgItem(details,DETAILS_EDIT))},31);
    unsafe{SendMessageW(details,WM_CLOSE,0,0);}
    click(hwnd,TRADE_PRIMARY);settled();
    {let s=state().lock().unwrap();assert!(remote.lock().unwrap().offer.is_some(),"Send failed: screen={:?}, review={}, selected={}, pending={}, error={:?}",
        s.trading.screen,s.trading.composer.reviewing,s.trading.composer.selected.len(),s.trading.pending.is_some(),s.trading.error);}
    assert_eq!(remote.lock().unwrap().offer.as_ref().unwrap().message,"Native trade note & exact terms");
    assert!(state().lock().unwrap().trading.pending.is_none());
    {let mut r=remote.lock().unwrap();let offer=r.offer.as_mut().unwrap();offer.sender_id=THEM.into();offer.revision=2;offer.message="Counter from fixture partner".into();}
    click(hwnd,REFRESH_ID);settled();
    {let s=state().lock().unwrap();assert_eq!(s.trading.offer.as_ref().unwrap().revision,2,"Refresh did not fetch counter: {:?}",s.trading.error);}
    click(hwnd,TRADE_COUNTER);settled();
    click(hwnd,TRADE_ITEM_BASE); // Remove the only item on our side: an explicit gift request.
    click(hwnd,TRADE_PRIMARY);click(hwnd,TRADE_PRIMARY);
    assert!(state().lock().unwrap().trading.error.as_ref().unwrap().contains("gift"));
    click(hwnd,TRADE_GIFT);click(hwnd,TRADE_PRIMARY);settled();
    assert_eq!(remote.lock().unwrap().offer.as_ref().unwrap().revision,3);
    {let mut r=remote.lock().unwrap();let offer=r.offer.as_mut().unwrap();offer.sender_id=THEM.into();offer.revision=4;
        offer.items=vec![baseline.trading.inventory[1].items[5].clone()];offer.message="A StatTrak gift for the next owner".into();r.lose_accept=true;}
    click(hwnd,REFRESH_ID);settled();
    click(hwnd,TRADE_PRIMARY);assert!(state().lock().unwrap().trading.error.as_ref().unwrap().contains("gift"));
    click(hwnd,TRADE_GIFT);click(hwnd,TRADE_PRIMARY);settled();
    assert!(state().lock().unwrap().trading.pending.is_some());
    capture(hwnd,"recover");
    assert_eq!(remote.lock().unwrap().settlements,1);
    click(hwnd,TRADE_RECOVER);settled();
    assert_eq!(state().lock().unwrap().trading.offer.as_ref().unwrap().status,"accepted");
    assert!(state().lock().unwrap().trading.pending.is_none());
    {let r=remote.lock().unwrap();let accepts=r.requests.iter().filter(|request|request.path.ends_with("/accept")).collect::<Vec<_>>();
        assert_eq!(accepts.len(),2);assert_eq!(accepts[0].body,accepts[1].body);assert_eq!(r.settlements,1);}
    click(hwnd,REFRESH_ID);settled();
    {let s=state().lock().unwrap();assert!(s.trading.history.is_some(),"History refresh failed: {:?}",s.trading.error);}
    click(hwnd,TRADE_RECEIPT);
    let history=state().lock().unwrap().trading.history.as_ref().unwrap().events.clone();
    assert_eq!(history.len(),1);assert_eq!(history[0].detail["items"][0]["before"]["statTrakCount"],1234);
    let details=show_text_details(hwnd,"B2G · Fixture receipt","StatTrak: 1234 → 0 for the new owner");
    assert!(!details.is_null());unsafe{SendMessageW(details,WM_CLOSE,0,0);}
    let switching=Instant::now();click(hwnd,PLAY_TAB_ID);{let state=state().lock().unwrap();assert!(state.playing&&state.game_ready);}
    click(hwnd,TRADE_TAB_ID);settled();eprintln!("B2G_TRADE_SWITCH_ROUNDTRIP_MS={:.3}",switching.elapsed().as_secs_f64()*1000.0);
    // Paint and scroll an overfull fixture to bound work independently of the
    // API's 48-item pages; selected IDs and terms remain outside the controls.
    {let mut s=state().lock().unwrap();let window=s.trading.window;s.trading=baseline.trading.clone();s.trading.window=window;
        for side in 0..2 {let seed=s.trading.inventory[side].items.clone();s.trading.inventory[side].items=(0..512).map(|id|{
            let mut item=seed[id%seed.len()].clone();item.asset_id=(8000000000000010000+side as u64*1000+id as u64).to_string();item}).collect();}}
    sync_controls(hwnd);let scroll=Instant::now();
    for step in 0..20 {state().lock().unwrap().trading.inventory[0].offset=step*2;sync_trade_controls(hwnd);unsafe{UpdateWindow(hwnd);}pump();}
    eprintln!("B2G_TRADE_512_ITEMS_20_SCROLLS_MS={:.3}",scroll.elapsed().as_secs_f64()*1000.0);
    // Every visible Trading control participates in native keyboard traversal.
    unsafe{let start=GetDlgItem(hwnd,TRADE_NEW);let mut next=start;let mut visited=std::collections::HashSet::new();
        loop {visited.insert(next as usize);next=GetNextDlgTabItem(hwnd,next,0);if next==start{break;}assert!(visited.len()<64);}
        assert!(visited.contains(&(GetDlgItem(hwnd,TRADE_ITEM_BASE) as usize)));assert!(visited.contains(&(GetDlgItem(hwnd,TRADE_MESSAGE) as usize)));
        DestroyWindow(hwnd);UnregisterClassW(class_name.as_ptr(),instance);}
    pump();set_connection(None);assert!(state().lock().unwrap().trading.thumbnails.is_none());
    eprintln!("B2G_NATIVE_TRADING_JOURNEY_OK");
}
