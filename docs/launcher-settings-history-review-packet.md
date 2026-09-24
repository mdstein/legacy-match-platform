# Launcher 0.2.30: required finish-review packet

Root: `C:/Users/max/Desktop/goagain`.

## Request and direction

The owner requested: hide the launcher's console by default with a debug toggle;
add Settings and Match History tabs to make routine use independent of the site;
make Trading's automatic updates fluid; improve the rough drawn controls/icons;
reduce the level requirement from 5,000 to 1,000 XP. They explicitly chose to
keep all existing XP and receive newly earned levels. Normal rewards accompany
those levels; XP beyond level 40 is reserved for medal redemption.

This is an Operate extension of the incumbent Rust/Win32 launcher, preserving
Rajdhani, Geist Mono, near-black fields and CT blue. Authority is
`apps/launcher/DESIGN.md` and the existing Play/Trading code. No new concept or
replacement comp: the user requested additions and refinement. The header now
has four tabs; every tab preserves the running-game footer and Play action.

Settings includes account/access, matchmaking region/mode/party invites,
privacy/notifications/motion, logs, diagnostics, repair and console viewing.
Settings edits survive navigation and save through launcher bearer routes.
History includes both modes, eight-row pagination, results/stats, selectable
details and verified demo downloads. Steam authorization remains a browser flow.

## Artifact and scope

Primary: `apps/launcher/src/launcher_ui/{account,icons,account_tests}.rs`.
Shared: `launcher_ui.rs`, `launcher_ui/{drawing,trading,details}.rs`,
`src/{console,trading}.rs`. Backend routes are in `apps/api/src/app.ts`.

Read-only review of Settings, History, the revised header/icons, and Trading's
refresh behavior. No real account writes, game launches, deployments or product
edits. No HTML/CSS detector ran: this is native Win32/GDI. No iOS/Android spec
applies. Floor: `.agents/skills/impeccable/reference/craft-floor.md`.
Workflow: `.agents/skills/impeccable/reference/new-work.md`, final review section.

## Evidence and validity

All required images are enumerated in
`apps/launcher/.impeccable/review/account-history/screenshots.json`.
There are 80 captures: four Settings sections, History and empty History at
1024×664, 1280×780 and 1360×800 with 96/120/144/192 DPI (72), four compact edge
states, and four real HWND captures. `contact-0.png` through `contact-6.png`
index every image. Use the individual files for text and control assessment.

The matrix uses the production GDI painter in memory. Native captures use actual
offscreen windows and real BUTTON children at this host's 125% DPI. Synthetic
accounts and an isolated loopback server supply data; no real player activity is
claimed. The native journey saves preferences, changes tabs during a pending
save, pages history, opens match details, and checks the repair lock during a
running game. A fixture-only correction uses the real GameReady transition and
complete scoreboard fields for representative native captures.

The builder's two bounded inspection rounds are complete. The first found
missing selection affordances and thin icons; the second confirmed dropdown
chevrons, enlarged curved icons, and the complete size matrix. The native details
window intentionally retains Windows chrome, scrollbars and selectable text.
The review should judge refresh-icon legibility and loading-state copy closely.

## Verification and quality bar

- Native launcher library checks currently pass: 109 tests; three watchdog child
  entrypoints are intentionally ignored and exercised by parent tests.
- The GUI PE subsystem and redirected CLI/version output passed executable tests.
- An independent debug-console process closes when its fixture parent exits.
  The launcher never hides or detaches the user's own terminal.
- Automatic Trading checks do not set foreground busy, disable controls or
  repaint unchanged results. View/window/request fences discard stale results.
- API authorization, strict settings fields and owner-bound history were tested.
- Game GC suite: 8/8; final client archive patch and 390 Unlock/Escape regression
  pass. XP conversion rollback/repeatability/rewards/carry-over test passes.

Quality bar: every requested control is discoverable, works without disturbing
an active game, fits all supported widths/DPI, retains keyboard behavior and
focus, and uses truthful loading/error/empty states. Refine the established
launcher rather than adding a browser runtime or decorative dashboard features.

Please return the required five review-contract sections and a clear disposition
(ship/fix/recapture/rebuild), with concrete file/image evidence for material
findings. Any fixes must be bounded and justified by this request.
