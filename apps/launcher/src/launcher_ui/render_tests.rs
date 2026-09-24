use super::*;

pub(super) fn fixture() -> UiState {
    let snapshot = snapshot_from_bootstrap(&serde_json::json!({
        "player": { "displayName": "cubsfan49", "region": "NA Central", "rank": { "name": "Global Elite", "rating": 2500 } },
        "gameProfile": { "competitiveRankId": 18, "competitiveWins": 24, "playerLevel": 4, "playerXp": 400 },
        "platform": { "onlinePlayers": 12, "activeMatches": 2 },
        "launcher": { "content": {
            "releaseVersion": env!("CARGO_PKG_VERSION"), "channel": "Founders Playtest",
            "news": { "title": "The original menu. A new beginning.", "summary": "Keep your owned skins, equip your loadout and queue from inside Panorama. Competitive and Dust II Deathmatch are ready in Play." },
            "changelog": { "title": "In-game inventory sync", "summary": "Inventory updates preserve your loadout and acknowledged items between sessions." }
        } }
    })).unwrap();
    let mut state = UiState::default();
    state.apply_event(UiEvent::Refreshed(Ok(snapshot)));
    state
}

#[test]
fn layout_keeps_all_controls_inside_supported_client_sizes() {
    for (width, height) in [(1024, 664), (1280, 780), (1600, 960), (1920, 1080)] {
        let l = layout(RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        });
        let f = footer_columns(width, height);
        for r in control_rects(&l, width)
            .iter()
            .map(|(_, r)| *r)
            .chain([l.profile, l.news, l.changes])
            .chain([f.region, f.status, f.release])
            .chain(f.matches)
        {
            assert!(r.left >= 0 && r.top >= 0 && r.right <= width && r.bottom <= height);
            assert!(r.width() > 0 && r.height() > 0);
        }
        assert!(l.profile.right < l.news.left && l.news.right < l.changes.left);
        assert!(l.news.bottom < l.primary.top);
        // The play bar's columns run left to right without colliding.
        let columns: Vec<BoxRect> = [Some(f.region), f.matches, Some(f.status)]
            .into_iter()
            .flatten()
            .collect();
        for pair in columns.windows(2) {
            assert!(
                pair[0].right <= pair[1].left,
                "{width}px: play bar columns overlap"
            );
        }
        assert!(f.status.right <= f.release.left);
        assert!(l.primary.right < f.region.left);
        // The nav strip clears the header's live counter at every supported width.
        let nav_end = control_rects(&l, width)[3].1.right;
        assert!(
            nav_end + 24 <= width - 424,
            "{width}px: nav collides with the header counter"
        );
    }
}

#[test]
fn bundled_art_is_complete_and_rank_ids_are_authoritative() {
    let art = artwork();
    assert_eq!(art.ranks.len(), 18);
    assert_eq!(art.wordmark.width, 260);
    assert_eq!(fixture().snapshot.unwrap().rank_id, 18);
    let snapshot = snapshot_from_bootstrap(&serde_json::json!({"player":{}, "gameProfile":{"competitiveRankId":999, "competitiveWins":24}, "platform":{}})).unwrap();
    assert_eq!(snapshot.rank_id, 0);
    assert_eq!(snapshot.competitive_wins, 24);
}

#[test]
fn measured_heading_boxes_fit_both_required_lines_at_every_dpi() {
    load_fonts();
    for (width, dpi) in [(1024, 96), (1360, 96), (1280, 144), (1280, 192)] {
        let surface = Surface::new(width * dpi / 96, 800 * dpi / 96).unwrap();
        scale_dc(surface.dc, dpi as u32);
        let l = layout(RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: 800,
        });
        let mut p = PaintObjects::new();
        // The changelog's copy column is measured from its own chip now.
        let copy_column = l.changes.width() - 27 - chip_width(surface.dc, &mut p, "CHANGED");
        for (title, size, w) in [
            ("Your inventory now grows in B2G", 24, l.news.width() - 42),
            (
                "StatTrak synchronization and server scheduling.",
                14,
                copy_column,
            ),
        ] {
            let allocated = heading_height(surface.dc, &mut p, size, 2);
            let mut measured = box_rect(0, 0, w, allocated).native();
            let mut title = wide(title);
            unsafe {
                let previous = SelectObject(surface.dc, p.font(size, true, false) as HGDIOBJ);
                DrawTextW(
                    surface.dc,
                    title.as_mut_ptr(),
                    (title.len() - 1) as i32,
                    &mut measured,
                    DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX,
                );
                SelectObject(surface.dc, previous);
            }
            assert!(
                measured.bottom <= allocated,
                "{width}px/{dpi}dpi: heading needs {} but has {allocated}",
                measured.bottom
            );
        }
    }
}

#[test]
fn long_news_and_recovery_use_whole_lines_at_every_scale() {
    load_fonts();
    for dpi in [96, 120, 144, 192] {
        let surface = Surface::new(1024 * dpi / 96, 664 * dpi / 96).unwrap();
        scale_dc(surface.dc, dpi as u32);
        let mut p = PaintObjects::new();
        let copy = "This deliberately lengthy service announcement checks the compact layout. Full text remains available through Read More without any changes to the signed in account or session.";
        let (fitted, height) = fit_lines(surface.dc, &mut p, copy, 404, 14, 400, 2);
        let line = text_height(surface.dc, &mut p, "Ag", 404, 14, 400);
        assert!(fitted.ends_with('…'));
        assert_eq!(height, 2 * line);
        assert!(text_height(surface.dc, &mut p, &fitted, 404, 14, 400) <= height);
        let mut state = fixture();
        // Measure the column the play bar actually paints, at every supported width.
        for error in ["Long technical error", crate::FACEIT_LAUNCH_BLOCK] {
        state.action_error = Some(error.into());
        for (width, height) in [(1024, 664), (1280, 780), (1600, 960), (1920, 1080)] {
            let status = footer_columns(width, height).status;
            assert!(
                text_height(
                    surface.dc,
                    &mut p,
                    state.footer_status(),
                    status.width(),
                    14,
                    FOOTER_STATUS_WEIGHT,
                ) <= status.height() - 16,
                "{width}px: recovery copy overflows CLIENT STATUS"
            );
        }
        }
    }
}

// Pure memory rendering: no HWND, desktop capture, credentials, worker, network, or game.
// Optional render output goes only to an explicitly provided test directory.
#[test]
fn render_dashboard_states_offscreen() {
    let ready = fixture();
    let mut starting = ready.clone();
    starting.begin_play();
    let mut running = starting.clone();
    running.apply_event(UiEvent::GameReady);
    let mut failed = ready.clone();
    failed.action_error = Some("Could not start CS:GO. Close the existing game instance and press Play to retry. Diagnostic details are available in the launcher log.".into());
    let mut faceit = ready.clone();
    faceit.action_error = Some(crate::FACEIT_LAUNCH_BLOCK.into());
    let mut stale = ready.clone();
    stale.apply_event(UiEvent::Refreshed(Err("Service temporarily unavailable. Use Refresh to retry; your last synchronized profile is shown.".into())));
    let mut pairing = UiState::default();
    pairing.begin_pair();
    let mut long = ready.clone();
    let s = long.snapshot.as_mut().unwrap();
    s.display_name = "A very long player name & nickname 日本語".into();
    s.news_title = "A longer news headline & a literal ampersand for the client".into();
    s.news_summary = "This deliberately lengthy service announcement checks the compact layout. Full text remains available through Read More without any changes to the signed in account or session.".into();
    s.changelog_title = "A long platform change with more information than usual".into();
    s.changelog_summary = s.news_summary.clone();
    s.rank = "Distinguished Master Guardian".into();
    s.rank_id = 14;
    let mut hover_go = ready.clone();
    hover_go.hovered_button = Some(PRIMARY_ID);
    let mut hover_account = ready.clone();
    hover_account.hovered_button = Some(ACCOUNT_ID);
    let mut exited = ready.clone();
    exited.apply_event(UiEvent::SessionFinished(Ok(
        "CS:GO closed. Press Play when you are ready.".into(),
    )));
    let mut repair = ready.clone();
    repair.action_error=Some("CS:GO installation needs repair. Close CS:GO, then press Play to check and repair managed files. Full diagnostics are in Release Notes.".into());
    let mut update = ready.clone();
    update.snapshot.as_mut().unwrap().update_status = "UPDATE AVAILABLE · v0.2.99".into();
    update.snapshot.as_mut().unwrap().update_download_url =
        Some("https://play.back2go.net/downloads/b2g-launcher-v0.2.99-windows-x86_64.exe".into());
    let mut medal = ready.clone();
    medal.snapshot.as_mut().unwrap().profile_level = 40;
    medal.snapshot.as_mut().unwrap().profile_xp = 0;
    let mut empty = ready.clone();
    empty.snapshot=Some(snapshot_from_bootstrap(&serde_json::json!({"player":{},"gameProfile":{},"platform":{},"launcher":{"content":{"history":[]}}})).unwrap());
    let mut cases = vec![
        ("faceit".to_string(), 1024, 664, 96, faceit.clone()),
        ("faceit-hidpi".to_string(), 1280, 780, 192, faceit),
        ("exited".to_string(), 1280, 780, 96, exited),
        ("repair".to_string(), 1024, 664, 96, repair),
        ("update".to_string(), 1280, 780, 96, update),
        ("level40".to_string(), 1024, 664, 96, medal),
        ("empty".to_string(), 1024, 664, 96, empty),
    ];
    for (w, h) in [(1024, 664), (1280, 780), (1360, 800)] {
        for dpi in [96, 120, 144, 192] {
            cases.push((format!("matrix-{w}x{h}-{dpi}"), w, h, dpi, ready.clone()));
        }
    }
    cases.extend(
        [
            ("ready", 1360, 800, 96, ready.clone()),
            ("compact", 1024, 664, 96, ready.clone()),
            ("hidpi", 1280, 780, 144, ready.clone()),
            ("signed-out", 1280, 780, 96, UiState::default()),
            ("starting", 1280, 780, 96, starting),
            ("running", 1280, 780, 96, running),
            ("error", 1024, 664, 96, failed),
            ("stale", 1280, 780, 96, stale),
            ("pairing", 1280, 780, 96, pairing),
            ("long", 1024, 664, 96, long),
            ("hover-go", 1280, 780, 96, hover_go),
            ("hover-account", 1280, 780, 96, hover_account),
        ]
        .into_iter()
        .map(|(name, w, h, dpi, state)| (name.to_string(), w, h, dpi, state)),
    );
    for (name, w, h, dpi, state) in cases {
        let surface = Surface::new(w * dpi / 96, h * dpi / 96).expect("Off-screen DIB allocation");
        scale_dc(surface.dc, dpi as u32);
        paint_surface(surface.dc, w, h, &state);
        // Exercise the same pressed/focus painter used by native owner-drawn buttons.
        if name == "pairing" {
            paint_button(
                surface.dc,
                layout(RECT {
                    left: 0,
                    top: 0,
                    right: w,
                    bottom: h,
                })
                .account,
                ACCOUNT_ID,
                &state,
                true,
                true,
            );
        }
        unsafe {
            GdiFlush();
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(surface.bits, (surface.width * surface.height * 4) as usize)
        };
        assert!(
            bytes.chunks_exact(4).any(|pixel| pixel[0] > 220),
            "{name}: expected rendered foreground"
        );
        assert!(
            bytes
                .chunks_exact(4)
                .any(|pixel| pixel[0] == 8 && pixel[1] == 10 && pixel[2] == 8),
            "{name}: expected background"
        );
        if let Some(directory) = std::env::var_os("B2G_RENDER_TEST_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            let mut output = Vec::with_capacity(8 + bytes.len());
            output.extend_from_slice(&(surface.width as u32).to_le_bytes());
            output.extend_from_slice(&(surface.height as u32).to_le_bytes());
            output.extend_from_slice(bytes);
            std::fs::write(directory.join(format!("{name}.bgra")), output).unwrap();
        }
    }
}
