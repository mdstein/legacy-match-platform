// Match the template's 150 ms control colors and 500 ms / 5% hero zoom.
// Timers run only during a transition or a real pending operation.
const MOTION_TIMER:usize=5;
#[derive(Debug,Clone)]
struct Transition {from:f32,to:f32,started:std::time::Instant,duration:f32}
impl Transition {
    fn value(&self,now:std::time::Instant)->f32 {
        let t=(now.duration_since(self.started).as_secs_f32()/self.duration).clamp(0.,1.);
        // Tailwind's default cubic-bezier(.4,0,.2,1), measured in the live source.
        let (mut lo,mut hi)=(0.,1.);
        for _ in 0..12 {let u=(lo+hi)*0.5;let x=3.*(1.-u)*(1.-u)*u*0.4+3.*(1.-u)*u*u*0.2+u*u*u;if x<t{lo=u;}else{hi=u;}}
        let u=if t>=1.{1.}else{(lo+hi)*0.5};let eased=3.*(1.-u)*u*u+u*u*u;
        self.from+(self.to-self.from)*eased
    }
    fn active(&self,now:std::time::Instant)->bool {now.duration_since(self.started).as_secs_f32()<self.duration}
}
#[derive(Debug,Clone,Default)]
struct MotionState {controls:std::collections::BTreeMap<i32,Transition>,hero:Option<Transition>,hero_hovered:bool,tile:Option<usize>,frame:u32}
impl UiState {
    fn reduced_motion(&self)->bool {self.account.draft.as_ref().map(|d|d.reduced_motion).unwrap_or_else(||self.snapshot.as_ref().is_some_and(|s|s.reduced_motion))}
    fn hover_amount(&self,id:i32)->f32 {
        if self.reduced_motion(){return if self.hovered_button==Some(id){1.}else{0.};}
        self.motion.controls.get(&id).map(|t|t.value(std::time::Instant::now())).unwrap_or(if self.hovered_button==Some(id){1.}else{0.})
    }
    fn animate_hover(&mut self,id:i32,on:bool){
        let now=std::time::Instant::now();let from=self.motion.controls.get(&id).map(|t|t.value(now)).unwrap_or(if on{0.}else{1.});
        self.motion.controls.insert(id,Transition{from,to:if on{1.}else{0.},started:now,duration:0.15});
    }
    fn animate_hero(&mut self,on:bool){
        if on==self.motion.hero_hovered{return;}
        let now=std::time::Instant::now();let from=self.motion.hero.as_ref().map(|t|t.value(now)).unwrap_or(0.);
        self.motion.hero_hovered=on;
        self.motion.hero=Some(Transition{from,to:if on{1.}else{0.},started:now,duration:0.5});
    }
    fn loading(&self)->bool {(self.playing&&!self.game_ready)||self.pairing||self.setup.installing||self.setup.saving}
}
fn mix_color(a:COLORREF,b:COLORREF,t:f32)->COLORREF {
    let channel=|shift:u32|{let a=((a>>shift)&255u32) as f32;let b=((b>>shift)&255u32) as f32;(a+(b-a)*t.clamp(0.,1.)).round() as u8};
    rgb(channel(0),channel(8),channel(16))
}
fn start_motion(hwnd:HWND){unsafe{SetTimer(hwnd,MOTION_TIMER,16,None);}}
fn tick_motion(hwnd:HWND){
    let (controls,hero,loading,active)={
        let Ok(mut s)=state().lock()else{return;};let now=std::time::Instant::now();let reduced=s.reduced_motion();
        let controls=s.motion.controls.keys().copied().collect::<Vec<_>>();
        let hero=s.motion.hero.as_ref().is_some_and(|t|t.active(now));
        let active=s.motion.controls.values().any(|t|t.active(now))||hero;
        s.motion.controls.retain(|_,t|t.active(now));s.motion.frame=s.motion.frame.wrapping_add(1);
        (controls,hero,s.loading(),!reduced&&(active||s.loading()))
    };
    unsafe{
        for id in controls{InvalidateRect(GetDlgItem(hwnd,id),ptr::null(),0);}
        if loading{InvalidateRect(GetDlgItem(hwnd,PRIMARY_ID),ptr::null(),0);}
        if hero{let l=layout(logical_client(hwnd));InvalidateRect(hwnd,&physical_rect(hwnd,l.news).native(),0);}
        if !active{KillTimer(hwnd,MOTION_TIMER);}
    }
}
fn physical_rect(hwnd:HWND,r:BoxRect)->BoxRect {let dpi=unsafe{GetDpiForWindow(hwnd)}.max(96) as i32;box_rect(r.left*dpi/96,r.top*dpi/96,r.width()*dpi/96,r.height()*dpi/96)}
fn motion_mouse(hwnd:HWND,x:i32,y:i32){
    let l=layout(logical_client(hwnd));let hero=box_rect(l.news.left,l.news.top+32,l.news.width(),l.news.height()-130);
    let hit=|r:BoxRect|x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom;
    let changed={let Ok(mut s)=state().lock()else{return;};if s.tab!=LauncherTab::Play||s.setup_visible(){return;}
        let on=hit(hero);let tile=if y>=l.news.bottom-86&&y<l.news.bottom&&x>=l.news.left&&x<l.news.right{Some(usize::from(x>l.news.left+l.news.width()/2))}else{None};
        let changed=on!=s.motion.hero_hovered||tile!=s.motion.tile;s.animate_hero(on);s.motion.tile=tile;changed};
    if changed{start_motion(hwnd);unsafe{InvalidateRect(hwnd,&physical_rect(hwnd,l.news).native(),0);}}
}
fn paint_loading(dc:HDC,r:BoxRect,s:&UiState,color:COLORREF){
    // The reference's spinner is one arc on a 1 s turn, not a ring of squares.
    // Drawing it through the glyph rasterizer keeps its ends round and its edge
    // antialiased at whatever size and DPI the surface is painted at.
    let turn=if s.reduced_motion(){0.}else{(s.motion.frame%48) as f32*7.5};
    stroke(dc,r,&[arc(12.,12.,8.4,turn,turn+280.)],1.05,color);
}
