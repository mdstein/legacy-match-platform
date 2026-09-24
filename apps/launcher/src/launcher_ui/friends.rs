// Native B2G social surfaces. Reads run off-thread and equal poll responses do
// not repaint, replace edits, or move focus. Request UUIDs survive a lost reply.
const FRIENDS_TAB_ID:i32=1015;
const FRIEND_FOLDER:i32=5000;
const FRIEND_ME:i32=5004;
const FRIEND_QUERY:i32=5005;
const FRIEND_SEARCH:i32=5006;
const FRIEND_BACK:i32=5007;
const FRIEND_RETRY:i32=5008;
const FRIEND_PREV:i32=5010;
const FRIEND_NEXT:i32=5011;
const FRIEND_COMP:i32=5012;
const FRIEND_DM:i32=5013;
const FRIEND_ACTION:i32=5014;
const FRIEND_DECLINE:i32=5015;
const FRIEND_STEAM:i32=5016;
const FRIEND_COPY:i32=5017;
const FRIEND_QUERY_LABEL:i32=5018;
const FRIEND_ROW:i32=5100;

#[derive(Debug,Clone,PartialEq,Eq)]
struct FriendView { folder:String,query:String,offset:usize,target:Option<String>,mode:String,match_offset:usize }
impl Default for FriendView {
    fn default()->Self{Self{folder:"friends".into(),query:String::new(),offset:0,target:None,mode:"competitive".into(),match_offset:0}}
}
#[derive(Debug,Clone)]
struct FriendMutation {target:String,request_id:String,action:String}
#[derive(Debug,Clone,Default)]
struct FriendsState {
    view:FriendView,query:String,page:Option<Value>,profile:Option<Value>,
    incoming:u64,count:u64,epoch:u64,busy:bool,mutating:bool,loaded:bool,
    pending:Option<FriendMutation>,error:Option<String>,notice:String,confirm_remove:bool,
}
#[derive(Debug)]
struct FriendsResult {window:u64,epoch:u64,view:FriendView,quiet:bool,badge:bool,
    mutation:bool,data:Result<(Value,Option<Value>),crate::trading::ApiError>}
impl FriendsState {
    fn apply(&mut self,r:FriendsResult,window:u64)->bool {
        if r.window!=window || r.epoch!=self.epoch{return false;}
        let was_busy=self.busy;
        self.busy=false;self.mutating=false;
        match r.data {
            Err(e)=>{
                if r.mutation && e.status.is_some_and(|s|(400..500).contains(&s)&&s!=408){self.pending=None;}
                let changed=self.error.as_ref()!=Some(&e.message);
                self.error=Some(e.message);
                changed || !r.quiet && was_busy
            }
            Ok((page,profile))=>{
                let incoming=page["incomingCount"].as_u64().unwrap_or(self.incoming);
                let count=page["friendCount"].as_u64().unwrap_or(self.count);
                let mut changed=incoming!=self.incoming||count!=self.count||self.error.is_some();
                self.incoming=incoming;self.count=count;
                if self.pending.is_none() || r.mutation {self.error=None;}
                if r.mutation {
                    self.pending=None;self.confirm_remove=false;
                    self.notice="Friend list updated.".into();
                }
                if !r.badge && self.view==r.view {
                    changed|=self.page.as_ref()!=Some(&page)||self.profile!=profile||!self.loaded;
                    self.page=Some(page);self.profile=profile;self.loaded=true;
                }
                changed || !r.quiet && was_busy
            }
        }
    }
}
fn friends_fetch(api:&TradingApi,view:&FriendView,badge:bool)->Result<(Value,Option<Value>),crate::trading::ApiError>{
    let offset=view.offset.to_string();
    let query=url::form_urlencoded::Serializer::new(String::new()).extend_pairs([
        ("folder",if badge{"friends"}else{view.folder.as_str()}),("q",view.query.as_str()),("offset",if badge{"0"}else{&offset})]).finish();
    // An unsubmitted search has no results; still fetch counts for its sidebar.
    let path=if !badge&&view.folder=="search"&&view.query.chars().count()<2 {
        "/api/launcher/v1/social/friends".to_string()
    } else {format!("/api/launcher/v1/social/friends?{query}")};
    let mut page:Value=api.launcher_request(&path,None)?;
    if !badge&&view.folder=="search"&&view.query.chars().count()<2 {page["entries"]=serde_json::json!([]);page["total"]=serde_json::json!(0);}
    let profile=if let Some(target)=&view.target && !badge {
        Some(api.launcher_request(&format!("/api/launcher/v1/social/players/{target}?mode={}&offset={}",view.mode,view.match_offset),None)?)
    } else {None};
    Ok((page,profile))
}
fn refresh_friends(hwnd:HWND,quiet:bool,badge:bool){friends_work(hwnd,quiet,badge,None);}
fn friends_work(hwnd:HWND,quiet:bool,badge:bool,mutation:Option<FriendMutation>){
    let (window,epoch,view)={
        let Ok(mut s)=state().lock()else{return;};
        if !s.paired||s.friends.mutating||quiet&&(s.friends.busy||s.friends.pending.is_some()){return;}
        let window=s.trading.window;
        let f=&mut s.friends;
        f.epoch+=1;f.busy=true;f.mutating=mutation.is_some();
        if mutation.is_some(){f.pending=mutation.clone();}
        if !quiet {if f.pending.is_none()||mutation.is_some(){f.error=None;}f.notice.clear();}
        (window,f.epoch,f.view.clone())
    };
    let handle=hwnd as usize;
    thread::spawn(move||{
        let result=(||{
            let api=TradingApi::connected()?;
            if let Some(m)=&mutation {
                let (path,body)=if m.action=="add" {("/api/launcher/v1/social/requests".into(),serde_json::json!({"playerId":m.target,"requestId":m.request_id}))}
                else{(format!("/api/launcher/v1/social/requests/{}",m.request_id),serde_json::json!({"action":m.action}))};
                let _:Value=api.launcher_request(&path,Some(&body))?;
            }
            friends_fetch(&api,&view,badge)
        })();
        post_event(handle as HWND,UiEvent::Friends(FriendsResult{window,epoch,view,quiet,badge,mutation:mutation.is_some(),data:result}));
    });
    if !quiet{sync_controls(hwnd);unsafe{InvalidateRect(hwnd,ptr::null(),0);}}
}
fn friends_controls(width:i32,height:i32,s:&UiState)->Vec<AccountControl>{
    if s.tab!=LauncherTab::Friends{return vec![];}
    let f=&s.friends;let x=236;let w=width-x-28;
    let mut list=vec![];
    let mut add=|id,rect,label:String,enabled,selected|list.push(AccountControl{id,rect,label,enabled,selected});
    for(i,(folder,label))in [("friends",format!("Friends   {}",f.count)),("incoming",format!("Requests   {}",f.incoming)),
        ("outgoing","Sent requests".into()),("search","Find a player".into())].into_iter().enumerate(){
        add(FRIEND_FOLDER+i as i32,box_rect(28,132+i as i32*44,180,36),label,!f.mutating,f.view.target.is_none()&&f.view.folder==folder);
    }
    add(FRIEND_ME,box_rect(28,332,180,36),"My profile".into(),s.paired&&!f.mutating,f.view.target.as_deref()==Some("me"));
    if !s.paired{return list;}
    let enabled=!f.mutating;
    if f.view.target.is_some(){
        add(FRIEND_BACK,box_rect(x,82,92,28),"Back to list".into(),enabled,false);
        if let Some(p)=&f.profile {
            let who=&p["player"];let relation=field(who,"relationship");
            let label=match relation {"self"=>"Your profile","friends" if f.confirm_remove=>"Confirm remove","friends"=>"Remove friend","incoming"=>"Accept request","outgoing"=>"Cancel request",_=>"Add friend"};
            add(FRIEND_ACTION,box_rect(width-190,127,162,36),if f.mutating{"Updating…"}else{label}.into(),enabled&&f.pending.is_none()&&relation!="self",false);
            if relation=="incoming"{add(FRIEND_DECLINE,box_rect(width-190,171,162,32),"Decline request".into(),enabled&&f.pending.is_none(),false);}
            if p["player"]["private"]!=true {
                if p["steamProfileUrl"].is_string(){add(FRIEND_STEAM,box_rect(x,219,154,30),"Steam · Linked".into(),true,false);}
                add(FRIEND_COMP,box_rect(x,270,136,32),"Competitive".into(),enabled,f.view.mode=="competitive");
                add(FRIEND_DM,box_rect(x+144,270,136,32),"Deathmatch".into(),enabled,f.view.mode=="deathmatch");
            }
            add(FRIEND_COPY,box_rect(28,380,180,32),"Copy B2G player ID".into(),true,false);
        }
    } else {
        if f.view.folder=="search"{
            add(FRIEND_QUERY_LABEL,box_rect(x,80,w,38),"Find a player".into(),true,false);
            add(FRIEND_QUERY,box_rect(x+12,128,w-148,26),"Player name, B2G ID or trade code".into(),enabled,false);
            add(FRIEND_SEARCH,box_rect(width-140,122,112,36),"Search".into(),enabled&&f.query.trim().chars().count()>=2,false);
        }
        if let Some(entries)=f.page.as_ref().and_then(|p|p["entries"].as_array()){
            for(i,person)in entries.iter().take(8).enumerate(){add(FRIEND_ROW+i as i32,box_rect(x,174+i as i32*40,w,36),
                format!("View {}'s profile",bounded_text(person.get("displayName"),"Player",48)),enabled,false);}
        }
    }
    let (offset,total,limit)=if f.view.target.is_some(){(f.view.match_offset,f.profile.as_ref().and_then(|p|p["matchTotal"].as_u64()).unwrap_or(0)as usize,5)}
        else{(f.view.offset,f.page.as_ref().and_then(|p|p["total"].as_u64()).unwrap_or(0)as usize,8)};
    if offset>0||total>limit {
        add(FRIEND_PREV,box_rect(width-212,if f.view.target.is_some(){82}else{(height-155).min(510)},84,30),"Previous".into(),enabled&&offset>0,false);
        add(FRIEND_NEXT,box_rect(width-120,if f.view.target.is_some(){82}else{(height-155).min(510)},92,30),"Next".into(),enabled&&offset+limit<total,false);
    }
    if f.error.is_some(){add(FRIEND_RETRY,box_rect(28,430,180,32),if f.pending.is_some(){"Retry pending action"}else{"Retry connection"}.into(),!f.busy,false);}
    list
}
fn friends_text(dc:HDC,p:&mut PaintObjects,value:&str,r:BoxRect,size:i32,color:COLORREF){
    text_row(dc,p,value,r,size,500,false,color,SINGLE,0);
}
fn paint_friends(dc:HDC,width:i32,height:i32,s:&UiState){
    let mut p=PaintObjects::new();let f=&s.friends;let x=236;let w=width-x-28;
    friends_text(dc,&mut p,"Friends",box_rect(28,80,180,38),28,INK);
    line(dc,&mut p,222,80,1);fill(dc,&mut p,box_rect(222,80,1,height-194),LINE);
    if !s.paired {
        friends_text(dc,&mut p,"Connect your B2G account",box_rect(x,148,w,36),26,INK);
        friends_text(dc,&mut p,"Use Connect Account below to find friends and view player profiles.",box_rect(x,192,w,26),16,MUTED);
    } else if f.view.target.is_some(){
        if let Some(profile)=&f.profile {
            let who=&profile["player"];
            let name=bounded_text(who.get("displayName"),"B2G player",48);
            let initial=name.chars().next().map(|c|c.to_uppercase().to_string()).unwrap_or("B".into());
            if who["relationship"]=="self"{profile_icon(dc,&mut p,box_rect(x,126,56,56),s.snapshot.as_ref());}
            else{rounded(dc,box_rect(x,126,56,56),BLUE_TINT,BLUE_EDGE);
                text_row(dc,&mut p,&initial,box_rect(x,126,56,56),28,600,false,BLUE,SINGLE|DT_CENTER,0);}
            friends_text(dc,&mut p,&name,box_rect(x+72,122,w-262,38),30,INK);
            let live=if who["online"]==true{"Online in B2G"}else if who["private"]==true{"Private profile"}else{"Offline"};
            friends_text(dc,&mut p,live,box_rect(x+72,164,w-262,22),15,if who["online"]==true{GREEN}else{MUTED});
            if who["private"]==true {
                friends_text(dc,&mut p,"This player keeps their profile private.",box_rect(x,240,w,30),22,INK);
                friends_text(dc,&mut p,"You can still send them a friend request.",box_rect(x,278,w,24),16,MUTED);
            } else {
                let member=field(profile,"memberSince").get(..10).unwrap_or("—");
                friends_text(dc,&mut p,&format!("{}  ·  Member since {}  ·  Level {}",field(profile,"region"),member,profile["level"]),box_rect(x,190,w,22),14,MUTED);
                if let Some(id)=profile["rankId"].as_u64().filter(|id|(1..=18).contains(id)) {artwork().ranks[id as usize-1].draw(dc,box_rect(x+w-202,216,80,32));}
                friends_text(dc,&mut p,&format!("{} ELO",profile["rank"]["rating"]),box_rect(x+174,210,w-390,32),27,INK);
                friends_text(dc,&mut p,field(&profile["rank"],"name"),box_rect(x+174,243,w-174,26),16,BLUE);
                if profile["steamProfileUrl"].is_null(){friends_text(dc,&mut p,"Steam not linked",box_rect(x,219,154,30),15,MUTED);}
                let stats=&profile["stats"];
                let games=stats["gamesPlayed"].as_u64().unwrap_or(0);
                let col=w/4;
                for(i,(label,value))in [("GAMES PLAYED",games.to_string()),("WIN RATE",if games>0{format!("{}%",stats["winRate"])}else{"—".into()}),
                    ("K / D",if games>0{format!("{:.2}",stats["kdRatio"].as_f64().unwrap_or(0.0))}else{"—".into()}),
                    ("AVG. DAMAGE / ROUND",if games>0{format!("{:.1}",stats["averageAdr"].as_f64().unwrap_or(0.0))}else{"—".into()})].into_iter().enumerate(){
                    let sx=x+i as i32*col;
                    caption(dc,&mut p,label,box_rect(sx,317,col-12,18),MUTED);
                    friends_text(dc,&mut p,&value,box_rect(sx,339,col-12,32),26,INK);
                }
                line(dc,&mut p,x,379,w);
                let summary=format!("RECENT MATCHES   ·   {} W / {} L / {} D",stats["wins"],stats["losses"],stats["draws"]);
                caption(dc,&mut p,&summary,box_rect(x,387,w-490,18),MUTED);
                for (label,offset,span) in [("DATE",w-448,92),("SCORE",w-334,124),("K / D",w-194,90),("ELO",w-90,90)] {caption(dc,&mut p,if label=="ELO"&&f.view.mode=="deathmatch"{"MODE"}else{label},box_rect(x+offset,387,span,18),MUTED);}
                let rows=profile["recentMatches"].as_array();
                // The compact viewport uses the same five rows at 24px; wider
                // windows gain breathing room without changing page identity.
                let rh=((height-664)/5+24).clamp(24,34);
                if let Some(rows)=rows {for(i,m)in rows.iter().enumerate().take(5){
                    let y=416+i as i32*rh;
                    let color=if m["outcome"]=="W"{GREEN}else if m["outcome"]=="L"{ERROR}else{MUTED};
                    friends_text(dc,&mut p,field(m,"outcome"),box_rect(x,y,24,rh),15,color);
                    friends_text(dc,&mut p,field(m,"map"),box_rect(x+32,y,w-490,rh),15,INK);
                    let date=field(m,"playedAt").get(..10).unwrap_or("—");
                    friends_text(dc,&mut p,date,box_rect(x+w-448,y,92,rh),14,MUTED);
                    friends_text(dc,&mut p,field(m,"score"),box_rect(x+w-334,y,124,rh),14,INK);
                    friends_text(dc,&mut p,&format!("{} / {}",m["kills"],m["deaths"]),box_rect(x+w-194,y,90,rh),14,INK);
                    let delta=if f.view.mode=="competitive"{format!("{:+} ELO",m["ratingDelta"].as_i64().unwrap_or(0))}else{"DM".into()};
                    friends_text(dc,&mut p,&delta,box_rect(x+w-90,y,90,rh),14,MUTED);
                }}
                if games==0 {friends_text(dc,&mut p,"No completed matches in this mode yet.",box_rect(x,422,w,28),17,MUTED);}
            }
        } else {friends_text(dc,&mut p,if f.busy{"Loading profile…"}else{"Profile unavailable. Refresh to try again."},box_rect(x,150,w,32),22,MUTED);}
    } else {
        let title=match f.view.folder.as_str(){"incoming"=>"Friend requests","outgoing"=>"Sent requests","search"=>"Find a player",_=>"Your friends"};
        friends_text(dc,&mut p,title,box_rect(x,80,w,38),28,INK);
        if f.view.folder=="search" {rounded(dc,box_rect(x,122,w-124,36),INSET,LINE);}
        else {friends_text(dc,&mut p,match f.view.folder.as_str(){"incoming"=>"Open a profile to accept or decline their request.","outgoing"=>"Your friend requests are waiting for acceptance.",_=>"Open a friend’s profile to see their latest results."},box_rect(x,124,w,26),16,MUTED);}
        let empty=f.page.as_ref().is_none_or(|p|p["entries"].as_array().is_none_or(|a|a.is_empty()));
        if empty {
            let copy=if f.busy&&!f.loaded{"Loading players…"}else{match f.view.folder.as_str(){"search" if f.view.query.is_empty()=>"Search by player name, B2G ID or trade code.","search"=>"No players found. Try another name or ID.","incoming"=>"No friend requests right now.","outgoing"=>"You haven’t sent any friend requests.",_=>"Your friends will appear here."}};
            friends_text(dc,&mut p,copy,box_rect(x,224,w,30),22,INK);
            if f.view.folder=="friends"{friends_text(dc,&mut p,"Choose Find a player to send your first request.",box_rect(x,266,w,26),16,MUTED);}
        }
    }
    // Status stays below the content and above the persistent Play bar.
    if let Some(error)=&f.error{friends_text(dc,&mut p,error,box_rect(x,height-124,w,26),15,ERROR);}
    else if !f.notice.is_empty(){friends_text(dc,&mut p,&f.notice,box_rect(x,height-124,w,26),15,GREEN);}
    for c in friends_controls(width,height,s){if !matches!(c.id,FRIEND_QUERY|FRIEND_QUERY_LABEL){paint_friends_button(dc,c.rect,c.id,s,false,false);}}
}
fn paint_friends_button(dc:HDC,r:BoxRect,id:i32,s:&UiState,pressed:bool,focused:bool){
    let Some(c)=friends_controls(WINDOW_WIDTH,WINDOW_HEIGHT,s).into_iter().find(|c|c.id==id)else{return;};
    let mut p=PaintObjects::new();
    let primary=id==FRIEND_ACTION&&s.friends.profile.as_ref().is_some_and(|p|matches!(field(&p["player"],"relationship"),"none"|"incoming"))||id==FRIEND_SEARCH;
    let bg=if primary&&c.enabled{mix_color(BLUE,BLUE_HOVER,s.hover_amount(id))}else if c.selected||pressed{INSET}else{mix_color(PANEL,INSET,s.hover_amount(id))};
    rounded(dc,r,bg,if c.selected{BLUE_EDGE}else{bg});
    if id>=FRIEND_ROW {
        if let Some(who)=s.friends.page.as_ref().and_then(|p|p["entries"].get((id-FRIEND_ROW)as usize)){
            let live=who["online"]==true;
            icon(dc,box_rect(r.left+10,r.top+10,16,16),22,if live{GREEN}else{MUTED});
            friends_text(dc,&mut p,&bounded_text(who.get("displayName"),"Player",48),box_rect(r.left+38,r.top,r.width()-290,r.height()),17,INK);
            let status=match field(who,"relationship"){"incoming"=>"Request received","outgoing"=>"Request sent","friends" if live=>"Online in B2G","friends"=>"Offline",_=>"View profile"};
            friends_text(dc,&mut p,status,box_rect(r.right-240,r.top,202,r.height()),14,if live{GREEN}else{MUTED});
            stroke(dc,box_rect(r.right-26,r.top+10,16,16),&[vec![(9.,6.),(15.,12.),(9.,18.)]],0.95,MUTED);
        }
    }else {
        let label_rect=if id==FRIEND_STEAM{box_rect(r.left+10,r.top+7,r.width()-38,r.height()-14)}else{r.inset(7)};
        text_row(dc,&mut p,&c.label,label_rect,14,600,false,if !c.enabled{MUTED}else if primary{BLUE_INK}else{INK},SINGLE|if id<FRIEND_ME{0}else{DT_CENTER},0);
        if id==FRIEND_STEAM{icon(dc,box_rect(r.right-26,r.top+7,16,16),NEWS_ID,MUTED);}
    }
    if focused{unsafe{FrameRect(dc,&r.inset(2).native(),p.brush(BLUE));}}
}
// Windows associates an EDIT with its preceding STATIC in the native child order.
fn friends_ids()->impl Iterator<Item=i32>{(5000..5005).chain([FRIEND_QUERY_LABEL]).chain(5005..=5017).chain(5100..5108)}
fn create_friends_controls(hwnd:HWND){
    unsafe{SetWindowLongPtrW(hwnd,GWL_EXSTYLE,GetWindowLongPtrW(hwnd,GWL_EXSTYLE)|WS_EX_CONTROLPARENT as isize);}
    for id in friends_ids(){unsafe{
        let edit=id==FRIEND_QUERY;
        let label=id==FRIEND_QUERY_LABEL;
        // STATIC: SS_LEFT | SS_CENTERIMAGE | SS_NOPREFIX.
        let child=CreateWindowExW(0,wide(if label{"STATIC"}else if edit{"EDIT"}else{"BUTTON"}).as_ptr(),wide("").as_ptr(),WS_CHILD|if label{0x0280}else{WS_TABSTOP|if edit{ES_AUTOHSCROLL as u32}else{BS_OWNERDRAW as u32}},0,0,1,1,hwnd,id as usize as HMENU,GetModuleHandleW(ptr::null()),ptr::null());
        if !child.is_null(){
            if edit{SendMessageW(child,windows_sys::Win32::UI::Controls::EM_SETLIMITTEXT,80,0);friends_accessible_name(child,false);}
            else if !label{SetWindowSubclass(child,Some(button_proc),id as usize,0);}
            SetWindowSubclass(child,Some(friends_child_proc),id as usize,0);
        }
    }}
}
fn sync_friends_controls(hwnd:HWND){
    let size=logical_client(hwnd);let dpi=unsafe{GetDpiForWindow(hwnd)}.max(96)as i32;
    let (controls,query)={let Ok(s)=state().lock()else{return;};(friends_controls(size.right,size.bottom,&s),s.friends.query.clone())};
    let mut fonts=PaintObjects::new();let font=fonts.typeface(15*dpi/96,400,false);
    for id in friends_ids(){unsafe{
        let child=GetDlgItem(hwnd,id);if child.is_null(){continue;}
        if let Some(c)=controls.iter().find(|c|c.id==id){
            let r=c.rect;MoveWindow(child,r.left*dpi/96,r.top*dpi/96,r.width()*dpi/96,r.height()*dpi/96,0);
            EnableWindow(child,i32::from(c.enabled));
            let value=if id==FRIEND_QUERY{&query}else{&c.label};
            if trade_edit_text(hwnd,id)!=*value{SetWindowTextW(child,wide(value).as_ptr());}
            if id==FRIEND_QUERY{SendMessageW(child,WM_SETFONT,font as usize,0);SendMessageW(child,windows_sys::Win32::UI::Controls::EM_SETCUEBANNER,1,wide(&c.label).as_ptr()as isize);}
            if id==FRIEND_QUERY_LABEL{SendMessageW(child,WM_SETFONT,fonts.typeface(28*dpi/96,500,false)as usize,0);}
            ShowWindow(child,SW_SHOWNOACTIVATE);InvalidateRect(child,ptr::null(),0);
        }else{ShowWindow(child,SW_HIDE);}
    }}
}
unsafe extern "system" fn friends_child_proc(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM,id:usize,_data:usize)->LRESULT{
    unsafe{
        if message==WM_KEYDOWN&&wparam==13&&id==FRIEND_QUERY as usize {friends_command(GetParent(hwnd),FRIEND_SEARCH);return 0;}
        if message==WM_NCDESTROY{if id==FRIEND_QUERY as usize{friends_accessible_name(hwnd,true);}RemoveWindowSubclass(hwnd,Some(friends_child_proc),id);}
        DefSubclassProc(hwnd,message,wparam,lparam)
    }
}
// Direct annotation keeps the Win32 EDIT's accessible Name separate from its
// changing Value, including in our custom window rather than a dialog resource.
// ABI and GUIDs: Windows SDK oleacc.h, IAccPropServices (slots 2, 7 and 9).
// https://learn.microsoft.com/windows/win32/winauto/using-direct-annotation
fn friends_accessible_name(hwnd:HWND,clear:bool){
    use windows_sys::core::GUID;
    use windows_sys::Win32::System::Com::{CoCreateInstance,CoInitializeEx,CoUninitialize,CLSCTX_INPROC_SERVER,COINIT_APARTMENTTHREADED};
    type Object=*mut std::ffi::c_void;
    #[repr(C)]
    struct Methods {
        unknown:[usize;2],release:unsafe extern "system" fn(Object)->u32,
        props:[usize;4],set_name:unsafe extern "system" fn(Object,HWND,u32,u32,GUID,*const u16)->i32,
        server:usize,clear:unsafe extern "system" fn(Object,HWND,u32,u32,*const GUID,i32)->i32,
    }
    let class=GUID::from_u128(0xb5f8350b_0548_48b1_a6ee_88bd00b4a5e7);
    let interface=GUID::from_u128(0x6e26e776_04f0_495d_80e4_3330352e3169);
    let names=[GUID::from_u128(0x608d3df8_8128_4aa7_a428_f55e49267291),
        GUID::from_u128(0xc3a6921b_4a99_44f1_bca6_61187052c431)];
    unsafe{
        let key=wide("B2G.AccessibleName.Service");let init_key=wide("B2G.AccessibleName.ComInitialized");
        if clear{
            let service=RemovePropW(hwnd,key.as_ptr());
            if !service.is_null(){let methods=&**(service as *const *const Methods);
                (methods.clear)(service,hwnd,OBJID_CLIENT as u32,0,names.as_ptr(),2);(methods.release)(service);}
            if !RemovePropW(hwnd,init_key.as_ptr()).is_null(){CoUninitialize();}
            return;
        }
        let initialized=CoInitializeEx(ptr::null(),COINIT_APARTMENTTHREADED as u32);
        let mut service:Object=ptr::null_mut();
        if CoCreateInstance(&class,ptr::null_mut(),CLSCTX_INPROC_SERVER,&interface,&mut service)>=0&&!service.is_null(){
            let methods=&**(service as *const *const Methods);
            for name in names{(methods.set_name)(service,hwnd,OBJID_CLIENT as u32,0,name,wide("Find a player").as_ptr());}
            if SetPropW(hwnd,key.as_ptr(),service)!=0{
                if initialized>=0{SetPropW(hwnd,init_key.as_ptr(),1usize as Object);}
                return;
            }
            (methods.release)(service);
        }
        if initialized>=0{CoUninitialize();}
    }
}
fn friends_edit_changed(hwnd:HWND,id:i32){
    if id!=FRIEND_QUERY{return;}
    let query=trade_edit_text(hwnd,id);
    if let Ok(mut s)=state().lock(){s.friends.query=query;}
    sync_friends_controls(hwnd);
}
fn friends_open(hwnd:HWND,target:String){
    {let Ok(mut s)=state().lock()else{return;};if !s.paired||s.friends.mutating{return;}
        s.tab=LauncherTab::Friends;let f=&mut s.friends;
        f.view.target=Some(target);f.view.match_offset=0;f.profile=None;f.loaded=false;f.confirm_remove=false;f.epoch+=1;f.busy=false;
    }
    refresh_friends(hwnd,false,false);
}
fn friends_command(hwnd:HWND,id:i32){
    if id==FRIEND_ME{friends_open(hwnd,"me".into());return;}
    let mut mutation=None;let mut read=false;let mut url=None;let mut copy=None;
    {
        let Ok(mut s)=state().lock()else{return;};
        if !s.paired{return;}
        let f=&mut s.friends;if f.mutating{return;}
        if (FRIEND_FOLDER..FRIEND_ME).contains(&id){
            f.view.folder=["friends","incoming","outgoing","search"][(id-FRIEND_FOLDER)as usize].into();
            f.view.target=None;f.view.offset=0;f.page=None;read=true;
        }else if id>=FRIEND_ROW&&id<FRIEND_ROW+8 {
            if let Some(who)=f.page.as_ref().and_then(|p|p["entries"].get((id-FRIEND_ROW)as usize)){
                f.view.target=Some(field(who,"playerId").into());f.view.match_offset=0;f.profile=None;read=true;
            }
        }else{match id {
            FRIEND_ME=>{f.view.target=Some("me".into());f.view.match_offset=0;f.profile=None;read=true;}
            FRIEND_BACK=>{f.view.target=None;read=true;}
            FRIEND_SEARCH if f.query.trim().chars().count()>=2=>{f.view.query=f.query.trim().into();f.view.offset=0;f.page=None;read=true;}
            FRIEND_PREV|FRIEND_NEXT=>{
                let offset=if f.view.target.is_some(){&mut f.view.match_offset}else{&mut f.view.offset};
                let step=if f.view.target.is_some(){5}else{8};
                *offset=if id==FRIEND_PREV{offset.saturating_sub(step)}else{*offset+step};read=true;
            }
            FRIEND_COMP|FRIEND_DM=>{f.view.mode=if id==FRIEND_COMP{"competitive"}else{"deathmatch"}.into();f.view.match_offset=0;f.profile=None;read=true;}
            FRIEND_STEAM=>{url=f.profile.as_ref().and_then(|p|p["steamProfileUrl"].as_str()).map(str::to_owned);}
            FRIEND_COPY=>{copy=f.profile.as_ref().map(|p|field(&p["player"],"playerId").to_string());}
            FRIEND_RETRY=>{mutation=f.pending.clone();read=mutation.is_none();}
            FRIEND_ACTION|FRIEND_DECLINE if f.pending.is_none()=>{
                if let Some(p)=&f.profile{
                    let who=&p["player"];let relation=field(who,"relationship");
                    let action=match relation{"incoming" if id==FRIEND_DECLINE=>"decline","incoming"=>"accept","outgoing"=>"cancel","friends"=>"remove","none"=>"add",_=>""};
                    if action=="remove"&&!f.confirm_remove{f.confirm_remove=true;}
                    else if !action.is_empty(){
                        let request_id=if action=="add"{crate::trading::request_uuid()}else{Ok(field(who,"requestId").into())};
                        match request_id{Ok(request_id)=>mutation=Some(FriendMutation{target:field(who,"playerId").into(),request_id,action:action.into()}),Err(e)=>f.error=Some(e)}
                    }
                }
            }
            _=>{}
        }}
        if read||mutation.is_some(){f.epoch+=1;f.busy=false;f.confirm_remove=false;if read{f.loaded=false;}}
    }
    if let Some(url)=url{if url.strip_prefix("https://steamcommunity.com/profiles/").is_some_and(|id|id.len()==17&&id.bytes().all(|b|b.is_ascii_digit())){open_url(&url);}}
    if let Some(value)=copy{let ok=trade_clipboard(hwnd,&value);if let Ok(mut s)=state().lock(){s.friends.notice=if ok{"B2G player ID copied."}else{"Clipboard is busy. Try again."}.into();}}
    if mutation.is_some(){friends_work(hwnd,false,false,mutation);}else if read{refresh_friends(hwnd,false,false);}
    sync_controls(hwnd);unsafe{InvalidateRect(hwnd,ptr::null(),0);}
}

#[cfg(test)]
#[path="friends_tests.rs"]
mod friends_tests;
