use super::*;
use std::time::{Duration,Instant};

fn install_status(ready:bool)->crate::setup::InstallStatus {crate::setup::InstallStatus{steam_available:true,ready,downloaded:2_000_000_000,total:8_000_000_000,detail:if ready{"CS:GO is installed and ready."}else{"Steam is downloading CS:GO."}.into()}}
fn first_run_status()->crate::setup::InstallStatus {crate::setup::InstallStatus{steam_available:true,ready:false,downloaded:0,total:0,detail:"CS:GO is not installed. Choose Install in the B2G launcher to download it through Steam.".into()}}
#[test]
fn first_run_gates_launch_and_ignores_cancelled_or_old_account_results(){
    let mut s=render_tests::fixture();s.setup.installation=Some(install_status(false));
    assert_eq!(s.primary_label(),"INSTALL");assert!(!s.begin_play());
    s.setup.installation=Some(install_status(true));s.snapshot.as_mut().unwrap().onboarding_required=true;
    assert_eq!(s.primary_label(),"FINISH SETUP");assert!(!s.begin_play());
    s.pairing=true;s.setup.pair_epoch=2;
    assert!(!s.apply_event(UiEvent::Setup(SetupEvent::Paired{window:0,epoch:1,result:Ok("late".into())})));
    assert!(s.pairing);
    s.apply_event(UiEvent::Setup(SetupEvent::Profile{window:0,result:Ok(serde_json::json!({"displayName":"NewPlayer","region":"NA East"}))}));
    assert!(!s.needs_profile());assert_eq!(s.snapshot.as_ref().unwrap().display_name,"NewPlayer");
    s.apply_event(UiEvent::SnapshotRead{window:0,result:Err("old credential".into())});assert!(s.paired);
    assert!(!valid_setup_name("ab"));assert!(!valid_setup_name("bad name"));assert!(valid_setup_name("Valid_Name-1"));
}
#[test]
fn setup_and_motion_matrix(){
    for (width,height,dpi) in [(1024,664,96),(1360,800,96),(1024,664,144),(1360,800,192)]{
        for name in ["first-run","install-progress","steam-code","signup","signup-error","install-error"]{
            let mut s=UiState::default();s.setup.installation=Some(install_status(false));
            match name {
                "first-run"=>s.setup.installation=Some(first_run_status()),
                "install-progress"=>s.setup.installing=true,
                "steam-code"=>{s.pairing=true;s.setup.pair_code=Some("ABCD-EFGH".into());s.setup.pair_url=Some("https://play.back2go.net/".into());},
                "signup"|"signup-error"=>{s=render_tests::fixture();s.snapshot.as_mut().unwrap().onboarding_required=true;s.setup.installation=Some(install_status(true));if name=="signup-error"{s.setup.profile_error=Some("That name is already taken. Choose another name.".into());}},
                "install-error"=>s.setup.install_error=Some("Steam could not open. Start Steam and retry Install.".into()),
                _=>{}
            }
            for c in setup_controls(width,height,&s){assert!(c.rect.left>=0&&c.rect.right<=width&&c.rect.top>=73&&c.rect.bottom<=height-97,"{name}: {}",c.id);}
            let surface=Surface::new(width*dpi/96,height*dpi/96).unwrap();scale_dc(surface.dc,dpi as u32);paint_surface(surface.dc,width,height,&s);
            if let Some(dir)=std::env::var_os("B2G_RENDER_TEST_DIR"){window_tests::save_native_render(&dir,&format!("{name}-{width}-{dpi}"),&surface);}
        }
    }
    let now=Instant::now();
    for duration in [0.15,0.5] {
        let t=Transition{from:0.,to:1.,started:now,duration};
        let halfway=t.value(now+Duration::from_secs_f32(duration/2.));
        assert!(halfway>0.4&&halfway<1.);
        assert_eq!(t.value(now+Duration::from_secs(1)),1.);
    }
}
#[test]
fn native_first_run_journey(){
    use std::os::windows::process::CommandExt;
    let _serial=NATIVE_TEST_LOCK.lock().unwrap_or_else(|e|e.into_inner());
    let mut child=std::process::Command::new(std::env::current_exe().unwrap()).creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .args(["--exact","launcher_ui::windows::setup_tests::native_setup_child","--ignored","--nocapture"]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
    let deadline=Instant::now()+Duration::from_secs(20);
    while child.try_wait().unwrap().is_none(){if Instant::now()>deadline{child.kill().unwrap();panic!("First-run native controls stalled");}thread::sleep(Duration::from_millis(20));}
    let output=child.wait_with_output().unwrap();assert!(output.status.success(),"{}\n{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
}
unsafe extern "system" fn fixture_proc(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM)->LRESULT{
    if message==WM_CREATE{create_controls(hwnd);create_trade_controls(hwnd);create_account_controls(hwnd);create_setup_controls(hwnd);sync_controls(hwnd);return 0;}
    unsafe{window_proc(hwnd,message,wparam,lparam)}
}
fn pump(){unsafe{let mut m:MSG=std::mem::zeroed();while PeekMessageW(&mut m,ptr::null_mut(),0,0,PM_REMOVE)!=0{TranslateMessage(&m);DispatchMessageW(&m);}}}
fn capture(hwnd:HWND,name:&str){if let Some(dir)=std::env::var_os("B2G_RENDER_TEST_DIR"){unsafe{UpdateWindow(hwnd);let mut r:RECT=std::mem::zeroed();GetWindowRect(hwnd,&mut r);let surface=Surface::new(r.right-r.left,r.bottom-r.top).unwrap();assert_ne!(windows_sys::Win32::Storage::Xps::PrintWindow(hwnd,surface.dc,0),0);window_tests::save_native_render(&dir,name,&surface);}}}
fn pump_timers(duration:Duration){let deadline=Instant::now()+duration;while Instant::now()<deadline{unsafe{let mut m:MSG=std::mem::zeroed();while PeekMessageW(&mut m,ptr::null_mut(),WM_TIMER,WM_TIMER,PM_REMOVE)!=0{DispatchMessageW(&m);}}thread::sleep(Duration::from_millis(2));}}
fn region_pixels(hwnd:HWND,r:BoxRect)->Vec<u8>{unsafe{
    let mut size:RECT=std::mem::zeroed();GetWindowRect(hwnd,&mut size);let surface=Surface::new(size.right-size.left,size.bottom-size.top).unwrap();
    assert_ne!(windows_sys::Win32::Storage::Xps::PrintWindow(hwnd,surface.dc,0),0);
    let r=physical_rect(hwnd,r);let bytes=std::slice::from_raw_parts(surface.bits,(surface.width*surface.height*4) as usize);let mut result=vec![];
    for y in r.top..r.bottom{let start=((y*surface.width+r.left)*4) as usize;result.extend_from_slice(&bytes[start..start+(r.width()*4) as usize]);}result
}}
fn motion_trace(hwnd:HWND){
    let client=logical_client(hwnd);let controls=state().lock().map(|s|setup_controls(client.right,client.bottom,&s)).unwrap();let save=controls.iter().find(|c|c.id==SETUP_SAVE).unwrap().rect;
    let pixel=box_rect(save.left+8,save.top+8,1,1);let child=unsafe{GetDlgItem(hwnd,SETUP_SAVE)};
    let idle_color=region_pixels(hwnd,pixel);let began=Instant::now();unsafe{SendMessageW(child,WM_MOUSEMOVE,0,0);}
    assert!(state().lock().unwrap().motion.controls.contains_key(&SETUP_SAVE),"Native hover must start a transition");
    let c0=region_pixels(hwnd,pixel);let t0=began.elapsed().as_millis();pump_timers(Duration::from_millis(75));let c75=region_pixels(hwnd,pixel);let t75=began.elapsed().as_millis();pump_timers(Duration::from_millis(100));let c175=region_pixels(hwnd,pixel);let t175=began.elapsed().as_millis();
    // PrintWindow and runner scheduling may consume an entire 150ms transition.
    // Intermediate interpolation is checked deterministically above; the native
    // journey checks the visible endpoint and timer wiring without a frame rate assumption.
    assert_ne!(idle_color,c175);
    unsafe{SendMessageW(child,WM_MOUSELEAVE,0,0);}pump_timers(Duration::from_millis(175));assert_eq!(region_pixels(hwnd,pixel),idle_color);
    *state().lock().unwrap()=render_tests::fixture();sync_controls(hwnd);let l=layout(client);let hero=box_rect(l.news.left,l.news.top+32,l.news.width(),l.news.height()-130);
    let dpi=unsafe{GetDpiForWindow(hwnd)}.max(96) as i32;let point=(((hero.left+20)*dpi/96) as u32|((((hero.top+20)*dpi/96) as u32)<<16)) as LPARAM;
    let h0=region_pixels(hwnd,hero);unsafe{SendMessageW(hwnd,WM_MOUSEMOVE,0,point);}
    assert!(state().lock().unwrap().motion.hero.is_some(),"Native hero hover must start a transition");
    pump_timers(Duration::from_millis(250));let h250=region_pixels(hwnd,hero);pump_timers(Duration::from_millis(300));let h550=region_pixels(hwnd,hero);
    assert_ne!(h0,h550);
    unsafe{SendMessageW(hwnd,WM_MOUSELEAVE,0,0);}pump_timers(Duration::from_millis(550));assert_eq!(unsafe{KillTimer(hwnd,MOTION_TIMER)},0,"Idle timer should already have stopped");
    {state().lock().unwrap().begin_play();}sync_controls(hwnd);let spinner=box_rect(l.primary.left+16,l.primary.top+20,24,24);let f0=region_pixels(hwnd,spinner);pump_timers(Duration::from_millis(100));let f1=region_pixels(hwnd,spinner);assert_ne!(f0,f1);
    {let mut s=state().lock().unwrap();s.snapshot.as_mut().unwrap().reduced_motion=true;}pump_timers(Duration::from_millis(50));let reduced0=region_pixels(hwnd,spinner);pump_timers(Duration::from_millis(120));assert_eq!(reduced0,region_pixels(hwnd,spinner));assert_eq!(unsafe{KillTimer(hwnd,MOTION_TIMER)},0);
    let hero0=region_pixels(hwnd,hero);unsafe{SendMessageW(hwnd,WM_MOUSEMOVE,0,point);}pump_timers(Duration::from_millis(550));assert_eq!(hero0,region_pixels(hwnd,hero));
    if let Some(dir)=std::env::var_os("B2G_RENDER_TEST_DIR"){std::fs::write(std::path::PathBuf::from(dir).join("native-motion-trace.json"),serde_json::json!({"hoverMeasuredMs":[t0,t75,t175],"hoverBgra":[c0,c75,c175],"heroWaitIntervalsMs":[0,250,300],"heroFrameHashes":[format!("{:x}",<sha2::Sha256 as sha2::Digest>::digest(&h0)),format!("{:x}",<sha2::Sha256 as sha2::Digest>::digest(&h250)),format!("{:x}",<sha2::Sha256 as sha2::Digest>::digest(&h550))],"heroEndpointDistinct":true,"pendingSpinnerFramesDistinct":true,"reducedMotionStatic":true,"idleTimerStopped":true,"input":"native WM_MOUSEMOVE/LEAVE and dispatched WM_TIMER; offscreen HWND PrintWindow regions"}).to_string()).unwrap();}
}
#[test]
#[ignore="launched by first-run native watchdog"]
fn native_setup_child(){
    use crate::trading::test_support::{Server,Response,set_connection};
    unsafe{SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);}
    let server=Server::new(|request|{if request.path=="/api/launcher/v1/account"{return Response::okay(serde_json::json!({"onboardingRequired":true}));}assert_eq!(request.path,"/api/launcher/v1/account/onboarding");assert_eq!(request.bearer,"Bearer setup-fixture");assert_eq!(request.body["displayName"],"First_Player");
        Response{status:409,..Response::okay(serde_json::json!({"error":"That name is already taken. Choose another name."}))}});
    set_connection(Some(server.connection("setup-fixture")));
    let mut initial=UiState::default();initial.setup.installation=Some(first_run_status());*state().lock().unwrap()=initial;events().lock().unwrap().clear();
    let instance=unsafe{GetModuleHandleW(ptr::null())};let name=wide("B2GFirstRunFixture");let class=WNDCLASSEXW{cbSize:size_of::<WNDCLASSEXW>() as u32,lpfnWndProc:Some(fixture_proc),hInstance:instance,lpszClassName:name.as_ptr(),..unsafe{std::mem::zeroed()}};
    assert_ne!(unsafe{RegisterClassExW(&class)},0);
    let hwnd=unsafe{CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,name.as_ptr(),wide("B2G first-run fixture").as_ptr(),WS_OVERLAPPEDWINDOW|WS_CLIPCHILDREN,-3000,-3000,1280,830,ptr::null_mut(),ptr::null_mut(),instance,ptr::null())};assert!(!hwnd.is_null());
    unsafe{ShowWindow(hwnd,SW_SHOWNOACTIVATE);}pump();capture(hwnd,"native-first-run");
    {let mut s=state().lock().unwrap();s.pairing=true;s.setup.pair_code=Some("ABCD-EFGH".into());s.setup.pair_url=Some("https://play.back2go.net/".into());}
    sync_controls(hwnd);capture(hwnd,"native-steam-code");
    unsafe{SendMessageW(GetDlgItem(hwnd,SETUP_CANCEL),BM_CLICK,0,0);}pump();assert!(!state().lock().unwrap().pairing);
    {let mut s=render_tests::fixture();s.snapshot.as_mut().unwrap().onboarding_required=true;s.setup.installation=Some(install_status(true));*state().lock().unwrap()=s;}
    sync_controls(hwnd);unsafe{SetFocus(GetDlgItem(hwnd,SETUP_NAME));SendMessageW(GetDlgItem(hwnd,SETUP_NAME),WM_CHAR,'a' as usize,0);SendMessageW(GetDlgItem(hwnd,SETUP_SAVE),BM_CLICK,0,0);}
    assert_ne!(unsafe{GetUpdateRect(hwnd,ptr::null_mut(),0)},0,"Local validation must invalidate the parent immediately");pump();assert!(state().lock().unwrap().setup.profile_error.is_some());
    unsafe{SetWindowTextW(GetDlgItem(hwnd,SETUP_NAME),wide("").as_ptr());for c in "First_Player".chars(){SendMessageW(GetDlgItem(hwnd,SETUP_NAME),WM_CHAR,c as usize,0);}}
    pump();
    assert_eq!(state().lock().unwrap().setup.name,"First_Player");capture(hwnd,"native-signup-focus");
    assert_eq!(trade_edit_text(hwnd,SETUP_NAME_LABEL),"In-game &name");
    assert_eq!(unsafe{SendMessageW(GetDlgItem(hwnd,SETUP_REGION),BM_GETCHECK,0,0)},BST_CHECKED as isize);
    unsafe{let m=MSG{hwnd:GetDlgItem(hwnd,SETUP_NAME),message:WM_KEYDOWN,wParam:9,..std::mem::zeroed()};assert_ne!(IsDialogMessageW(hwnd,&m),0);assert_eq!(windows_sys::Win32::UI::Input::KeyboardAndMouse::GetFocus(),GetDlgItem(hwnd,SETUP_REGION));}
    unsafe{SendMessageW(GetDlgItem(hwnd,PRIMARY_ID),BM_CLICK,0,0);}pump();
    let deadline=Instant::now()+Duration::from_secs(5);while state().lock().unwrap().setup.saving{pump();assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
    assert!(state().lock().unwrap().setup.profile_error.is_some());assert_eq!(trade_edit_text(hwnd,SETUP_NAME),"First_Player");capture(hwnd,"native-signup-error");
    motion_trace(hwnd);
    {let mut s=UiState::default();s.setup.installation=Some(install_status(true));s.setup.installing=true;s.setup.preparing=true;*state().lock().unwrap()=s;}sync_controls(hwnd);capture(hwnd,"native-install-preparation");
    unsafe{DestroyWindow(hwnd);UnregisterClassW(name.as_ptr(),instance);}pump();set_connection(None);
}
