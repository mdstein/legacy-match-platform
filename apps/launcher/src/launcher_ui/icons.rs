// A single optical size and stroke system. Every glyph is a stroked polyline on
// a 24-unit grid, evaluated as a distance field at the destination's own device
// resolution. Rendering at the final size keeps the antialiasing band exactly
// one pixel wide and means no stretching blit resamples the result, which is
// what left the earlier icons looking chipped at 16-22px and on high-DPI.

/// Device pixels per logical unit for this DC's mapping mode.
fn dc_scale(dc: HDC) -> f32 {
    let mut window: windows_sys::Win32::Foundation::SIZE = unsafe { std::mem::zeroed() };
    let mut viewport: windows_sys::Win32::Foundation::SIZE = unsafe { std::mem::zeroed() };
    unsafe {
        if windows_sys::Win32::Graphics::Gdi::GetWindowExtEx(dc, &mut window) == 0
            || windows_sys::Win32::Graphics::Gdi::GetViewportExtEx(dc, &mut viewport) == 0
        {
            return 1.0;
        }
    }
    if window.cx == 0 {
        return 1.0;
    }
    (viewport.cx as f32 / window.cx as f32).clamp(0.5, 8.0)
}

/// Points along a circular arc, in degrees, clockwise on screen.
fn arc(cx: f32, cy: f32, radius: f32, start: f32, end: f32) -> Vec<(f32, f32)> {
    let steps = (((end - start).abs() / 6.0).ceil() as usize).clamp(8, 96);
    (0..=steps)
        .map(|i| {
            let a = (start + (end - start) * i as f32 / steps as f32).to_radians();
            (cx + radius * a.cos(), cy + radius * a.sin())
        })
        .collect()
}

fn stroke_radius(kind: i32) -> f32 {
    match kind {
        // Window chrome carries a lighter stroke than the content glyphs.
        MINIMIZE_ID | MAXIMIZE_ID | CLOSE_ID | 1009 => 0.75,
        // A filled disc is a zero-length segment with the disc's own radius.
        DOT_ICON => 4.4,
        // A solid arrowhead needs no stroke; its edge is the polygon itself.
        PRIMARY_ID => 0.0,
        _ => 0.95,
    }
}

fn glyph(kind: i32) -> Vec<Vec<(f32, f32)>> {
    match kind {
        // rotate-cw: a near-closed ring with its own arrowhead bracket.
        REFRESH_ID => vec![
            arc(12., 12., 9., 0., 317.),
            vec![(18.74, 5.74), (21., 8.)],
            vec![(21., 3.), (21., 8.), (16., 8.)],
        ],
        MINIMIZE_ID => vec![vec![(5., 12.), (19., 12.)]],
        MAXIMIZE_ID => vec![vec![(5., 5.), (19., 5.), (19., 19.), (5., 19.), (5., 5.)]],
        1009 => vec![
            vec![(5., 8.), (16., 8.), (16., 19.), (5., 19.), (5., 8.)],
            vec![(9., 5.), (19., 5.), (19., 15.)],
        ],
        CLOSE_ID => vec![vec![(6., 6.), (18., 18.)], vec![(18., 6.), (6., 18.)]],
        NEWS_ID => vec![
            vec![(6., 18.), (18., 6.)],
            vec![(7., 6.), (18., 6.), (18., 17.)],
        ],
        // chevron-down
        30 => vec![vec![(6., 9.5), (12., 15.5), (18., 9.5)]],
        // play: the one solid glyph, so its edge is the polygon itself.
        PRIMARY_ID => vec![vec![(7., 4.), (19.5, 12.), (7., 20.), (7., 4.)]],
        // newspaper
        20 => vec![
            vec![(4., 6.), (17., 6.), (17., 20.), (4., 20.), (4., 6.)],
            vec![(17., 9.), (20., 9.), (20., 17.5)],
            arc(17.75, 17.5, 2.25, 0., 180.),
            vec![(7.5, 10.), (13.5, 10.)],
            vec![(7.5, 13.5), (13.5, 13.5)],
            vec![(7.5, 17.), (11., 17.)],
        ],
        // git-commit-vertical: the changelog mark used by the reference.
        21 => vec![
            arc(12., 12., 3.4, 0., 360.),
            vec![(12., 2.), (12., 8.6)],
            vec![(12., 15.4), (12., 22.)],
        ],
        // users: one figure in front, one behind.
        22 => vec![
            arc(9., 7., 4., 0., 360.),
            vec![(16., 21.), (16., 19.)],
            arc(12., 19., 4., 270., 360.),
            vec![(6., 15.), (12., 15.)],
            arc(6., 19., 4., 180., 270.),
            vec![(2., 19.), (2., 21.)],
            vec![(22., 21.), (22., 19.)],
            arc(18., 19., 4., 284., 360.),
            arc(15.9, 7., 3.9, -80., 80.),
        ],
        // trophy: the gold competitive-wins mark on the profile card.
        TROPHY_ICON => vec![
            vec![(7., 4.), (17., 4.)],
            vec![(7., 4.), (7., 9.)],
            vec![(17., 4.), (17., 9.)],
            arc(12., 9., 5., 0., 180.),
            vec![(12., 14.), (12., 18.5)],
            vec![(7.5, 20.), (16.5, 20.)],
            arc(6.4, 6.4, 2.6, 100., 260.),
            arc(17.6, 6.4, 2.6, -80., 80.),
        ],
        // signal: the play bar's server-region mark.
        SIGNAL_ICON => vec![
            arc(12., 19., 10.5, 202., 338.),
            arc(12., 19., 6.5, 202., 338.),
            arc(12., 19., 2.6, 202., 338.),
            arc(12., 19., 0.35, 0., 360.),
        ],
        // A round selection ring and its filled centre, for native radio rows.
        RADIO_ICON => vec![arc(12., 12., 8.4, 0., 360.)],
        DOT_ICON => vec![vec![(12., 12.), (12., 12.)]],
        _ => vec![],
    }
}

/// Premultiplied BGRA for one glyph at an exact device size.
fn rasterize(
    paths: &[Vec<(f32, f32)>],
    radius: f32,
    filled: bool,
    sx: i32,
    sy: i32,
    color: COLORREF,
) -> Vec<u8> {
    let segments: Vec<_> = paths
        .iter()
        .flat_map(|path| path.windows(2).map(|pair| (pair[0], pair[1])))
        .collect();
    // One device pixel, in grid units: the antialiasing band's width.
    let unit = 24.0 / sx.max(1) as f32;
    let mut pixels = vec![0u8; (sx * sy * 4) as usize];
    for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let x = (index as i32 % sx) as f32 * 24.0 / sx as f32 + unit / 2.0;
        let y = (index as i32 / sx) as f32 * 24.0 / sy as f32 + (24.0 / sy as f32) / 2.0;
        let mut distance = f32::MAX;
        let mut crossings = 0u32;
        for &((ax, ay), (bx, by)) in &segments {
            let (vx, vy) = (bx - ax, by - ay);
            let length = vx * vx + vy * vy;
            let t = if length > 0.0 {
                ((x - ax) * vx + (y - ay) * vy) / length
            } else {
                0.0
            }
            .clamp(0.0, 1.0);
            distance = distance.min(((x - ax - t * vx).powi(2) + (y - ay - t * vy).powi(2)).sqrt());
            // Even-odd crossings, so a closed path can be filled as well as stroked.
            if filled && (ay > y) != (by > y) && x < ax + (y - ay) / (by - ay) * vx {
                crossings += 1;
            }
        }
        let reach = if filled && crossings % 2 == 1 {
            radius + distance
        } else {
            radius - distance
        };
        let alpha = (reach / unit + 0.5).clamp(0.0, 1.0);
        pixel.copy_from_slice(&[
            ((color >> 16 & 255) as f32 * alpha) as u8,
            ((color >> 8 & 255) as f32 * alpha) as u8,
            ((color & 255) as f32 * alpha) as u8,
            (255.0 * alpha) as u8,
        ]);
    }
    pixels
}

fn blit_glyph(dc: HDC, r: BoxRect, sx: i32, sy: i32, pixels: &[u8]) {
    let Some(surface) = Surface::new(sx, sy) else {
        return;
    };
    let target = unsafe { std::slice::from_raw_parts_mut(surface.bits, pixels.len()) };
    target.copy_from_slice(pixels);
    unsafe {
        GdiAlphaBlend(
            dc,
            r.left,
            r.top,
            r.width(),
            r.height(),
            surface.dc,
            0,
            0,
            sx,
            sy,
            BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            },
        );
    }
}

/// Device dimensions for a logical rect, so the glyph is never resampled.
fn glyph_size(dc: HDC, r: BoxRect) -> (i32, i32) {
    let scale = dc_scale(dc);
    (
        ((r.width() as f32 * scale).round() as i32).clamp(1, 512),
        ((r.height() as f32 * scale).round() as i32).clamp(1, 512),
    )
}

/// One procedural shape, drawn without touching the glyph cache. Used by the
/// spinner, whose geometry changes every frame.
fn stroke(dc: HDC, r: BoxRect, paths: &[Vec<(f32, f32)>], radius: f32, color: COLORREF) {
    let (sx, sy) = glyph_size(dc, r);
    blit_glyph(dc, r, sx, sy, &rasterize(paths, radius, false, sx, sy, color));
}

fn icon(dc: HDC, r: BoxRect, kind: i32, color: COLORREF) {
    static CACHE: OnceLock<Mutex<std::collections::BTreeMap<(i32, COLORREF, i32, i32), Vec<u8>>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::BTreeMap::new()));
    let (sx, sy) = glyph_size(dc, r);
    let key = (kind, color, sx, sy);
    let cached = cache.lock().ok().and_then(|cache| cache.get(&key).cloned());
    let pixels = cached.unwrap_or_else(|| {
        let pixels = rasterize(
            &glyph(kind),
            stroke_radius(kind),
            kind == PRIMARY_ID,
            sx,
            sy,
            color,
        );
        if let Ok(mut cache) = cache.lock() {
            if cache.len() > 192 {
                cache.clear();
            }
            cache.insert(key, pixels.clone());
        }
        pixels
    });
    blit_glyph(dc, r, sx, sy, &pixels);
}
