/*
THESIS: A quiet, image-led CS:GO home, faithful to the user's supplied launcher.
OWN-WORLD: Rajdhani lettering, authentic rank emblems, near-black field, CT-blue PLAY.
STORY: Your profile -> client news -> launch -> native Panorama play.
FIRST VIEWPORT: Profile left, supplied rifle artwork center, changes right; persistent PLAY.
FORM: User-pinned counter-strike-game-launcher.zip; code-led native adaptation.
FINISH: Real state, legible type, deliberate spacing, working controls, no invented claims.
This painter is shared by the real window and headless memory-only render tests.
*/

use windows_sys::Win32::UI::Controls::{DRAWITEMSTRUCT, ODS_FOCUS, ODS_SELECTED, WM_MOUSELEAVE};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, IsWindowEnabled, SetFocus, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};

const PRIMARY_ID: i32 = 1001;
const REFRESH_ID: i32 = 1002;
const ACCOUNT_ID: i32 = 1003;
const DETAILS_ID: i32 = 1004;
const MINIMIZE_ID: i32 = 1005;
const MAXIMIZE_ID: i32 = 1006;
const CLOSE_ID: i32 = 1007;
const NEWS_ID: i32 = 1008;
const UPDATE_ID: i32 = 1010;
// Tokens transcribed from the reference's oklch palette, converted to sRGB once
// here so the native surface and the supplied template stay in step.
const BG: COLORREF = rgb(8, 10, 8); // --background
const PANEL: COLORREF = rgb(16, 18, 17); // --card
const INSET: COLORREF = rgb(30, 32, 30); // --muted
const LINE: COLORREF = rgb(35, 37, 36); // --border over --card
const INK: COLORREF = rgb(243, 242, 239); // --foreground
const MUTED: COLORREF = rgb(137, 141, 143); // --muted-foreground
const BLUE: COLORREF = rgb(112, 164, 232); // --primary
const BLUE_HOVER: COLORREF = rgb(131, 179, 241);
const BLUE_INK: COLORREF = rgb(20, 32, 48); // --primary-foreground
const GREEN: COLORREF = rgb(76, 189, 136); // --live
const GOLD: COLORREF = rgb(235, 189, 87); // --accent-gold
const DESTRUCTIVE: COLORREF = rgb(234, 60, 63); // --destructive
const ERROR: COLORREF = rgb(255, 154, 144); // legible destructive text on the near-black field
// Chip fills: the reference's `color/10` background and `color/40` border over --card.
const GREEN_TINT: COLORREF = rgb(22, 35, 29);
const GREEN_EDGE: COLORREF = rgb(40, 86, 65);
const BLUE_TINT: COLORREF = rgb(26, 33, 38);
const BLUE_EDGE: COLORREF = rgb(54, 76, 103);
const RED_TINT: COLORREF = rgb(38, 22, 22);
const RED_EDGE: COLORREF = rgb(103, 35, 35);
const BLUE_WASH: COLORREF = rgb(30, 40, 49); // --primary/15
const GOLD_TINT: COLORREF = rgb(38, 35, 24);
const GOLD_EDGE: COLORREF = rgb(104, 86, 45);
const TROPHY_ICON: i32 = 23;
const SIGNAL_ICON: i32 = 24;
const RADIO_ICON: i32 = 25;
const DOT_ICON: i32 = 26;

const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    r as u32 | ((g as u32) << 8) | ((b as u32) << 16)
}
#[derive(Clone, Copy, Debug)]
struct BoxRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
impl BoxRect {
    fn native(self) -> RECT {
        RECT {
            left: self.left,
            top: self.top,
            right: self.right,
            bottom: self.bottom,
        }
    }
    fn width(self) -> i32 {
        self.right - self.left
    }
    fn height(self) -> i32 {
        self.bottom - self.top
    }
    fn inset(self, n: i32) -> Self {
        box_rect(
            self.left + n,
            self.top + n,
            self.width() - 2 * n,
            self.height() - 2 * n,
        )
    }
}
fn box_rect(x: i32, y: i32, w: i32, h: i32) -> BoxRect {
    BoxRect {
        left: x,
        top: y,
        right: x + w,
        bottom: y + h,
    }
}
struct Layout {
    primary: BoxRect,
    refresh: BoxRect,
    account: BoxRect,
    details: BoxRect,
    profile: BoxRect,
    news: BoxRect,
    changes: BoxRect,
}
fn layout(client: RECT) -> Layout {
    let w = client.right;
    let h = client.bottom;
    let left = if w >= 1280 { 300 } else { 250 };
    let right = if w >= 1280 { 320 } else { 264 };
    Layout {
        primary: box_rect(16, h - 80, 288, 64),
        refresh: box_rect(w - 264, 11, 36, 36),
        account: box_rect(w - 220, 11, 72, 36),
        details: box_rect(w - right, h - 151, right - 32, 26),
        profile: box_rect(16, 73, left, 366),
        news: box_rect(left + 32, 73, w - left - right - 64, h - 186),
        changes: box_rect(w - right - 16, 73, right, h - 186),
    }
}
struct Footer {
    region: BoxRect,
    matches: Option<BoxRect>,
    status: BoxRect,
    release: BoxRect,
}

// The play bar's labelled columns, sized so the recovery copy in CLIENT STATUS
// always keeps the two whole lines the render tests measure.
fn footer_columns(width: i32, height: i32) -> Footer {
    let top = height - 68;
    let matches = (width >= 1180).then(|| box_rect(472, top, 120, 40));
    let status_left = if matches.is_some() { 614 } else { 472 };
    Footer {
        region: box_rect(320, top, 134, 40),
        matches,
        status: box_rect(status_left, top, width - 218 - status_left, 56),
        release: box_rect(width - 202, height - 72, 186, 48),
    }
}

// Shared by the painter and the regression that proves recovery copy fits.
const FOOTER_STATUS_WEIGHT: i32 = 500;

fn control_rects(l: &Layout, width: i32) -> [(i32, BoxRect); 14] {
    let nav = if width>=1280 { 269 } else {116};
    [
        (PLAY_TAB_ID,box_rect(nav,11,66,36)),
        (TRADE_TAB_ID,box_rect(nav+70,11,100,36)),
        (HISTORY_TAB_ID,box_rect(nav+174,11,120,36)),
        (FRIENDS_TAB_ID,box_rect(nav+298,11,100,36)),
        (SETTINGS_TAB_ID,box_rect(nav+402,11,80,36)),
        (
            UPDATE_ID,
            box_rect(width - 202, l.primary.top + 32, 186, 26),
        ),
        (PRIMARY_ID, l.primary),
        (REFRESH_ID, l.refresh),
        (ACCOUNT_ID, l.account),
        (DETAILS_ID, l.details),
        (MINIMIZE_ID, box_rect(width - 116, 11, 36, 36)),
        (MAXIMIZE_ID, box_rect(width - 80, 11, 36, 36)),
        (CLOSE_ID, box_rect(width - 44, 11, 36, 36)),
        (
            NEWS_ID,
            box_rect(l.news.left + 20, l.news.bottom - 142, 112, 24),
        ),
    ]
}

// Fonts live only inside this process. Keep handles alive for the process lifetime.
fn load_fonts() {
    static LOADED: OnceLock<()> = OnceLock::new();
    LOADED.get_or_init(|| {
        for data in [
            include_bytes!("../../assets/fonts/Rajdhani-Regular.ttf").as_slice(),
            include_bytes!("../../assets/fonts/Rajdhani-Medium.ttf").as_slice(),
            include_bytes!("../../assets/fonts/Rajdhani-SemiBold.ttf").as_slice(),
            include_bytes!("../../assets/fonts/GeistMono-Regular.ttf").as_slice(),
            include_bytes!("../../assets/fonts/GeistMono-SemiBold.ttf").as_slice(),
            include_bytes!("../../assets/fonts/Rajdhani-Bold.ttf").as_slice(),
        ] {
            let mut count = 0;
            let handle = unsafe {
                AddFontMemResourceEx(
                    data.as_ptr().cast(),
                    data.len() as u32,
                    ptr::null(),
                    &mut count,
                )
            };
            if handle.is_null() {
                log_launcher_event("ui: Rajdhani unavailable; using Windows font fallback");
            }
        }
    });
}
struct PaintObjects {
    brushes: Vec<HBRUSH>,
}
impl PaintObjects {
    fn new() -> Self {
        Self { brushes: vec![] }
    }
    fn brush(&mut self, color: COLORREF) -> HBRUSH {
        let brush = unsafe { CreateSolidBrush(color) };
        self.brushes.push(brush);
        brush
    }
    #[cfg(test)]
    fn font(&mut self, height: i32, bold: bool, _body: bool) -> HFONT {
        self.typeface(height, if bold { 700 } else { 400 }, false)
    }
    fn typeface(&mut self, height: i32, weight: i32, mono: bool) -> HFONT {
        // A small process-lifetime cache; creating a font for every text row
        // during resize is unnecessary. These immutable fonts can share DCs.
        static FONTS: OnceLock<Mutex<std::collections::HashMap<(i32, i32, bool), usize>>> =
            OnceLock::new();
        let mut fonts = FONTS
            .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap();
        *fonts
            .entry((height, weight, mono))
            .or_insert_with(|| unsafe {
                CreateFontW(
                    -height,
                    0,
                    0,
                    0,
                    weight,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET.into(),
                    OUT_DEFAULT_PRECIS.into(),
                    CLIP_DEFAULT_PRECIS.into(),
                    ANTIALIASED_QUALITY.into(),
                    (DEFAULT_PITCH | FF_DONTCARE).into(),
                    wide(if mono { "Geist Mono" } else { "Rajdhani" }).as_ptr(),
                ) as usize
            }) as HFONT
    }
}
impl Drop for PaintObjects {
    fn drop(&mut self) {
        for brush in self.brushes.drain(..) {
            unsafe {
                DeleteObject(brush as HGDIOBJ);
            }
        }
    }
}
fn fill(hdc: HDC, objects: &mut PaintObjects, r: BoxRect, color: COLORREF) {
    unsafe {
        FillRect(hdc, &r.native(), objects.brush(color));
    }
}
const SINGLE: u32 = DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS;

#[cfg(test)]
fn heading_height(dc: HDC, p: &mut PaintObjects, size: i32, lines: i32) -> i32 {
    unsafe {
        let previous = SelectObject(dc, p.font(size, true, false) as HGDIOBJ);
        let mut metrics: TEXTMETRICW = std::mem::zeroed();
        let measured = GetTextMetricsW(dc, &mut metrics) != 0;
        SelectObject(dc, previous);
        if measured {
            metrics.tmHeight * lines
        } else {
            size * lines * 3 / 2
        }
    }
}

struct Raster {
    width: i32,
    height: i32,
    pixels: Vec<u8>,
}
impl Raster {
    fn packed(data: &[u8], shade: bool) -> Self {
        let width = u32::from_le_bytes(data[0..4].try_into().unwrap()) as i32;
        let height = u32::from_le_bytes(data[4..8].try_into().unwrap()) as i32;
        assert_eq!(data.len(), 8 + width as usize * height as usize * 4);
        let mut pixels = data[8..].to_vec();
        if shade {
            // A UI scrim, applied once; keeps supplied artwork visible and all overlaid copy legible.
            for y in 0..height as usize {
                let position = y as f32 / height as f32;
                let opacity = 0.18 + 0.78 * ((position - 0.20) / 0.80).clamp(0.0, 1.0);
                for x in 0..width as usize {
                    let offset = (y * width as usize + x) * 4;
                    for channel in 0..3 {
                        pixels[offset + channel] =
                            (pixels[offset + channel] as f32 * (1.0 - opacity) + 9.0 * opacity)
                                as u8;
                    }
                }
            }
        }
        Self {
            width,
            height,
            pixels,
        }
    }
    fn draw(&self, hdc: HDC, r: BoxRect) {
        self.draw_zoom(hdc,r,1.);
    }
    fn draw_zoom(&self, hdc:HDC,r:BoxRect,zoom:f32) {
        let info = bitmap_info(self.width, self.height);
        // Crop to cover without distorting imagery at compact or wide window sizes.
        let target_ratio = r.width() as f64 / r.height().max(1) as f64;
        let source_ratio = self.width as f64 / self.height as f64;
        let (sw, sh) = if target_ratio > source_ratio {
            (self.width, (self.width as f64 / target_ratio) as i32)
        } else {
            ((self.height as f64 * target_ratio) as i32, self.height)
        };
        let (sw,sh)=((sw as f32/zoom) as i32,(sh as f32/zoom) as i32);
        unsafe {
            SetStretchBltMode(hdc, HALFTONE);
            StretchDIBits(
                hdc,
                r.left,
                r.top,
                r.width(),
                r.height(),
                (self.width - sw) / 2,
                (self.height - sh) / 2,
                sw,
                sh,
                self.pixels.as_ptr().cast(),
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            );
        }
    }
}
struct Artwork {
    hero: Raster,
    map: Raster,
    avatar: Raster,
    wordmark: Raster,
    ranks: Vec<Raster>,
}
fn artwork() -> &'static Artwork {
    static ART: OnceLock<Artwork> = OnceLock::new();
    ART.get_or_init(|| Artwork {
        hero: Raster::packed(include_bytes!("../../assets/packed/hero.bgra"), false),
        map: Raster::packed(include_bytes!("../../assets/packed/map.bgra"), false),
        avatar: Raster::packed(include_bytes!("../../assets/packed/avatar.bgra"), false),
        wordmark: Raster::packed(include_bytes!("../../assets/packed/wordmark.bgra"), false),
        ranks: [
            include_bytes!("../../assets/packed/rank-1.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-2.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-3.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-4.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-5.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-6.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-7.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-8.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-9.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-10.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-11.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-12.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-13.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-14.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-15.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-16.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-17.bgra").as_slice(),
            include_bytes!("../../assets/packed/rank-18.bgra").as_slice(),
        ]
        .iter()
        .map(|data| Raster::packed(data, false))
        .collect(),
    })
}
fn bitmap_info(width: i32, height: i32) -> BITMAPINFO {
    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..unsafe { std::mem::zeroed() }
        },
        ..unsafe { std::mem::zeroed() }
    }
}

// Off-screen DIB, also used for double-buffering the native window. No desktop capture.
struct Surface {
    dc: HDC,
    bitmap: HGDIOBJ,
    previous: HGDIOBJ,
    bits: *mut u8,
    #[cfg(test)]
    width: i32,
    #[cfg(test)]
    height: i32,
}
impl Surface {
    fn new(width: i32, height: i32) -> Option<Self> {
        if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
            return None;
        }
        unsafe {
            let dc = CreateCompatibleDC(ptr::null_mut());
            if dc.is_null() {
                return None;
            }
            let mut bits = ptr::null_mut();
            let bitmap = CreateDIBSection(
                dc,
                &bitmap_info(width, height),
                DIB_RGB_COLORS,
                &mut bits,
                ptr::null_mut(),
                0,
            );
            if bitmap.is_null() || bits.is_null() {
                DeleteDC(dc);
                return None;
            }
            let previous = SelectObject(dc, bitmap as HGDIOBJ);
            Some(Self {
                dc,
                bitmap: bitmap as HGDIOBJ,
                previous,
                bits: bits.cast(),
                #[cfg(test)]
                width,
                #[cfg(test)]
                height,
            })
        }
    }
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}
fn scale_dc(dc: HDC, dpi: u32) {
    unsafe {
        SetMapMode(dc, MM_ANISOTROPIC);
        SetWindowExtEx(dc, 96, 96, ptr::null_mut());
        SetViewportExtEx(dc, dpi as i32, dpi as i32, ptr::null_mut());
    }
}
fn logical_client(hwnd: HWND) -> RECT {
    let mut r: RECT = unsafe { std::mem::zeroed() };
    unsafe {
        GetClientRect(hwnd, &mut r);
    }
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96) as i32;
    r.right = r.right * 96 / dpi;
    r.bottom = r.bottom * 96 / dpi;
    r
}

#[allow(clippy::too_many_arguments)]
fn text_row(
    dc: HDC,
    p: &mut PaintObjects,
    text: &str,
    r: BoxRect,
    size: i32,
    weight: i32,
    mono: bool,
    color: COLORREF,
    flags: u32,
    tracking: i32,
) {
    let mut text = wide(text);
    let mut rect = r.native();
    let mut flags=flags;
    unsafe {
        let previous = SelectObject(dc, p.typeface(size, weight, mono) as HGDIOBJ);
        let spacing = SetTextCharacterExtra(dc, tracking);
        // DrawText's right alignment does not consistently account for GDI
        // character spacing. Measure the spaced run before positioning it.
        if tracking!=0 && flags&DT_RIGHT!=0 && flags&DT_SINGLELINE!=0 {
            let mut extent:windows_sys::Win32::Foundation::SIZE=std::mem::zeroed();
            GetTextExtentPoint32W(dc,text.as_ptr(),(text.len()-1) as i32,&mut extent);
            rect.left=(rect.right-extent.cx).max(rect.left); flags&=!DT_RIGHT;
        }
        SetBkMode(dc, TRANSPARENT as i32);
        SetTextColor(dc, color);
        DrawTextW(
            dc,
            text.as_mut_ptr(),
            (text.len() - 1) as i32,
            &mut rect,
            flags
                | DT_NOPREFIX
                | if flags & DT_SINGLELINE == 0 {
                    DT_EDITCONTROL
                } else {
                    0
                },
        );
        SetTextCharacterExtra(dc, spacing);
        SelectObject(dc, previous);
    }
}
fn caption(dc: HDC, p: &mut PaintObjects, text: &str, r: BoxRect, color: COLORREF) {
    text_row(dc, p, text, r, 10, 500, false, color, SINGLE, 1);
}

// The reference sizes chips, rules and inline links to their own lettering
// rather than to hand-picked constants; measure once so every locale lands the same.
fn text_width(
    dc: HDC,
    p: &mut PaintObjects,
    text: &str,
    size: i32,
    weight: i32,
    mono: bool,
    tracking: i32,
) -> i32 {
    let mut rect = box_rect(0, 0, 4096, 0).native();
    let mut text = wide(text);
    unsafe {
        let previous = SelectObject(dc, p.typeface(size, weight, mono) as HGDIOBJ);
        let spacing = SetTextCharacterExtra(dc, tracking);
        DrawTextW(
            dc,
            text.as_mut_ptr(),
            (text.len() - 1) as i32,
            &mut rect,
            DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX,
        );
        SetTextCharacterExtra(dc, spacing);
        SelectObject(dc, previous);
    }
    rect.right
}

// A 9px uppercase tag on a tinted, hairline-bordered field: the reference's
// `rounded-sm border px-1 py-0` chip.
fn chip_width(dc: HDC, p: &mut PaintObjects, text: &str) -> i32 {
    text_width(dc, p, text, 9, 700, true, 1) + 14
}
fn chip(
    dc: HDC,
    p: &mut PaintObjects,
    text: &str,
    r: BoxRect,
    ink: COLORREF,
    background: COLORREF,
    border: COLORREF,
) {
    rounded(dc, r, background, border);
    text_row(dc, p, text, r, 9, 700, true, ink, SINGLE | DT_CENTER, 1);
}

// The reference's solid `bg-primary` label, sized to its own lettering.
fn solid_chip(dc: HDC, p: &mut PaintObjects, text: &str, x: i32, y: i32, height: i32) -> i32 {
    let width = text_width(dc, p, text, 10, 700, false, 1) + 16;
    rounded(dc, box_rect(x, y, width, height), BLUE, BLUE);
    text_row(
        dc,
        p,
        text,
        box_rect(x, y, width, height),
        10,
        700,
        false,
        BLUE_INK,
        SINGLE | DT_CENTER,
        1,
    );
    width
}

// `h-2 rounded-full bg-muted` with a `bg-primary` fill.
fn meter(dc: HDC, r: BoxRect, filled: i32) {
    rounded(dc, r, INSET, INSET);
    let filled = filled.clamp(0, r.width());
    if filled >= r.height() {
        rounded(dc, box_rect(r.left, r.top, filled, r.height()), BLUE, BLUE);
    }
}

// A section heading with the reference's 0.2em tracking and a hairline that
// starts where the lettering ends.
fn section(dc: HDC, p: &mut PaintObjects, title: &str, r: BoxRect, glyph: i32) {
    icon(dc, box_rect(r.left, r.top + 3, 16, 16), glyph, BLUE);
    text_row(
        dc,
        p,
        title,
        box_rect(r.left + 24, r.top, r.width() - 24, 22),
        14,
        700,
        false,
        INK,
        SINGLE,
        3,
    );
    let rule = r.left + 36 + text_width(dc, p, title, 14, 700, false, 3);
    if rule < r.right {
        line(dc, p, rule, r.top + 11, r.right - rule);
    }
}

// One labelled column of the play bar: 10px tracked caption over a 14px value,
// with the reference's optional leading dot or glyph.
#[allow(clippy::too_many_arguments)]
fn stat(
    dc: HDC,
    p: &mut PaintObjects,
    label: &str,
    value: &str,
    r: BoxRect,
    color: COLORREF,
    weight: i32,
    mark: Option<(i32, COLORREF)>,
    flags: u32,
) {
    caption(dc, p, label, box_rect(r.left, r.top, r.width(), 15), MUTED);
    let mut x = r.left;
    if let Some((kind, tint)) = mark {
        if kind == 0 {
            fill(dc, p, box_rect(x, r.top + 24, 6, 6), tint);
            x += 14;
        } else {
            icon(dc, box_rect(x, r.top + 19, 16, 16), kind, tint);
            x += 22;
        }
    }
    text_row(
        dc,
        p,
        value,
        box_rect(x, r.top + 16, r.right - x, r.height() - 16),
        14,
        weight,
        false,
        color,
        flags,
        0,
    );
}
fn text_height(
    dc: HDC,
    p: &mut PaintObjects,
    text: &str,
    width: i32,
    size: i32,
    weight: i32,
) -> i32 {
    let mut rect = box_rect(0, 0, width, 0).native();
    let mut text = wide(text);
    unsafe {
        let old = SelectObject(dc, p.typeface(size, weight, false) as HGDIOBJ);
        let spacing = SetTextCharacterExtra(dc, 0);
        DrawTextW(
            dc,
            text.as_mut_ptr(),
            (text.len() - 1) as i32,
            &mut rect,
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX,
        );
        SetTextCharacterExtra(dc, spacing);
        SelectObject(dc, old);
    }
    rect.bottom.max(size)
}
fn fit_lines(
    dc: HDC,
    p: &mut PaintObjects,
    text: &str,
    width: i32,
    size: i32,
    weight: i32,
    lines: i32,
) -> (String, i32) {
    let cap = text_height(dc, p, "Ag", width, size, weight) * lines;
    let height = text_height(dc, p, text, width, size, weight);
    if height <= cap {
        return (text.to_string(), height);
    }
    // Bounded bootstrap copy; binary search only at Unicode scalar boundaries.
    let chars = text.chars().collect::<Vec<_>>();
    let mut low = 0;
    let mut high = chars.len();
    while low < high {
        let middle = (low + high + 1) / 2;
        let candidate = format!("{}…", chars[..middle].iter().collect::<String>().trim_end());
        if text_height(dc, p, &candidate, width, size, weight) <= cap {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let fitted = format!("{}…", chars[..low].iter().collect::<String>().trim_end());
    (fitted, cap)
}

fn rounded(dc: HDC, r: BoxRect, background: COLORREF, border: COLORREF) {
    unsafe {
        let pen = CreatePen(PS_SOLID, 1, border);
        let brush = CreateSolidBrush(background);
        let oldpen = SelectObject(dc, pen as HGDIOBJ);
        let oldbrush = SelectObject(dc, brush as HGDIOBJ);
        RoundRect(dc, r.left, r.top, r.right, r.bottom, 4, 4);
        SelectObject(dc, oldbrush);
        SelectObject(dc, oldpen);
        DeleteObject(brush as HGDIOBJ);
        DeleteObject(pen as HGDIOBJ);
    }
}
// The Play card's profile picture. The artwork ships with the launcher, so the
// choice is a local preference; the rank emblem is the one option that follows
// the account, and it falls back to the portrait until a rank exists.
fn profile_icon(dc: HDC, p: &mut PaintObjects, r: BoxRect, snapshot: Option<&LauncherSnapshot>) {
    let art = artwork();
    let choice = crate::profile_icon();
    let rank = snapshot
        .map(|s| s.rank_id)
        .filter(|id| (1..=18).contains(id));
    let (ink, field, edge) = match choice.as_str() {
        "monogram-green" => (GREEN, GREEN_TINT, GREEN_EDGE),
        "monogram-gold" => (GOLD, GOLD_TINT, GOLD_EDGE),
        _ => (BLUE, BLUE_WASH, LINE),
    };
    match choice.as_str() {
        "rank" if rank.is_some() => {
            rounded(dc, r, PANEL, LINE);
            let height = r.width() * 88 / 224;
            art.ranks[rank.unwrap() as usize - 1].draw(
                dc,
                box_rect(r.left, r.top + (r.height() - height) / 2, r.width(), height),
            );
        }
        "monogram-blue" | "monogram-green" | "monogram-gold" => {
            rounded(dc, r, field, edge);
            let initial = snapshot
                .and_then(|s| s.display_name.chars().next())
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_else(|| "B".into());
            text_row(
                dc,
                p,
                &initial,
                r,
                r.height() / 2,
                600,
                false,
                ink,
                SINGLE | DT_CENTER,
                0,
            );
        }
        _ => art.avatar.draw(dc, r),
    }
}
fn card(dc: HDC, _p: &mut PaintObjects, r: BoxRect) {
    rounded(dc, r, PANEL, LINE);
}
fn line(dc: HDC, p: &mut PaintObjects, x: i32, y: i32, width: i32) {
    fill(dc, p, box_rect(x, y, width, 1), LINE);
}
include!("icons.rs");
fn hero_scrim(dc: HDC, r: BoxRect) {
    // Apply the reference's bottom scrim in destination coordinates so crop
    // changes cannot move the dark area away from its overlaid text.
    let Some(strip) = Surface::new(1, r.height()) else {
        return;
    };
    let pixels = unsafe { std::slice::from_raw_parts_mut(strip.bits, r.height() as usize * 4) };
    for (y, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let t = y as f32 / (r.height() - 1).max(1) as f32;
        let alpha = if t < 0.5 {
            t * 1.4
        } else {
            0.7 + (t - 0.5) * 0.6
        };
        pixel.copy_from_slice(&[
            (8.0 * alpha) as u8,
            (10.0 * alpha) as u8,
            (8.0 * alpha) as u8,
            (255.0 * alpha) as u8,
        ]);
    }
    unsafe {
        GdiAlphaBlend(
            dc,
            r.left,
            r.top,
            r.width(),
            r.height(),
            strip.dc,
            0,
            0,
            1,
            r.height(),
            BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            },
        );
    }
}
fn paint_button(dc: HDC, r: BoxRect, id: i32, state: &UiState, pressed: bool, focused: bool) {
    if matches!(id,PLAY_TAB_ID|TRADE_TAB_ID|HISTORY_TAB_ID|SETTINGS_TAB_ID|FRIENDS_TAB_ID) {
        let mut p = PaintObjects::new();
        let selected = match id {PLAY_TAB_ID=>state.tab==LauncherTab::Play,TRADE_TAB_ID=>state.tab==LauncherTab::Trading,HISTORY_TAB_ID=>state.tab==LauncherTab::History,FRIENDS_TAB_ID=>state.tab==LauncherTab::Friends,_=>state.tab==LauncherTab::Settings};
        fill(dc,&mut p,r,if pressed{INSET}else{BG});
        let count = state.trading.overview.as_ref().map_or(0,|o|o.incoming_count.max(o.unread_count));
        let title = match id {PLAY_TAB_ID=>"PLAY".into(),HISTORY_TAB_ID=>"MATCH HISTORY".into(),SETTINGS_TAB_ID=>"SETTINGS".into(),FRIENDS_TAB_ID if state.friends.incoming>0=>format!("FRIENDS ({})",state.friends.incoming.min(99)),FRIENDS_TAB_ID=>"FRIENDS".into(),_ if count>0=>format!("TRADING ({})",count.min(99)),_=>"TRADING".into()};
        text_row(dc,&mut p,&title,r,14,600,false,if selected{INK}else{mix_color(MUTED,INK,state.hover_amount(id))},SINGLE|DT_CENTER,0);
        if selected { fill(dc,&mut p,box_rect(r.left,r.bottom-2,r.width(),2),BLUE); }
        if focused { unsafe { FrameRect(dc,&r.inset(2).native(),p.brush(BLUE)); } }
        return;
    }
    if id == UPDATE_ID
        && !state
            .snapshot
            .as_ref()
            .is_some_and(|s| s.update_download_url.is_some())
    {
        return;
    }
    let mut p = PaintObjects::new();
    let disabled = (id == PRIMARY_ID && (state.playing || state.pairing || state.account_blocks_play() || state.setup.installing || state.setup.saving))
        || (id == REFRESH_ID && if state.tab == LauncherTab::Trading {state.trading.busy}else if matches!(state.tab,LauncherTab::Settings|LauncherTab::History){state.account.busy}else{state.refreshing&&state.snapshot.is_none()});
    let hovered = state.hovered_button == Some(id);
    let primary = id == PRIMARY_ID;
    let color = if disabled && primary {
        INSET
    } else if id == CLOSE_ID && (hovered || pressed) {
        DESTRUCTIVE
    } else if primary {
        if pressed {
            rgb(88, 142, 210)
        } else {
            mix_color(BLUE,rgb(123,180,255),state.hover_amount(id))
        }
    } else if pressed {
        LINE
    } else if id == DETAILS_ID {
        PANEL
    } else {
        mix_color(BG,INSET,state.hover_amount(id))
    };
    fill(dc, &mut p, r, if id == DETAILS_ID { PANEL } else { BG });
    rounded(dc, r, color, color);
    let ink = if disabled {
        MUTED
    } else if primary {
        BLUE_INK
    } else if matches!(id, NEWS_ID | DETAILS_ID | UPDATE_ID) {
        mix_color(BLUE, BLUE_HOVER, state.hover_amount(id))
    } else if hovered {
        INK
    } else {
        MUTED
    };
    if focused {
        unsafe {
            FrameRect(
                dc,
                &r.inset(3).native(),
                p.brush(if primary { BLUE_INK } else { BLUE }),
            );
        }
    }
    if matches!(id, MINIMIZE_ID | MAXIMIZE_ID | CLOSE_ID | REFRESH_ID) {
        let icon_size=if id==REFRESH_ID{22}else{20};
        icon(
            dc,
            box_rect(
                r.left + (r.width() - icon_size) / 2,
                r.top + (r.height() - icon_size) / 2,
                icon_size,
                icon_size,
            ),
            if id == MAXIMIZE_ID && state.maximized {
                1009
            } else {
                id
            },
            ink,
        );
        return;
    }
    let title = match id {
        PRIMARY_ID => state.primary_label(),
        ACCOUNT_ID => "ACCOUNT",
        DETAILS_ID => state.details_label(),
        NEWS_ID => "READ MORE",
        UPDATE_ID => "DOWNLOAD UPDATE ↗",
        _ => "",
    };
    let mut tr = r.inset(if primary { 12 } else { 5 });
    if primary && state.loading() {
        paint_loading(dc,box_rect(r.left+16,r.top+20,24,24),state,MUTED);
        tr.left+=20;
    } else if primary && !disabled && state.paired && !state.needs_profile() && state.install_ready() {
        icon(
            dc,
            box_rect(r.left + r.width() / 2 - 44, r.top + 20, 24, 24),
            PRIMARY_ID,
            ink,
        );
        tr.left += 28;
    }
    if id == NEWS_ID {
        // Inline link, not a bordered control: lettering then its own arrow.
        tr.left = r.left + 1;
        text_row(dc, &mut p, title, tr, 12, 600, false, ink, SINGLE, 1);
        let arrow = tr.left + text_width(dc, &mut p, title, 12, 600, false, 1) + 4;
        icon(dc, box_rect(arrow, r.top + 5, 14, 14), NEWS_ID, ink);
        return;
    }
    text_row(
        dc,
        &mut p,
        title,
        tr,
        if primary { 20 } else { 12 },
        if primary { 700 } else { 600 },
        false,
        ink,
        SINGLE | DT_CENTER,
        if primary { 3 } else { 1 },
    );
}

fn paint_surface(dc: HDC, width: i32, height: i32, state: &UiState) {
    load_fonts();
    let art = artwork();
    let mut p = PaintObjects::new();
    let l = layout(RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    });
    let snapshot = state.snapshot.as_ref();
    let stale = state.refresh_error.is_some();
    let live = snapshot.is_some() && !stale;
    fill(dc, &mut p, box_rect(0, 0, width, height), BG);
    fill(dc, &mut p, box_rect(0, 0, width, 1), BLUE);
    line(dc, &mut p, 0, 56, width);
    art.wordmark.draw(dc, box_rect(16, 15, 81, 28));
    if width>=1280 {
        fill(dc,&mut p,box_rect(107,17,1,24),LINE);
        text_row(dc,&mut p,"CS:GO CUSTOM CLIENT",box_rect(118,17,143,24),10,400,false,MUTED,SINGLE,1);
    }
    let pop = if live {
        snapshot.unwrap().online_players.to_string()
    } else {
        "—".into()
    };
    let px = width - 424;
    fill(
        dc,
        &mut p,
        box_rect(px, 25, 6, 6),
        if live { GREEN } else { MUTED },
    );
    icon(dc, box_rect(px + 12, 17, 22, 22), 22, MUTED);
    text_row(
        dc,
        &mut p,
        &pop,
        box_rect(px + 40, 13, 110, 19),
        14,
        600,
        true,
        INK,
        SINGLE,
        0,
    );
    caption(
        dc,
        &mut p,
        if live {
            "PLAYERS ONLINE"
        } else if stale {
            "SERVICE OFFLINE"
        } else {
            "NOT CONNECTED"
        },
        box_rect(px + 40, 32, 120, 12),
        MUTED,
    );
    // Compact, content-height identity card; no empty full-height profile rail.
    if state.setup_visible() { paint_setup(dc,width,height,state); }
    else if state.tab == LauncherTab::Play {
    let r = l.profile;
    let x = r.left + 17;
    let cw = r.width() - 34;
    card(dc, &mut p, r);
    let name = snapshot
        .map(|s| s.display_name.as_str())
        .unwrap_or("Your B2G account");
    profile_icon(dc, &mut p, box_rect(x, r.top + 17, 56, 56), snapshot);
    text_row(
        dc,
        &mut p,
        name,
        box_rect(x + 68, r.top + 20, cw - 68, 26),
        18,
        700,
        false,
        INK,
        SINGLE,
        0,
    );
    fill(
        dc,
        &mut p,
        box_rect(x + 68, r.top + 57, 5, 5),
        if state.visible_error().is_some() {
            GOLD
        } else if live {
            GREEN
        } else {
            MUTED
        },
    );
    text_row(
        dc,
        &mut p,
        state.profile_status(),
        box_rect(x + 79, r.top + 46, cw - 79, 26),
        12,
        400,
        false,
        if state.visible_error().is_some() {
            GOLD
        } else if live {
            GREEN
        } else {
            MUTED
        },
        SINGLE,
        0,
    );
    line(dc, &mut p, x, r.top + 89, cw);
    let ry = r.top + 106;
    if let Some(s) = snapshot.filter(|s| (1..=18).contains(&s.rank_id)) {
        art.ranks[s.rank_id as usize - 1].draw(dc, box_rect(x, ry + 17, 56, 22));
    } else {
        text_row(
            dc,
            &mut p,
            "—",
            box_rect(x, ry, 56, 56),
            24,
            400,
            false,
            MUTED,
            SINGLE | DT_CENTER,
            0,
        );
    }
    caption(
        dc,
        &mut p,
        "CURRENT RANK",
        box_rect(x + 68, ry, cw - 68, 16),
        MUTED,
    );
    text_row(
        dc,
        &mut p,
        &snapshot
            .map(|s| s.rank.to_ascii_uppercase())
            .unwrap_or_else(|| "UNRANKED".into()),
        box_rect(x + 68, ry + 16, cw - 68, 22),
        14,
        700,
        false,
        INK,
        SINGLE,
        1,
    );
    let wins = snapshot
        .map(|s| format!("{} wins", s.competitive_wins))
        .unwrap_or("Awaiting profile".into());
    icon(
        dc,
        box_rect(x + 68, ry + 41, 13, 13),
        TROPHY_ICON,
        if snapshot.is_some() { GOLD } else { MUTED },
    );
    text_row(
        dc,
        &mut p,
        &wins,
        box_rect(x + 87, ry + 38, cw - 87, 18),
        11,
        400,
        true,
        MUTED,
        SINGLE,
        0,
    );
    line(dc, &mut p, x, r.top + 178, cw);
    caption(dc, &mut p, "LEVEL", box_rect(x, r.top + 194, 38, 28), MUTED);
    text_row(
        dc,
        &mut p,
        &snapshot
            .map(|s| s.profile_level.to_string())
            .unwrap_or("—".into()),
        box_rect(x + 38, r.top + 190, 45, 32),
        24,
        600,
        true,
        GOLD,
        SINGLE,
        0,
    );
    text_row(
        dc,
        &mut p,
        &snapshot
            .map(|s| format!("{} / 1,000 XP", s.profile_xp))
            .unwrap_or("—".into()),
        box_rect(x + 80, r.top + 198, cw - 80, 22),
        11,
        400,
        true,
        MUTED,
        SINGLE | DT_RIGHT,
        0,
    );
    let progress = snapshot
        .map(|s| {
            if s.profile_level == 40 {
                cw
            } else {
                s.profile_xp as i32 * cw / 1000
            }
        })
        .unwrap_or(0);
    meter(dc, box_rect(x, r.top + 229, cw, 8), progress);
    let next = snapshot
        .map(|s| {
            if s.profile_level == 40 {
                "REDEEM YOUR MEDAL IN GAME".into()
            } else {
                format!(
                    "{} XP TO LEVEL {}",
                    1000 - s.profile_xp,
                    s.profile_level + 1
                )
            }
        })
        .unwrap_or("PROFILE NOT SYNCED".into());
    text_row(dc,&mut p,&next,box_rect(x,r.top+242,cw,18),10,500,false,MUTED,SINGLE|DT_RIGHT,0);

    // The image and typographic hierarchy follow the supplied reference.
    let r = l.news;
    section(dc, &mut p, "LATEST NEWS", box_rect(r.left, r.top, r.width(), 22), 20);
    let hero = box_rect(r.left, r.top + 32, r.width(), r.height() - 130);
    let zoom=if state.reduced_motion(){1.}else{1.+0.05*state.motion.hero.as_ref().map(|t|t.value(std::time::Instant::now())).unwrap_or(0.)};
    art.hero.draw_zoom(dc, hero,zoom);
    hero_scrim(dc, hero);
    unsafe {
        FrameRect(dc, &hero.native(), p.brush(LINE));
    }
    let hx = r.left + 21;
    let hw = r.width() - 42;
    let title = snapshot
        .map(|s| s.news_title.as_str())
        .unwrap_or("Your next match starts here");
    let summary = snapshot
        .map(|s| s.news_summary.as_str())
        .unwrap_or("Connect your account, launch CS:GO and choose a mode in Play.");
    let (summary, sh) = fit_lines(dc, &mut p, summary, hw.min(448), 14, 400, 2);
    let (title, th) = fit_lines(dc, &mut p, title, hw.min(512), 24, 700, 2);
    let sy = hero.bottom - 56 - sh;
    let ty = sy - 8 - th;
    let _ = solid_chip(dc, &mut p, "UPDATE", hx, ty - 28, 19);
    text_row(
        dc,
        &mut p,
        &title,
        box_rect(hx, ty, hw.min(512), th),
        24,
        700,
        false,
        INK,
        DT_WORDBREAK | DT_END_ELLIPSIS,
        0,
    );
    text_row(
        dc,
        &mut p,
        &summary,
        box_rect(hx, sy, hw.min(448), sh),
        14,
        400,
        false,
        MUTED,
        DT_WORDBREAK | DT_END_ELLIPSIS,
        0,
    );
    let tile_y = r.bottom - 86;
    let tw = (r.width() - 12) / 2;
    for (i, (tag, title, summary)) in [
        (
            "PROGRESSION",
            "Service medals",
            "Redeem at level 40 in game.",
        ),
        (
            "CLIENT",
            "Skins in practice",
            "Your inventory follows you into CS:GO.",
        ),
    ]
    .iter()
    .enumerate()
    {
        let tr = box_rect(r.left + i as i32 * (tw + 12), tile_y, tw, 86);
        card(dc, &mut p, tr);
        if state.motion.tile==Some(i){unsafe{FrameRect(dc,&tr.native(),p.brush(mix_color(LINE,BLUE,0.4)));}}
        let thumb = if tw >= 270 { 64 } else { 44 };
        art.map
            .draw(dc, box_rect(tr.left + 11, tr.top + 11, thumb, 64));
        let tx = tr.left + 23 + thumb;
        let available = tr.right - tx - 10;
        caption(
            dc,
            &mut p,
            tag,
            box_rect(tx, tr.top + 10, available, 16),
            BLUE,
        );
        text_row(
            dc,
            &mut p,
            title,
            box_rect(tx, tr.top + 30, available, 22),
            14,
            600,
            false,
            INK,
            SINGLE,
            0,
        );
        text_row(
            dc,
            &mut p,
            summary,
            box_rect(tx, tr.top + 53, available, 19),
            12,
            400,
            false,
            MUTED,
            SINGLE,
            0,
        );
    }

    let r = l.changes;
    let x = r.left + 17;
    let cw = r.width() - 34;
    card(dc, &mut p, r);
    icon(dc, box_rect(x, r.top + 15, 16, 16), 21, BLUE);
    text_row(
        dc,
        &mut p,
        "CHANGELOG",
        box_rect(x + 24, r.top + 12, cw - 24, 22),
        14,
        700,
        false,
        INK,
        SINGLE,
        3,
    );
    line(dc, &mut p, r.left, r.top + 45, r.width());
    let mut y = r.top + 61;
    // One measured chip column keeps the rail's copy aligned across kinds.
    let tagw = chip_width(dc, &mut p, "CHANGED");
    let notes = snapshot
        .map(|s| s.release_history.clone())
        .unwrap_or_else(|| release_history(None));
    if notes.is_empty() {
        text_row(
            dc,
            &mut p,
            "No release notes available. Use Refresh to check again.",
            box_rect(x, y, cw, 72),
            14,
            400,
            false,
            MUTED,
            DT_WORDBREAK,
            0,
        );
    }
    for note in notes.iter().take(3) {
        let version = &note.version;
        let date = &note.date;
        let changes = &note.changes;
        if y + 70 > l.details.top {
            break;
        }
        text_row(
            dc,
            &mut p,
            &format!("v{version}"),
            box_rect(x, y, 100, 22),
            14,
            600,
            true,
            INK,
            SINGLE,
            0,
        );
        text_row(
            dc,
            &mut p,
            date,
            box_rect(r.right - 118, y + 3, 100, 16),
            10,
            500,
            false,
            MUTED,
            SINGLE | DT_RIGHT,
            1,
        );
        y += 30;
        for (kind, copy) in changes {
            // Every kind carries the reference's own text / fill / hairline triad,
            // so a removal never reads as a fix.
            let (color, tint, edge) = match kind.as_str() {
                "added" => (GREEN, GREEN_TINT, GREEN_EDGE),
                "fixed" => (BLUE, BLUE_TINT, BLUE_EDGE),
                "removed" => (ERROR, RED_TINT, RED_EDGE),
                _ => (INK, INSET, LINE),
            };
            let copy_left = x + tagw + 10;
            let copy_width = r.right - 17 - copy_left;
            let row_height = text_height(dc, &mut p, copy, copy_width, 14, 400).min(60);
            if y + row_height > l.details.top - 12 {
                break;
            }
            chip(
                dc,
                &mut p,
                &kind.to_ascii_uppercase(),
                box_rect(x, y + 2, tagw, 16),
                color,
                tint,
                edge,
            );
            text_row(
                dc,
                &mut p,
                copy,
                box_rect(copy_left, y, copy_width, row_height),
                14,
                400,
                false,
                MUTED,
                DT_WORDBREAK | DT_END_ELLIPSIS,
                0,
            );
            y += row_height + 6;
        }
        y += 14;
    }
    // Always show actual worker state. Never fabricate ping or launch progress.
    } else if state.tab==LauncherTab::Trading { paint_trading(dc,width,height,&state.trading); } else if state.tab==LauncherTab::Friends {paint_friends(dc,width,height,state);} else {paint_account(dc,width,height,state);}
    line(dc, &mut p, 0, height - 97, width);
    let f = footer_columns(width, height);
    stat(
        dc,
        &mut p,
        "SERVER REGION",
        snapshot
            .map(|s| s.region.as_str())
            .unwrap_or("Not connected"),
        f.region,
        INK,
        600,
        Some((SIGNAL_ICON, if live { BLUE } else { MUTED })),
        SINGLE,
    );
    if let Some(column) = f.matches {
        stat(
            dc,
            &mut p,
            "LIVE MATCHES",
            &if live {
                snapshot.unwrap().active_matches.to_string()
            } else {
                "—".into()
            },
            column,
            INK,
            600,
            Some((0, if live { GREEN } else { MUTED })),
            SINGLE,
        );
    }
    stat(
        dc,
        &mut p,
        "CLIENT STATUS",
        state.footer_status(),
        f.status,
        if state.visible_error().is_some() {
            ERROR
        } else if live {
            GREEN
        } else {
            MUTED
        },
        FOOTER_STATUS_WEIGHT,
        None,
        DT_WORDBREAK | DT_END_ELLIPSIS,
    );
    text_row(
        dc,
        &mut p,
        &format!("v{}", env!("CARGO_PKG_VERSION")),
        box_rect(f.release.left, f.release.top, f.release.width(), 22),
        12,
        600,
        true,
        INK,
        SINGLE | DT_RIGHT,
        0,
    );
    if !snapshot.is_some_and(|s| s.update_download_url.is_some()) {
        text_row(
            dc,
            &mut p,
            snapshot
                .map(|s| s.update_status.as_str())
                .unwrap_or("RELEASE NOT SYNCED"),
            box_rect(f.release.left, f.release.top + 24, f.release.width(), 24),
            10,
            500,
            false,
            MUTED,
            SINGLE | DT_RIGHT,
            1,
        );
    }
    if state.tab == LauncherTab::Play && !state.setup_visible() {
        line(
            dc,
            &mut p,
            l.changes.left,
            l.details.top - 13,
            l.changes.width(),
        );
    }
    for (id, r) in control_rects(&l, width) {
        if (state.tab != LauncherTab::Play || state.setup_visible()) && matches!(id,DETAILS_ID|NEWS_ID) { continue; }
        paint_button(dc, r, id, state, false, false);
    }
}

fn paint(hwnd: HWND) {
    let mut ps: PAINTSTRUCT = unsafe { std::mem::zeroed() };
    let dc = unsafe { BeginPaint(hwnd, &mut ps) };
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe {
        GetClientRect(hwnd, &mut client);
    }
    if let Some(surface) = Surface::new(client.right, client.bottom) {
        let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
        scale_dc(surface.dc, dpi);
        if let Ok(state) = state().lock() {
            paint_surface(
                surface.dc,
                client.right * 96 / dpi as i32,
                client.bottom * 96 / dpi as i32,
                &state,
            );
        }
        unsafe {
            SetMapMode(surface.dc, MM_TEXT);
            BitBlt(
                dc,
                0,
                0,
                client.right,
                client.bottom,
                surface.dc,
                0,
                0,
                SRCCOPY,
            );
        }
    }
    unsafe {
        EndPaint(hwnd, &ps);
    }
}

fn resize_controls(hwnd: HWND) {
    let l = layout(logical_client(hwnd));
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96) as i32;
    for (id, r) in control_rects(&l, logical_client(hwnd).right) {
        unsafe {
            MoveWindow(
                GetDlgItem(hwnd, id),
                r.left * dpi / 96,
                r.top * dpi / 96,
                r.width() * dpi / 96,
                r.height() * dpi / 96,
                1,
            );
        }
    }
    sync_trade_controls(hwnd);
    sync_account_controls(hwnd);
    sync_friends_controls(hwnd);
    sync_setup_controls(hwnd);
    if state().lock().is_ok_and(|s|s.loading()){start_motion(hwnd);}
}
fn sync_controls(hwnd: HWND) {
    // EnableWindow and SetWindowTextW can synchronously reenter WM_DRAWITEM.
    // Capture values first: the redraw handler needs the same state mutex.
    let (primary_enabled, primary_label, refresh_enabled, update_visible, trading_open, details_name) = {
        let Ok(state) = state().lock() else {
            return;
        };
        (
            !state.playing && !state.pairing && !state.account_blocks_play() && !state.setup.installing && !state.setup.saving,
            state.primary_label().to_owned(),
            if state.tab == LauncherTab::Trading {!state.trading.busy}else if matches!(state.tab,LauncherTab::Settings|LauncherTab::History){!state.account.busy}else{!state.refreshing||state.snapshot.is_some()},
            state
                .snapshot
                .as_ref()
                .is_some_and(|s| s.update_download_url.is_some()),
            state.tab != LauncherTab::Play || state.setup_visible(),
            state.details_control_name(),
        )
    };
    unsafe {
        for id in [DETAILS_ID,NEWS_ID] { ShowWindow(GetDlgItem(hwnd,id),if trading_open{SW_HIDE}else{SW_SHOWNOACTIVATE}); }
        ShowWindow(
            GetDlgItem(hwnd, UPDATE_ID),
            if update_visible {
                SW_SHOWNOACTIVATE
            } else {
                SW_HIDE
            },
        );
    }
    for (id, enabled, name) in [
        (PLAY_TAB_ID,true,"&Play tab"),
        (TRADE_TAB_ID,true,"&Trading tab"),
        (HISTORY_TAB_ID,true,"Match &history tab"),
        (SETTINGS_TAB_ID,true,"&Settings tab"),
        (FRIENDS_TAB_ID,true,"&Friends tab"),
        (PRIMARY_ID, primary_enabled, primary_label.as_str()),
        (REFRESH_ID, refresh_enabled, "&Refresh"),
        (ACCOUNT_ID, true, "&Account"),
        (DETAILS_ID, true, details_name),
        (NEWS_ID, true, "Read &more"),
        (UPDATE_ID, update_visible, "Download &update"),
        (MINIMIZE_ID, true, "Minimize"),
        (
            MAXIMIZE_ID,
            true,
            if unsafe { IsZoomed(hwnd) } != 0 {
                "Restore"
            } else {
                "Maximize"
            },
        ),
        (CLOSE_ID, true, "Close"),
    ] {
        unsafe {
            let child = GetDlgItem(hwnd, id);
            EnableWindow(child, i32::from(enabled));
            SetWindowTextW(child, wide(name).as_ptr());
            InvalidateRect(child, ptr::null(), 0);
        }
    }
    sync_trade_controls(hwnd);
    sync_account_controls(hwnd);
    sync_friends_controls(hwnd);
    sync_setup_controls(hwnd);
    if state().lock().is_ok_and(|s|s.loading()){start_motion(hwnd);}
}
fn create_controls(hwnd: HWND) {
    for (id, name) in [
        (PLAY_TAB_ID,"&Play tab"),
        (TRADE_TAB_ID,"&Trading tab"),
        (HISTORY_TAB_ID,"Match &history tab"),
        (SETTINGS_TAB_ID,"&Settings tab"),
        (FRIENDS_TAB_ID,"&Friends tab"),
        (PRIMARY_ID, "CONNECT ACCOUNT"),
        (REFRESH_ID, "&Refresh"),
        (ACCOUNT_ID, "&Account"),
        (DETAILS_ID, "Release &notes"),
        (NEWS_ID, "Read &more"),
        (UPDATE_ID, "Download &update"),
        (MINIMIZE_ID, "Minimize"),
        (MAXIMIZE_ID, "Maximize"),
        (CLOSE_ID, "Close"),
    ] {
        unsafe {
            let child = CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide(name).as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32,
                0,
                0,
                1,
                1,
                hwnd,
                id as usize as HMENU,
                GetModuleHandleW(ptr::null()),
                ptr::null(),
            );
            if !child.is_null() {
                SetWindowSubclass(child, Some(button_proc), id as usize, 0);
            }
        }
    }
    resize_controls(hwnd);
}

// Keep Windows' button semantics, focus, keyboard and click handling intact.
unsafe extern "system" fn button_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    unsafe {
        match message {
            WM_MOUSEMOVE if IsWindowEnabled(hwnd) != 0 => {
                let changed = if let Ok(mut state) = state().lock() {
                    if state.hovered_button != Some(id as i32) {
                        if let Some(previous)=state.hovered_button {state.animate_hover(previous,false);}
                        state.animate_hover(id as i32,true);
                        state.hovered_button = Some(id as i32);
                        if id as i32==NEWS_ID {state.animate_hero(true);}
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if changed {
                    start_motion(GetParent(hwnd));
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    TrackMouseEvent(&mut track);
                    InvalidateRect(hwnd, ptr::null(), 0);
                }
            }
            WM_MOUSELEAVE | WM_NCDESTROY => {
                if let Ok(mut state) = state().lock() {
                    if state.hovered_button == Some(id as i32) {
                        state.animate_hover(id as i32,false);
                        state.hovered_button = None;
                        if id as i32==NEWS_ID {state.animate_hero(false);}
                    }
                }
                InvalidateRect(hwnd, ptr::null(), 0);
                if message!=WM_NCDESTROY{start_motion(GetParent(hwnd));}
                if message == WM_NCDESTROY {
                    RemoveWindowSubclass(hwnd, Some(button_proc), id);
                }
            }
            WM_SETCURSOR if IsWindowEnabled(hwnd) != 0 => {
                SetCursor(LoadCursorW(ptr::null_mut(), IDC_HAND));
                return 1;
            }
            _ => {}
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}
fn details_text() -> String {
    let value = if let Ok(state) = state().lock() {
        let launch_help = state.action_error.as_ref().map(|error| {
            format!("Launch help\n\n{error}\n\nAfter resolving this, press Play to try again.\n\n")
        }).unwrap_or_default();
        let profile = state.snapshot.as_ref().map(|s| format!("{}\n{} · {} rating · {} wins\nLevel {} · {} / 1,000 XP\n\n{}\n{}\n\n{}\n{}\n\n", s.display_name, s.rank, s.rating, s.competitive_wins, s.profile_level, s.profile_xp, s.news_title, s.news_summary, s.changelog_title, s.changelog_summary)).unwrap_or_default();
        let history = state
            .snapshot
            .as_ref()
            .map(|s| s.release_history.clone())
            .unwrap_or_else(|| release_history(None))
            .iter()
            .map(|n| {
                format!(
                    "v{} · {}\n{}",
                    n.version,
                    n.date,
                    n.changes
                        .iter()
                        .map(|(kind, text)| format!("{}: {}", kind, text))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!(
            "{launch_help}{profile}{history}\n\n{}\n\n{}\n\nUse Refresh to retry account synchronization. Use Play to retry a failed launch. It checks and repairs managed game files before starting. For a separate repair, close CS:GO and run: b2g-launcher.exe game-repair.\n\nAn available update can be downloaded from the launch bar. Close CS:GO and the old launcher before running the new file.\n\nDiagnostic log:\n{}",
            state.footer_status(),
            state
                .visible_error()
                .unwrap_or("No launcher errors reported."),
            crate::launcher_log_path()
                .map(|path| path.display().to_string())
                .unwrap_or("Log path unavailable".into())
        )
    } else {
        "Launcher state is unavailable. Please reopen the launcher.".into()
    };
    value
}

include!("details.rs");

#[cfg(test)]
#[path = "render_tests.rs"]
mod render_tests;

// Native watchdogs own real offscreen windows. Serialize their child processes
// so activation of one fixture's details window cannot affect another fixture.
#[cfg(test)]
static NATIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
#[path = "window_tests.rs"]
mod window_tests;

#[cfg(test)]
#[path = "trading_tests.rs"]
mod trading_tests;
#[cfg(test)]
#[path = "account_tests.rs"]
mod account_tests;
#[cfg(test)]
#[path = "setup_tests.rs"]
mod setup_tests;
