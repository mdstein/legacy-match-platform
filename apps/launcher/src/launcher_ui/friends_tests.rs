use super::*;
use serde_json::json;
const PLAYER:&str="6dcd25d0-1954-4d15-8497-fb37bdff48bd";
fn fixture()->UiState{
    let mut s=render_tests::fixture();s.tab=LauncherTab::Friends;
    let who=json!({"playerId":PLAYER,"displayName":"topCHINAcode","relationship":"incoming","requestId":PLAYER,"private":false,"online":true});
    s.friends.page=Some(json!({"entries":[who.clone()],"total":1,"incomingCount":1,"friendCount":12}));
    s.friends.incoming=1;s.friends.count=12;s.friends.loaded=true;
    s.friends.profile=Some(json!({"player":who,"region":"NA Central","memberSince":"2017-05-06T00:00:00Z","level":23,
        "steamProfileUrl":"https://steamcommunity.com/profiles/76561198000000101",
        "rank":{"name":"Master Guardian I","rating":1525},"rankId":11,"mode":"competitive",
        "stats":{"gamesPlayed":216,"wins":126,"losses":84,"draws":6,"winRate":58.3,"kdRatio":1.24,"averageAdr":86.7},
        "recentMatches":(0..5).map(|i|json!({"id":PLAYER,"map":if i%2==0{"de_dust2"}else{"de_mirage"},"outcome":if i%2==0{"W"}else{"L"},
            "playedAt":"2026-09-07T18:00:00Z","score":"16–12","kills":24,"deaths":16,"ratingDelta":24})).collect::<Vec<_>>(),"matchTotal":216}));s
}
#[test]
fn quiet_updates_and_stale_view_account_fences(){
    let mut f=fixture().friends;f.view.target=Some(PLAYER.into());f.busy=true;f.epoch=4;
    let result=|epoch,window|FriendsResult{epoch,window,view:f.view.clone(),quiet:true,badge:false,mutation:false,data:Ok((f.page.clone().unwrap(),f.profile.clone()))};
    let same=result(4,7);let stale=result(3,7);let other=result(4,8);
    assert!(!f.apply(stale,7));assert!(f.busy);assert!(!f.apply(other,7));assert!(f.busy);
    assert!(!f.apply(same,7));assert!(!f.busy);
    f.pending=Some(FriendMutation{target:PLAYER.into(),request_id:PLAYER.into(),action:"accept".into()});
    let response=FriendsResult{window:7,epoch:4,view:f.view.clone(),quiet:false,badge:false,mutation:true,data:Err("Connection interrupted".to_string().into())};
    assert!(f.apply(response,7));assert!(f.pending.is_some());assert!(!f.mutating);
    let response=FriendsResult{window:7,epoch:4,view:f.view.clone(),quiet:false,badge:false,mutation:true,data:Ok((f.page.clone().unwrap(),f.profile.clone()))};
    f.apply(response,7);assert!(f.pending.is_none());
}
#[test]
fn friends_size_dpi_and_state_matrix(){
    load_fonts();
    for(w,h)in[(1024,664),(1280,780),(1360,800)]{for dpi in[96,120,144,192]{for page in 0..8{
        if page>1&&(w!=1024||dpi!=96){continue;}
        let mut s=fixture();
        if page==0 {s.friends.page.as_mut().unwrap()["entries"]=json!((0..8).map(|i|json!({"playerId":PLAYER,"displayName":format!("Player {}",i+1),"relationship":"friends","online":i<3})).collect::<Vec<_>>());s.friends.page.as_mut().unwrap()["total"]=json!(12);}
        else{s.friends.view.target=Some(PLAYER.into());}
        match page{
            2=>{s.friends.profile.as_mut().unwrap()["player"]["private"]=json!(true);}
            3=>{s.friends.view.target=None;s.friends.view.folder="search".into();s.friends.page=None;}
            4=>{s.friends.view.mode="deathmatch".into();let p=s.friends.profile.as_mut().unwrap();p["stats"]=json!({"gamesPlayed":0,"wins":0,"losses":0,"draws":0});p["recentMatches"]=json!([]);p["matchTotal"]=json!(0);}
            5=>{s.friends.profile=None;s.friends.error=Some("Could not reach B2G. Check your connection and retry.".into());}
            6=>{s.paired=false;}
            7=>{s.friends.profile.as_mut().unwrap()["player"]["displayName"]=json!("VeryLongPlayerNameWithNoSpacesAndAnotherLongPart");}
            _=>{}
        }
        let controls=friends_controls(w,h,&s);
        for (i,a)in controls.iter().enumerate(){
            assert!(a.rect.left>=0&&a.rect.right<=w&&a.rect.top>=73&&a.rect.bottom<=h-100,"{} at {w}x{h}",a.id);
            for b in &controls[i+1..]{assert!(a.rect.right<=b.rect.left||b.rect.right<=a.rect.left||a.rect.bottom<=b.rect.top||b.rect.bottom<=a.rect.top,"overlap {} {}",a.id,b.id);}
        }
        let surface=Surface::new(w*dpi/96,h*dpi/96).unwrap();scale_dc(surface.dc,dpi as u32);paint_surface(surface.dc,w,h,&s);unsafe{GdiFlush();}
        if let Some(dir)=std::env::var_os("B2G_RENDER_TEST_DIR"){window_tests::save_native_render(&dir,&format!("friends-{page}-{w}x{h}-{dpi}"),&surface);}
    }}}
}
#[test]
fn native_friends_journey(){
    use std::os::windows::process::CommandExt;
    use std::process::{Command,Stdio};
    let _serial=NATIVE_TEST_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let mut child=Command::new(std::env::current_exe().unwrap()).creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .args(["--exact","launcher_ui::windows::friends_tests::native_friends_child","--ignored","--nocapture"])
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(20);
    while child.try_wait().unwrap().is_none(){if std::time::Instant::now()>deadline{child.kill().unwrap();panic!("Friends window stalled");}thread::sleep(std::time::Duration::from_millis(20));}
    let out=child.wait_with_output().unwrap();assert!(out.status.success(),"{}\n{}",String::from_utf8_lossy(&out.stdout),String::from_utf8_lossy(&out.stderr));
}
unsafe extern "system" fn fixture_proc(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM)->LRESULT{
    if message==WM_CREATE{create_controls(hwnd);create_friends_controls(hwnd);sync_controls(hwnd);return 0;}
    unsafe{window_proc(hwnd,message,wparam,lparam)}
}
fn pump(){unsafe{let mut m:MSG=std::mem::zeroed();while PeekMessageW(&mut m,ptr::null_mut(),0,0,PM_REMOVE)!=0{TranslateMessage(&m);DispatchMessageW(&m);}}}
fn settled(){let end=std::time::Instant::now()+std::time::Duration::from_secs(5);loop{pump();if state().lock().is_ok_and(|s|!s.friends.busy){break;}assert!(std::time::Instant::now()<end,"Friends worker timed out");thread::sleep(std::time::Duration::from_millis(5));}}
fn click(hwnd:HWND,id:i32){unsafe{let c=GetDlgItem(hwnd,id);assert_ne!(IsWindowVisible(c),0,"hidden {id}");assert_ne!(IsWindowEnabled(c),0,"disabled {id}");SendMessageW(c,BM_CLICK,0,0);}pump();}
fn capture(hwnd:HWND,name:&str){if let Some(dir)=std::env::var_os("B2G_RENDER_TEST_DIR"){unsafe{UpdateWindow(hwnd);let mut r:RECT=std::mem::zeroed();GetWindowRect(hwnd,&mut r);let surface=Surface::new(r.right-r.left,r.bottom-r.top).unwrap();assert_ne!(windows_sys::Win32::Storage::Xps::PrintWindow(hwnd,surface.dc,0),0);GdiFlush();window_tests::save_native_render(&dir,name,&surface);}}}
fn accessible_name(hwnd:HWND)->String{
    use std::os::windows::process::CommandExt;
    let handle=hwnd as usize;let(tx,rx)=std::sync::mpsc::channel();
    thread::spawn(move||{
        let code=format!(r#"Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class B2GAccessibleTest {{ [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr window, uint obj, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible acc); public static string Name(IntPtr window) {{ var iid=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71"); Accessibility.IAccessible acc; Marshal.ThrowExceptionForHR(AccessibleObjectFromWindow(window,0xfffffffc,ref iid,out acc)); return acc.get_accName(0); }} }}'
[B2GAccessibleTest]::Name([IntPtr]{handle})
"#);
        let out=std::process::Command::new("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .args(["-NoProfile","-NonInteractive","-Command",&code]).output().unwrap();
        tx.send(out).unwrap();
    });
    let end=std::time::Instant::now()+std::time::Duration::from_secs(8);
    loop{pump();if let Ok(out)=rx.try_recv(){assert!(out.status.success(),"{}",String::from_utf8_lossy(&out.stderr));return String::from_utf8_lossy(&out.stdout).trim().to_string();}
        assert!(std::time::Instant::now()<end,"UI Automation name read stalled");thread::sleep(std::time::Duration::from_millis(5));}
}
#[test]
#[ignore="launched by the friends native watchdog"]
fn native_friends_child(){
    use crate::trading::test_support::{Response,Server,set_connection};
    use std::sync::Arc;
    unsafe{SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);}load_fonts();
    let data=Arc::new(Mutex::new(fixture().friends.profile.unwrap()));let remote=data.clone();
    let mutations=Arc::new(Mutex::new(Vec::<Value>::new()));let recorded=mutations.clone();
    let server=Server::new(move|request|{
        assert_eq!(request.bearer,"Bearer friends-fixture");
        let mut profile=remote.lock().unwrap();
        let value=if request.method=="POST" {
            let mut actions=recorded.lock().unwrap();actions.push(request.body.clone());
            profile["player"]["relationship"]=json!(if request.body["action"]=="accept"{"friends"}else if request.body["action"]=="remove"{"none"}else{"outgoing"});
            if actions.len()==1{return Response{drop_response:true,..Response::okay(profile["player"].clone())};}
            profile["player"].clone()
        }else if request.path.contains("/players/"){profile.clone()}
        else if request.path.contains("/friends"){json!({"entries":[profile["player"].clone()],"total":1,"friendCount":if profile["player"]["relationship"]=="friends"{1}else{0},"incomingCount":if profile["player"]["relationship"]=="incoming"{1}else{0}})}
        else{panic!("unexpected {}",request.path)};
        Response{delay:std::time::Duration::from_millis(60),..Response::okay(value)}
    });
    set_connection(Some(server.connection("friends-fixture")));
    let mut initial=fixture();initial.tab=LauncherTab::Play;initial.friends=FriendsState::default();initial.trading.window=88;
    *state().lock().unwrap()=initial;events().lock().unwrap().clear();
    let instance=unsafe{GetModuleHandleW(ptr::null())};let name=wide("B2GNativeFriendsFixture");
    let class=WNDCLASSEXW{cbSize:size_of::<WNDCLASSEXW>()as u32,lpfnWndProc:Some(fixture_proc),hInstance:instance,lpszClassName:name.as_ptr(),..unsafe{std::mem::zeroed()}};
    assert_ne!(unsafe{RegisterClassExW(&class)},0);
    let hwnd=unsafe{CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,name.as_ptr(),wide("Friends fixture").as_ptr(),WS_OVERLAPPEDWINDOW|WS_CLIPCHILDREN,GetSystemMetrics(SM_XVIRTUALSCREEN)-3000,GetSystemMetrics(SM_YVIRTUALSCREEN)-3000,1280,780,ptr::null_mut(),ptr::null_mut(),instance,ptr::null())};assert!(!hwnd.is_null());
    unsafe{ShowWindow(hwnd,SW_SHOWNOACTIVATE);}pump();
    click(hwnd,FRIENDS_TAB_ID);settled();click(hwnd,FRIEND_FOLDER+3);settled();
    let edit=unsafe{GetDlgItem(hwnd,FRIEND_QUERY)};unsafe{SetFocus(edit);for c in "topCHINAcode".encode_utf16(){SendMessageW(edit,WM_CHAR,c as usize,0);}}
    assert_eq!(trade_edit_text(hwnd,FRIEND_QUERY),"topCHINAcode");
    assert_eq!(accessible_name(edit),"Find a player");
    unsafe{let m=MSG{hwnd:edit,message:WM_KEYDOWN,wParam:9,..std::mem::zeroed()};assert_ne!(IsDialogMessageW(hwnd,&m),0);assert_eq!(windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus(),GetDlgItem(hwnd,FRIEND_SEARCH));SetFocus(edit);}
    capture(hwnd,"native-friends-search");
    refresh_friends(hwnd,true,false);settled();assert_eq!(trade_edit_text(hwnd,FRIEND_QUERY),"topCHINAcode");
    unsafe{SendMessageW(edit,WM_KEYDOWN,13,0);}settled();click(hwnd,FRIEND_ROW);settled();capture(hwnd,"native-friends-profile");
    click(hwnd,FRIEND_ACTION);click(hwnd,PLAY_TAB_ID);settled();
    assert!(state().lock().unwrap().friends.pending.is_some());
    click(hwnd,FRIENDS_TAB_ID);settled();click(hwnd,FRIEND_RETRY);settled();
    assert!(state().lock().unwrap().friends.pending.is_none());
    {let actions=mutations.lock().unwrap();assert_eq!(actions[0],actions[1]);}
    assert_eq!(state().lock().unwrap().friends.profile.as_ref().unwrap()["player"]["relationship"],"friends");
    click(hwnd,FRIEND_ACTION);assert!(state().lock().unwrap().friends.confirm_remove);
    click(hwnd,FRIEND_ACTION);settled();assert_eq!(data.lock().unwrap()["player"]["relationship"],"none");
    unsafe{DestroyWindow(hwnd);}pump();set_connection(None);
}
