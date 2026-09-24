// First run uses the same native controls, fonts and worker/event model as Play.
use windows_sys::Win32::UI::Controls::{BST_CHECKED,BST_UNCHECKED};
const SETUP_TIMER: usize = 4;
const SETUP_SIGNIN: i32 = 4001;
const SETUP_BROWSER: i32 = 4002;
const SETUP_CANCEL: i32 = 4003;
const SETUP_NAME: i32 = 4004;
const SETUP_SAVE: i32 = 4005;
const SETUP_INSTALL: i32 = 4006;
const SETUP_STOP: i32 = 4007;
const SETUP_NAME_LABEL: i32 = 4008;
const SETUP_REGION: i32 = 4010;
const SETUP_REGIONS: [&str;4] = ["NA Central","NA East","NA West","EU Central"];

#[derive(Debug, Clone)]
struct SetupState {
    installation: Option<crate::setup::InstallStatus>,
    checking: bool,
    installing: bool,
    preparing: bool,
    install_error: Option<String>,
    pair_epoch: u64,
    pair_code: Option<String>,
    pair_url: Option<String>,
    cancelled: std::sync::Arc<Mutex<bool>>,
    name: String,
    region: usize,
    saving: bool,
    profile_error: Option<String>,
}
impl Default for SetupState {
    fn default() -> Self { Self { installation:None,checking:false,installing:false,preparing:false,install_error:None,
        pair_epoch:0,pair_code:None,pair_url:None,cancelled:std::sync::Arc::new(Mutex::new(false)),name:String::new(),region:0,saving:false,profile_error:None } }
}
#[derive(Debug)]
enum SetupEvent {
    Preparing {window:u64},
    Installation {window:u64,status:crate::setup::InstallStatus,prepared:Option<Result<String,String>>},
    PairCode {window:u64,epoch:u64,code:String,url:String},
    Paired {window:u64,epoch:u64,result:Result<String,String>},
    Profile {window:u64,result:Result<Value,String>},
}
impl UiState {
    fn install_ready(&self) -> bool { self.setup.installation.as_ref().is_none_or(|s|s.ready) && !self.setup.installing && self.setup.install_error.is_none() }
    fn needs_profile(&self) -> bool { self.snapshot.as_ref().is_some_and(|s|s.onboarding_required) }
    fn install_detail(&self)->&str {
        if self.setup.preparing {"Finishing B2G files. Keep the launcher open for a moment."}
        else if let Some(i)=&self.setup.installation {
            if !i.steam_available {"Install Steam in the window that opened. B2G will continue automatically."}
            else if i.total>0 && i.downloaded<i.total {"Downloading CS:GO in Steam. You can finish your account setup meanwhile."}
            else if i.total>0 && !i.ready {"Steam is verifying and writing the game files. B2G will continue automatically."}
            else {"Confirm the download in Steam. B2G will finish setup automatically."}
        }else{"Opening Steam to install CS:GO…"}
    }
    fn setup_visible(&self) -> bool { self.tab==LauncherTab::Play && (!self.paired || self.pairing || !self.install_ready() || self.needs_profile()) }
    fn apply_setup_event(&mut self,event:SetupEvent) -> bool {
        match event {
            SetupEvent::Preparing {window} if window&0xffff_ffff==self.trading.window&0xffff_ffff=>{self.setup.preparing=true;}
            SetupEvent::Installation {window,status,prepared} if window&0xffff_ffff==self.trading.window&0xffff_ffff => {
                self.setup.checking=false;
                self.setup.preparing=false;
                if let Some(result)=prepared {
                    self.setup.installing=false;
                    match result { Ok(message)=>{self.status=message;self.setup.install_error=None;},Err(error)=>self.setup.install_error=Some(error) }
                }
                self.setup.installation=Some(status);
            }
            SetupEvent::PairCode {window,epoch,code,url} if window==self.trading.window && epoch==self.setup.pair_epoch && self.pairing => {
                self.setup.pair_code=Some(code); self.setup.pair_url=Some(url);
            }
            SetupEvent::Paired {window,epoch,result} if window==self.trading.window && epoch==self.setup.pair_epoch && self.pairing => {
                self.setup.pair_code=None;self.setup.pair_url=None;
                if result.is_ok(){self.trading.window+=1<<32;self.friends=FriendsState::default();self.refreshing=false;}
                return self.apply_event(UiEvent::Paired(result));
            }
            SetupEvent::Profile {window,result} if window==self.trading.window => {
                self.setup.saving=false;
                match result {
                    Ok(player)=>{
                        self.trading.window+=1<<32;self.friends=FriendsState::default();self.refreshing=false;
                        if let Some(snapshot)=&mut self.snapshot {
                            snapshot.onboarding_required=false;
                            snapshot.display_name=bounded_text(player.get("displayName"),&snapshot.display_name,48);
                            snapshot.region=bounded_text(player.get("region"),&snapshot.region,32);
                        }
                        self.account.player=Some(player); self.setup.profile_error=None;
                        self.status="Your B2G profile is ready. Press Play to begin.".into(); return true;
                    }
                    Err(error)=>self.setup.profile_error=Some(error),
                }
            }
            _=>{}
        }
        false
    }
}

fn check_setup(hwnd:HWND) {
    let (window,finish,had_steam)={
        let Ok(mut s)=state().lock() else{return;};
        if s.setup.checking || s.playing || (s.setup.installation.as_ref().is_some_and(|i|i.ready)&&!s.setup.installing) {return;}
        s.setup.checking=true;
        (s.trading.window,s.setup.installing,s.setup.installation.as_ref().is_some_and(|i|i.steam_available))
    };
    let handle=hwnd as usize;
    thread::spawn(move||{
        let mut status=crate::setup::status();
        let prepared=if finish&&!had_steam&&status.steam_available&&!status.ready {
            crate::setup::begin_install().err().map(Err)
        }else if status.ready&&finish {
            post_event(handle as HWND,UiEvent::Setup(SetupEvent::Preparing{window}));
            let result=crate::repair_game(false);
            if result.is_err(){status.ready=false;}
            Some(result)
        }else{None};
        post_event(handle as HWND,UiEvent::Setup(SetupEvent::Installation{window,status,prepared}));
    });
}
fn setup_primary(hwnd:HWND) {
    let (ready,profile,paired,busy)=state().lock().map(|s|(s.install_ready(),s.needs_profile(),s.paired,s.setup.installing||s.setup.saving)).unwrap_or((false,false,false,true));
    if busy{return;}
    if !ready {setup_command(hwnd,SETUP_INSTALL);} else if profile {select_tab(hwnd,PLAY_TAB_ID);setup_command(hwnd,SETUP_SAVE);} else if paired {play(hwnd);} else {pair(hwnd);}
}
fn setup_command(hwnd:HWND,id:i32) {
    match id {
        SETUP_STOP=>{if let Ok(mut s)=state().lock(){s.setup.installing=false;s.status="Setup paused. Steam keeps any downloaded files; choose Install to continue.".into();}}
        SETUP_SIGNIN=>pair(hwnd),
        SETUP_BROWSER=>{let url=state().lock().ok().and_then(|s|s.setup.pair_url.clone());if let Some(url)=url{open_url(&url);}},
        SETUP_CANCEL=>{
            if let Ok(mut s)=state().lock(){
                if let Ok(mut cancelled)=s.setup.cancelled.lock(){*cancelled=true;}
                s.setup.pair_epoch+=1;s.pairing=false;s.setup.pair_code=None;s.setup.pair_url=None;
                s.status="Sign-in cancelled. Connect with Steam when you are ready.".into();
            }
        }
        SETUP_INSTALL=>{
            let can_start=state().lock().is_ok_and(|s|!s.playing);
            if !can_start{return;}
            let result=crate::setup::begin_install();
            if let Ok(mut s)=state().lock(){
                s.tab=LauncherTab::Play;
                match result {
                    Ok(())=>{s.setup.installing=true;s.setup.install_error=None;s.status="Confirm the download in Steam. B2G will finish setup automatically.".into();}
                    Err(error)=>s.setup.install_error=Some(error),
                }
            }
            check_setup(hwnd);
        }
        SETUP_SAVE=>{
            let (window,name,region)={
                let Ok(mut s)=state().lock() else{return;};
                if s.setup.saving||!s.needs_profile(){return;}
                let name=s.setup.name.trim().to_string();
                if !valid_setup_name(&name){
                    s.setup.profile_error=Some("Use 3–20 letters, numbers, underscores or hyphens.".into());
                    drop(s);
                    unsafe{InvalidateRect(hwnd,ptr::null(),0);SetFocus(GetDlgItem(hwnd,SETUP_NAME));}
                    return;
                }
                s.setup.saving=true;s.setup.profile_error=None;
                (s.trading.window,name,SETUP_REGIONS[s.setup.region])
            };
            let handle=hwnd as usize;
            thread::spawn(move||{
                let result=(||{
                    let api=TradingApi::connected().map_err(|e|e.message)?;
                    match api.launcher_request::<Value>("/api/launcher/v1/account/onboarding",Some(&serde_json::json!({"displayName":name,"region":region}))){
                        Ok(player)=>Ok(player),
                        Err(error)=>{
                            // A lost reply can follow a committed profile. Re-read
                            // the current owner before inviting a duplicate retry.
                            if let Ok(player)=api.launcher_request::<Value>("/api/launcher/v1/account",None)
                                && player["onboardingRequired"].as_bool()==Some(false){return Ok(player);}
                            Err(error.message)
                        }
                    }
                })();
                post_event(handle as HWND,UiEvent::Setup(SetupEvent::Profile{window,result}));
            });
        }
        id if (SETUP_REGION..SETUP_REGION+4).contains(&id)=>{if let Ok(mut s)=state().lock(){if !s.setup.saving{s.setup.region=(id-SETUP_REGION) as usize;}}}
        _=>{}
    }
    sync_controls(hwnd);unsafe{InvalidateRect(hwnd,ptr::null(),0);}
}
fn valid_setup_name(value:&str)->bool { (3..=20).contains(&value.len())&&value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-') }
fn setup_edit_changed(hwnd:HWND,id:i32){if id==SETUP_NAME {let text=trade_edit_text(hwnd,id);if let Ok(mut s)=state().lock(){s.setup.name=text;}}}
fn setup_control_ids()->Vec<i32>{vec![SETUP_SIGNIN,SETUP_BROWSER,SETUP_CANCEL,SETUP_INSTALL,SETUP_STOP,SETUP_NAME_LABEL,SETUP_NAME,SETUP_REGION,SETUP_REGION+1,SETUP_REGION+2,SETUP_REGION+3,SETUP_SAVE]}
// The install step's height depends on what it is actually doing, so the
// account step below it follows real content instead of a fixed offset. A busy
// install lands exactly where the captured layout put it; an idle one pulls the
// rest of the column up instead of leaving a dead band.
struct SetupMetrics {
    x: i32,
    w: i32,
    buttons: Option<i32>,
    percent: Option<i32>,
    rule: i32,
    head: i32,
    body: i32,
}
fn setup_metrics(width:i32,s:&UiState)->SetupMetrics {
    let x=if width>=1280{width/2-170}else{width/2-120};
    let w=width-x-48;
    let mut y=232;
    let buttons=s.setup.installing.then(||{y=276;238});
    let percent=s.setup.installation.as_ref().filter(|i|i.total>0&&!i.ready).map(|_|{
        let top=y+4; y=top+26; top
    });
    let rule=y+3;
    let head=rule+18;
    SetupMetrics{x,w,buttons,percent,rule,head,body:head+27}
}

fn setup_controls(width:i32,_height:i32,s:&UiState)->Vec<TradeControl>{
    if !s.setup_visible(){return vec![];}
    let m=setup_metrics(width,s);let (x,w,body)=(m.x,m.w,m.body);
    let mut controls=vec![];
    let mut add=|id,rect,label:&str,enabled,edit|controls.push(TradeControl{id,rect,label:label.into(),enabled,edit});
    if let Some(top)=m.buttons {
        add(SETUP_INSTALL,box_rect(x,top,142,38),"OPEN STEAM",!s.playing,false);
        add(SETUP_STOP,box_rect(x+154,top,142,38),"STOP WAITING",!s.setup.checking&&!s.setup.preparing,false);
    }
    if !s.paired&&!s.pairing {add(SETUP_SIGNIN,box_rect(x,body+56,w.min(300),42),"CONTINUE WITH STEAM",true,false);}
    if s.pairing {
        add(SETUP_BROWSER,box_rect(x,body+91,190,36),"REOPEN STEAM SIGN-IN",s.setup.pair_url.is_some(),false);
        add(SETUP_CANCEL,box_rect(x+202,body+91,100,36),"CANCEL",true,false);
    }
    if s.needs_profile() {
        add(SETUP_NAME_LABEL,box_rect(x,body,w,20),"In-game &name",true,false);
        add(SETUP_NAME,box_rect(x+12,body+26,w-24,28),"In-game name",!s.setup.saving,true);
        for (i,region) in SETUP_REGIONS.iter().enumerate(){add(SETUP_REGION+i as i32,box_rect(x+i as i32*(w/4),body+78,w/4-8,34),region,!s.setup.saving,false);}
        add(SETUP_SAVE,box_rect(x,body+132,220,40),if s.setup.saving{"SAVING…"}else{"CREATE B2G PROFILE"},!s.setup.saving,false);
    }
    controls
}
fn create_setup_controls(hwnd:HWND){
    for id in setup_control_ids(){let edit=id==SETUP_NAME;unsafe{
        let radio=(SETUP_REGION..SETUP_REGION+4).contains(&id);let label=id==SETUP_NAME_LABEL;
        let style=WS_CHILD|if label{0}else{WS_TABSTOP}|if id==SETUP_REGION||id==SETUP_SAVE{WS_GROUP}else{0}|if edit{ES_AUTOHSCROLL as u32}else if label{0}else if radio{BS_AUTORADIOBUTTON as u32}else{BS_OWNERDRAW as u32};
        let child=CreateWindowExW(0,wide(if edit{"EDIT"}else if label{"STATIC"}else{"BUTTON"}).as_ptr(),wide("").as_ptr(),style,0,0,1,1,hwnd,id as usize as HMENU,GetModuleHandleW(ptr::null()),ptr::null());
        if edit{SendMessageW(child,windows_sys::Win32::UI::Controls::EM_SETLIMITTEXT,20,0);}else if !label&&!radio{SetWindowSubclass(child,Some(button_proc),id as usize,0);}
    }}
}
fn sync_setup_controls(hwnd:HWND){
    let client=logical_client(hwnd);let controls=state().lock().map(|s|setup_controls(client.right,client.bottom,&s)).unwrap_or_default();
    let dpi=unsafe{GetDpiForWindow(hwnd)}.max(96) as i32;let mut p=PaintObjects::new();let font=p.typeface(18*dpi/96,400,false);let label_font=p.typeface(14*dpi/96,500,false);
    let region=state().lock().map(|s|s.setup.region).unwrap_or(0);
    for id in setup_control_ids(){unsafe{
        let child=GetDlgItem(hwnd,id);if child.is_null(){continue;}
        let Some(c)=controls.iter().find(|c|c.id==id)else{ShowWindow(child,SW_HIDE);continue;};let r=c.rect;
        MoveWindow(child,r.left*dpi/96,r.top*dpi/96,r.width()*dpi/96,r.height()*dpi/96,0);
        EnableWindow(child,i32::from(c.enabled));SendMessageW(child,WM_SETFONT,if id==SETUP_NAME{font}else{label_font} as usize,0);
        if (SETUP_REGION..SETUP_REGION+4).contains(&id){SendMessageW(child,BM_SETCHECK,if (id-SETUP_REGION) as usize==region{BST_CHECKED}else{BST_UNCHECKED} as usize,0);}
        if !c.edit{SetWindowTextW(child,wide(&c.label).as_ptr());}
        ShowWindow(child,SW_SHOWNOACTIVATE);InvalidateRect(child,ptr::null(),0);
    }}
}
fn paint_setup_button(dc:HDC,r:BoxRect,id:i32,s:&UiState,pressed:bool,focused:bool){
    let Some(c)=setup_controls(1360,800,s).into_iter().find(|c|c.id==id)else{return;};
    let mut p=PaintObjects::new();let selected=(SETUP_REGION..SETUP_REGION+4).contains(&id)&&(id-SETUP_REGION) as usize==s.setup.region;
    if id==SETUP_NAME_LABEL{text_row(dc,&mut p,"In-game name",r,14,500,false,MUTED,SINGLE,0);return;}
    if (SETUP_REGION..SETUP_REGION+4).contains(&id){
        fill(dc,&mut p,r,BG);
        icon(dc,box_rect(r.left+3,r.top+9,16,16),RADIO_ICON,if selected{BLUE}else{MUTED});
        if selected{icon(dc,box_rect(r.left+3,r.top+9,16,16),DOT_ICON,BLUE);}
        text_row(dc,&mut p,&c.label,box_rect(r.left+24,r.top,r.width()-24,r.height()),14,500,false,INK,SINGLE,0);return;
    }
    let primary=matches!(id,SETUP_SIGNIN|SETUP_SAVE|SETUP_INSTALL);let color=if !c.enabled{INSET}else if primary{if pressed{rgb(88,142,210)}else{mix_color(BLUE,rgb(123,180,255),s.hover_amount(id))}}else if selected||pressed{INSET}else{mix_color(PANEL,INSET,s.hover_amount(id))};
    rounded(dc,r,color,if selected{BLUE}else{LINE});
    text_row(dc,&mut p,&c.label,r.inset(6),14,600,false,if primary&&c.enabled{BLUE_INK}else{INK},SINGLE|DT_CENTER,1);
    if focused{unsafe{FrameRect(dc,&r.inset(3).native(),p.brush(if primary{BLUE_INK}else{BLUE}));}}
}
// Setup is a real sequence, so each step says where it stands rather than
// leaving the reader to infer it from the body copy.
fn step_chip(dc:HDC,p:&mut PaintObjects,label:&str,right:i32,top:i32,kind:u8) {
    let (ink,tint,edge)=match kind {
        0=>(GREEN,GREEN_TINT,GREEN_EDGE),
        1=>(BLUE,BLUE_TINT,BLUE_EDGE),
        2=>(ERROR,RED_TINT,RED_EDGE),
        _=>(MUTED,INSET,LINE),
    };
    let width=chip_width(dc,p,label);
    chip(dc,p,label,box_rect(right-width,top,width,18),ink,tint,edge);
}
fn paint_setup(dc:HDC,width:i32,height:i32,s:&UiState){
    let mut p=PaintObjects::new();
    let m=setup_metrics(width,s);let (x,w)=(m.x,m.w);
    let art=box_rect(16,73,x-48,height-186);artwork().hero.draw(dc,art);hero_scrim(dc,art);
    unsafe{FrameRect(dc,&art.native(),p.brush(LINE));}
    text_row(dc,&mut p,"Welcome back\nto Counter-Strike.",box_rect(40,art.bottom-160,art.width()-48,84),32,600,false,INK,DT_WORDBREAK,0);
    text_row(dc,&mut p,"Your matches. Your inventory. Your B2G.",box_rect(40,art.bottom-68,art.width()-48,44),16,400,false,MUTED,DT_WORDBREAK,0);
    text_row(dc,&mut p,"Get ready to play",box_rect(x,88,w,42),32,600,false,INK,SINGLE,0);
    line(dc,&mut p,x,140,w);
    text_row(dc,&mut p,"Install CS:GO",box_rect(x,155,w,30),22,600,false,INK,SINGLE,0);
    step_chip(dc,&mut p,
        if s.setup.install_error.is_some(){"ACTION NEEDED"}
        else if s.setup.installing{"INSTALLING"}
        else if s.setup.installation.is_none(){"CHECKING"}
        else if s.install_ready(){"DONE"} else {"ACTION NEEDED"},
        x+w,161,
        if s.setup.install_error.is_some(){2}
        else if s.setup.installing{1}
        else if s.setup.installation.is_none(){3}
        else if s.install_ready(){0} else {2});
    let status=&s.setup.installation;
    let detail=s.setup.install_error.as_deref().unwrap_or_else(||if s.setup.installing {
        s.install_detail()
    }else{status.as_ref().map(|i|i.detail.as_str()).unwrap_or("Checking this PC for CS:GO…")});
    text_row(dc,&mut p,detail,box_rect(x,192,w,40),15,400,false,if s.setup.install_error.is_some(){ERROR}else if s.install_ready()&&status.is_some(){GREEN}else{MUTED},DT_WORDBREAK,0);
    if let (Some(top),Some(i))=(m.percent,status.as_ref().filter(|i|i.total>0&&!i.ready)) {
        let percent=(i.downloaded.saturating_mul(100)/i.total).min(100);
        text_row(dc,&mut p,&format!("{percent}% downloaded · {:.1} / {:.1} GB",i.downloaded as f64/1e9,i.total as f64/1e9),box_rect(x,top,w,20),12,400,true,MUTED,SINGLE,0);
        let track=top+23;
        fill(dc,&mut p,box_rect(x,track,w,3),INSET);fill(dc,&mut p,box_rect(x,track,w*percent as i32/100,3),BLUE);
    }
    line(dc,&mut p,x,m.rule,w);
    text_row(dc,&mut p,if s.needs_profile(){"Choose your B2G name"}else{"Connect your account"},box_rect(x,m.head,w,32),22,600,false,INK,SINGLE,0);
    step_chip(dc,&mut p,
        if s.setup.profile_error.is_some(){"ACTION NEEDED"}
        else if s.setup.saving{"SAVING"}
        else if s.pairing{"WAITING ON STEAM"}
        else if s.needs_profile(){"YOUR TURN"}
        else if s.paired{"DONE"} else {"NEXT"},
        x+w,m.head+7,
        if s.setup.profile_error.is_some(){2}
        else if s.setup.saving||s.pairing||s.needs_profile(){1}
        else if s.paired{0} else {3});
    let body=m.body;
    if s.needs_profile(){
        fill(dc,&mut p,box_rect(x,body+19,w,42),INSET);
        text_row(dc,&mut p,"3–20 letters, numbers, underscores or hyphens.",box_rect(x,body+58,w,18),12,400,false,MUTED,SINGLE,0);
        if let Some(error)=&s.setup.profile_error{text_row(dc,&mut p,error,box_rect(x,body+177,w,30),14,400,false,ERROR,DT_WORDBREAK,0);}
    }else if s.pairing {
        text_row(dc,&mut p,"Approve this matching code on the Steam sign-in page.",box_rect(x,body+14,w,26),15,400,false,MUTED,SINGLE,0);
        text_row(dc,&mut p,s.setup.pair_code.as_deref().unwrap_or("REQUESTING CODE…"),box_rect(x,body+42,w,40),28,600,true,BLUE,SINGLE,4);
    }else {
        text_row(dc,&mut p,if s.paired{"Your B2G account is connected."}else{"New to B2G? Sign in with Steam, then choose your name here."},box_rect(x,body+16,w,34),15,400,false,if s.paired{GREEN}else{MUTED},DT_WORDBREAK,0);
        if let Some(error)=s.action_error.as_ref().or(s.refresh_error.as_ref()).filter(|e|!s.paired&&!e.contains("not connected")){text_row(dc,&mut p,error,box_rect(x,body+112,w,64),14,400,false,ERROR,DT_WORDBREAK,0);}
    }
    for c in setup_controls(width,height,s){if !c.edit{paint_setup_button(dc,c.rect,c.id,s,false,false);}}
}
fn setup_static_colors(dc:HDC)->LRESULT{
    static BRUSH:OnceLock<usize>=OnceLock::new();unsafe{SetTextColor(dc,INK);SetBkColor(dc,BG);}
    *BRUSH.get_or_init(||unsafe{CreateSolidBrush(BG) as usize}) as LRESULT
}
