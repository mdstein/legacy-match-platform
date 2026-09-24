# Tauri launcher migration

The owner requested replacement of the custom Win32 interface with Tauri, keeping
the supplied launcher reference and every existing feature. The runtime and
backend contract must preserve installation, credentials, in-game inventory and
matchmaking, account setup/settings, match demos, friends/profiles and exact
trade consent/recovery.

Implementation sequence:

1. Embed a local React interface in the existing Rust executable. Keep credentials,
   network authorization, installation and game integration outside the webview.
2. Add durable in-process session state and guarded worker commands. Show real
   startup, running, closed and failed states even after a frontend reload.
3. Build a shared responsive shell with measured text, consistent SVG icons,
   stable scroll regions, quiet data refresh and reduced-motion support.
4. Simplify Trading to player discovery, two-sided selection, exact review and
   explicit commitment. Preserve gift confirmation, ownership fingerprints,
   StatTrak reset disclosure, revisions and persisted request recovery.
5. Migrate Play, first-run setup, Settings, History and Friends with feature parity.
6. Verify flows, error/empty states, keyboard/focus behavior, responsive clipping,
   motion, actual Tauri startup and unchanged backend tests. Finish independent
   visual review and update the launcher design documentation.
7. Build and publish a versioned launcher, verify public bytes, install locally
   when the game is closed, and commit/push the completed changes.

No invented player data ships. Synthetic accounts are confined to test fixtures.

## Implemented in 0.2.39

The production Windows entry point now opens Tauri 2. The former Win32 painter
is compiled only for its retained regression tests. React, fonts and images are
bundled locally; no remote website is loaded as the launcher interface.

Rust owns credentials, authenticated requests, setup/repair/uninstall, game
sessions and the existing trade recovery journal. A bounded command bridge
exposes these operations to the interface. Starting, running, failed and closed
states persist independently of the webview. A single-instance plugin focuses
the existing window; the close guard protects an active owned game session.

Play, Trading, Match History, Friends/profiles and Settings share a responsive
shell. DOM text and SVG icons replace the custom glyph painter. Visited tabs
retain drafts and scroll positions; background refresh keeps existing content
visible. In-flight requests are deduplicated, hidden tabs stop polling, and
cache generations prevent an old account response from filling a new session.
Motion respects both operating-system and account preferences.

Trading separates player discovery, two-sided item selection and exact review.
Selection chips remain available across inventory searches/pages. Review and
commit actions occupy a reserved row below scrolling content. The API still
checks ownership fingerprints, item changes and offer revisions; gifts require
explicit consent, StatTrak resets remain disclosed, and uncertain mutations
retain their original request identity until recovery resolves them.

First-run setup includes Steam installation progress, browser-based Steam
authorization and in-launcher B2G profile completion. Signed-out users can still
open launcher settings for diagnostics, repair and uninstall. Existing user
settings, demos and game data carry over. Missing WebView2 uses Microsoft's
publisher-verified bootstrapper; a full browser is not bundled in the EXE.

## Verification

- 14 Playwright tests pass, covering launch states/reload/slow polling, settings
  drafts, account switching, setup, friends/profile privacy, match details and
  demos, trade consent/recovery, keyboard focus, reduced motion and resizing.
- 16 browser captures cover five tabs, profiles, trade compose and review at
  1360×820 and 960×640. The independent finish reviewer accepted the three
  requested trading layout fixes after one correction batch. That verdict is
  limited to those fixes and does not certify native input/rendering.
- 134 Rust tests pass; five existing interactive/manual cases remain ignored.
  The bridge tests cover persistent launch state, command validation and real
  loopback HTTP behavior without exposing a bearer to JavaScript.
- 212 JavaScript unit tests and 97 isolated PostgreSQL integration tests pass.
  The production dependency audit reports zero vulnerabilities.
- The actual Windows executable connected its bundled interface to Rust and
  loaded the existing authenticated account. A second invocation exited and
  reused the first window. This is startup/IPC evidence, not gameplay acceptance.
- Native update verification accepted the trusted Windows signing fixture and
  rejected the wrong publisher. Microsoft's current 1,783,000-byte WebView2
  bootstrapper downloaded successfully with a valid Microsoft Corporation
  signature; missing-runtime installation itself was not exercised on this PC.

Evidence is retained under `.artifacts/tauri-polish-20260908/` and the local
`apps/launcher/.impeccable/review/tauri/` capture directory. The supported native
automation connection was unavailable, so native visual/input acceptance, a
real game launch through this new interface, and first-time WebView2 installation
remain manual acceptance checks. No production trade or account mutation was
performed for these tests.

## Release

The immutable 0.2.39 Windows artifact is 13,620,736 bytes with SHA-256
`a74ea191385f1ec3289d29b1513f19037ee0e133c9603386a657cf8d67d8c3db`.
The installed per-user executable was checked against that digest and reports
`B2G Launcher 0.2.39`. API/web publication uses the existing rollback-protected
host release flow; no database migration or game-node update is required.
