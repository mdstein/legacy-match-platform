---
name: B2G Tauri Launcher
description: A quiet, image-led CS:GO home with persistent Play, owned inventory and exact-item exchange.
colors:
  ct-blue: "#70a4e8"
  ct-blue-hover: "#86b6f2"
  ct-blue-ink: "#142030"
  connected: "#68cea0"
  error: "#ffaaa2"
  field: "#080a08"
  panel: "#101211"
  inset: "#1e201e"
  line: "#292c2a"
  ink: "#f3f2ef"
  muted: "#a0a5a3"
typography:
  display:
    fontFamily: "Rajdhani, Segoe UI, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.15
  headline:
    fontFamily: "Rajdhani, Segoe UI, sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.2
  title:
    fontFamily: "Rajdhani, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Rajdhani, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.45
  label:
    fontFamily: "Rajdhani, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  primary:
    fontFamily: "Rajdhani, Segoe UI, sans-serif"
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0.12em"
  metadata:
    fontFamily: "Geist Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  control: "5px"
  small: "3px"
  badge: "4px"
  dialog: "8px"
  square: "0px"
spacing:
  tight: "4px"
  small: "8px"
  action-gap: "10px"
  compact: "12px"
  gutter: "16px"
  inset: "20px"
  panel: "22px"
  page: "24px"
  workspace: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ct-blue}"
    textColor: "{colors.ct-blue-ink}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ct-blue-hover}"
  button-secondary:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-disabled:
    backgroundColor: "{colors.inset}"
  button-danger:
    textColor: "{colors.error}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-text:
    textColor: "{colors.ct-blue}"
    rounded: "{rounded.control}"
    padding: "3px 0px"
  button-play:
    backgroundColor: "{colors.ct-blue}"
    textColor: "{colors.ct-blue-ink}"
    typography: "{typography.primary}"
    rounded: "{rounded.control}"
    padding: "12px 24px"
    width: "248px"
  input:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  navigation-tab:
    textColor: "{colors.muted}"
    rounded: "{rounded.square}"
    padding: "0px 13px"
  navigation-tab-current:
    textColor: "{colors.ct-blue}"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "22px"
  status-badge:
    backgroundColor: "{colors.inset}"
    rounded: "{rounded.badge}"
    padding: "4px 9px"
  item:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
---

# Design System: B2G Tauri Launcher

## Overview

**Creative North Star: "A quiet, image-led CS:GO home"**

The owner-approved Tauri migration preserves the supplied B2G template: compact Rajdhani lettering, restrained Geist Mono metadata, near-black surfaces, supplied rifle and map imagery, CT blue controls, and the profile/news/releases home above persistent Play. This Windows desktop app uses bundled React/DOM/CSS presentation in Tauri's WebView2 window. Actual account, content and Rust worker state supply its facts. The website's root DESIGN.md remains a separate design boundary.

The interface is a calm place to prepare the game, browse owned items, find players and review exact exchanges. Fine borders, modest corners and tonal panels keep dense tasks legible. Stateful tools share one stable shell; visited tabs retain their local work, while background reads update cached snapshots quietly. The selected direction in ui/index.html remains the shell contract; Inventory's bounded extension is recorded in .impeccable/surfaces/apps-launcher-ui-inventory-tsx.md. This record captures the implemented system rather than the earlier Win32 rendering assumptions.

The current presentation sources are ui/main.tsx, ui/styles.css, ui/components.tsx, ui/inventory.tsx, ui/trading.tsx, ui/pages.tsx, ui/friends.tsx and ui/assets.ts. ui/api.ts defines the presentation's fixed IPC entry; src/desktop.rs, src/webview_runtime.rs and tauri.conf.json define its native boundary and runtime. The legacy src/launcher_ui.rs and src/launcher_ui/ modules are compiled under cfg(test) only; their GDI metrics, owner-drawn controls, 1024-pixel minimum and browser prohibition are historical, not current UI guidance.

**Key Characteristics:**

- Compact profile, supplied news artwork, readable release history and persistent Play.
- Bundled Rajdhani and Geist Mono with semantic DOM controls and inline SVG icons.
- Near-black tonal surfaces, readable muted text and restrained CT blue emphasis.
- Owned Steam/B2G inventory with explicit import, readable item art and exact inspection.
- Guided Trading with exact ownership, item details and explicit commitment.
- Retained drafts, mounted visited tabs and visibility-aware cached reads.
- Honest operation states, recoverable requests and OS/account reduced motion.
- Local maintenance tools available in Settings before account connection.

### Authority, provenance and evidence

The source reference is the owner's reference-launcher-design.zip and its recorded live counterpart, https://b2g-omega.vercel.app/. Preserve the source archive hash, original imagery, wordmark paths and font licenses recorded in assets/PROVENANCE.md. The original hero keeps its square source before CSS cover cropping. ui/assets.ts imports the owned local artwork and existing authentic rank SVGs from ../web/public/ranks/; ../../docs/third-party-assets.md records rank provenance. The supplied portrait is decorative and PC-local, never a claim to be a fetched Steam avatar. Font files are bundled with the app through @font-face; the older provenance file's process-private font, packed BGRA and no-browser/no-React notes describe the legacy renderer only.

Historical surface records remain at .impeccable/surfaces/apps-launcher-src-launcher-ui-rs.md, .impeccable/surfaces/apps-launcher-src-launcher-ui-trading-rs.md and .impeccable/surfaces/apps-launcher-src-launcher-ui-account-rs.md. Their product intent and reference lineage remain useful; current geometry, controls and platform rules come from the Tauri source and this record. Migration rationale is in ../../docs/launcher-tauri-migration.md.

The 2026-09-08 finish record is ../../.artifacts/tauri-polish-20260908/finish-verdict-round1.md. Its disposition is ship at the F1–F3 fix-list scope: complete Trading item rows, a separate scrolling content region and reserved action row, one forward draft action, and legible inventory filters. F4 is fulfilled by this documentation refresh. The 16 required browser captures are .impeccable/review/tauri/{play,trading,match-history,friends,settings,profile,compose,review}-{1360,960}.png, at 1360×820 and 960×640. The build handoff reports 14 passing browser interaction/layout tests and 134 passing Rust tests; the earlier verdict itself cites its then-current 12-test log. The final build handoff reports provenance coverage for all four shipping rasters.

The Inventory extension's 2026-09-08 review is ../../.artifacts/knife-import-20260908/inventory-review.md. Its final disposition is ship for the scored F1–F2 fixes only: an isolated, aligned compact search composite and a failed initial read that stops loading and offers Retry. All four required final browser captures are .impeccable/review/inventory/{inventory,details}-{1360,960}.png, at 1360×820 and 960×640. The final build handoff reports all 27 browser tests and the frontend build passed; the reviewer inspected the recaptured fixtures and source without rerunning those checks. These captures document the inherited visual system and exact item dialog, not a live Steam import, physical Windows/WebView2 acceptance or live player gameplay. No new shipping raster or visual identity was introduced by this tab.

The actual Windows executable started, connected the Rust command bridge, completed authenticated bootstrap and reused the existing window on a second launch. A live Microsoft WebView2 bootstrapper download passed Authenticode verification for Microsoft Corporation; installation on a machine missing WebView2 remains untested. Physical desktop visual/input acceptance was unavailable because the native automation pipe was unavailable. Browser captures and executable smoke checks do not establish physical Windows input/rendering, production trading or real game-launch acceptance. The one design detector pass degraded to regex and largely reflected old DESIGN drift and warnings about the explicitly pinned Geist face; it is not a comprehensive visual pass.

## Colors

CT blue leads actions, selection and focus. A slightly green near-black field and two brighter neutral layers keep panels distinct without making every section compete.

### Primary

- **CT blue:** the shared primary action, active tab underline, current workflow step, selected item border, progress fill and links.
- **CT blue hover:** a brighter state of the same control, not a second accent.
- **CT blue ink:** dark lettering and icon fill inside blue actions.

### Secondary

- **Connected green:** live/online state, completed progress steps and positive feedback.
- **Error coral:** failures and destructive controls, always accompanied by an explicit label or message. Warm muted surfaces also distinguish gift consent, recovery and caution; they are contextual treatments rather than a competing brand accent.

### Neutral

- **Field:** the application, content and persistent game-bar background.
- **Panel:** identity, releases, player rows and item surfaces.
- **Inset:** fields, secondary controls and quiet selected containers.
- **Line:** one-pixel boundaries between meaningful regions.
- **Ink:** primary copy and identity; **muted:** supporting text, timestamps and secondary labels.

**The State Truth Rule.** Show operation, connection and outcome state in words as well as color. An error names its recovery; data that is unavailable stays unavailable rather than inheriting a fabricated count or success promise.

Item rarity retains the catalog's fine colored bottom border, including purple or red when appropriate. It does not redefine action/error roles. Selection also adds a check and aria-pressed state. Offer badges name Pending, Completed, Cancelled or Declined; match results retain their W/L or outcome text.

## Typography

**Display and Body Font:** bundled Rajdhani Regular, Medium, SemiBold and Bold, with Segoe UI and sans-serif fallbacks.
**Label/Mono Font:** bundled Geist Mono Regular, with a monospace fallback.

Rajdhani supplies a compact Counter-Strike character with open enough line spacing for instructions. Geist is reserved for IDs, codes and numerical columns. The frontmatter records the shared type roles; ui/styles.css is authoritative for local responsive adaptations. No font installation or remote font request is required.

The shared hierarchy moves from the display heading to headline and title, with medium body text and semibold controls. Supporting prose commonly steps down to 14–15px; small helper text is 13px. General paragraphs cap at 72ch. News titles use a compact 1.12 line height and balance within 19ch, while the Play action is deliberately larger and tracked. Pair codes and profile metrics have local emphasis rather than becoming a new global type scale.

**The Whole Item Rule.** Trading item names may clamp to two lines, but condition, selection and the separate detail action must stay visible together. Inventory cards wrap their names and open details as one labelled button, with condition, source and any Equipped state retained. Full identity, wear, attributes and consequences remain available in the item dialog.

Do not propagate the existing tiny wordmark descriptor or compact release classification labels as a new eyebrow/kicker system. Their appearance is a carryover of this supplied home, not permission to add decorative microcopy to future tasks.

## Layout

The Tauri window opens at 1360×820 logical pixels and enforces a 960×640 minimum. CSS uses logical pixels and responsive grids. The body's 760px floor is an internal fallback, not a supported compact window or mobile contract. The undecorated window exposes labelled minimize, maximize/restore and close buttons plus a draggable brand region.

The shell uses a two-pixel CT blue top rule and a grid of 64px header, flexible minmax(0, 1fr) content, and 98px Play footer. Main content owns its scrolling; the shell and footer remain stable. Pages use 24px outer padding, reduced to 20px at the compact breakpoint. Panels commonly use 20–22px insets; workspace gaps narrow from 28px to 20px.

Home keeps three useful columns. At the default width the profile spans 230–280px, news flexes from 300px, and releases span 240–300px, with 22px gaps. At widths up to 1200px those columns become 230px/flexible/250px; at up to 1030px they become 220px/flexible/230px with 14px gaps. At 1600px and above, the three-column home caps at 1700px. The news cover crop and dark scrim keep the image continuous behind the copy. Releases have their own scroll region and a reachable full-history action.

The footer holds the game action, region, status and launcher version/release notes. Play is 248px wide and at least 64px high, narrowing to 222px at 1200px and 216px at 1030px. The online population column hides at 1200px; primary status and the game action stay visible. Tab icons hide at 1030px while all six text labels remain.

Task workspaces use a left sidebar and minmax(0, 1fr) work area, capped at 1600px. The sidebar narrows from 190px to 170px at 1200px and 155px at 1030px. Settings aligns explanatory text left and controls right, with an in-page sticky Save/Discard row only for a dirty draft. Match tables and extended statistics own horizontal scrolling inside their container.

Inventory uses a single main region capped at 1600px. The title and explicit Steam refresh lead, followed by last-import/cooldown text and an aligned search/source toolbar. Search grows to 480px and the source select reserves at least 160px, separated by 12px; the icon and input stay on one row at both supported sizes. Its page-specific search style stays independent of Trading's filters. The item grid fills the available width with columns of at least 185px and 12px gaps. Cards use 12px insets and 112px contained art, with metadata at the bottom. Pagination and compatibility guidance follow the grid in the main scroll region; the persistent Play footer remains separate.

**The Reserved Action Rule.** The active Trading draft uses a two-row grid: an independently scrolling trade-flow-body and an auto-sized commitment row. Keep that row outside the scrolling body, above the persistent game footer; no absolute or sticky overlay may cover items, message text, consequences or gift consent.

Trading keeps equal You give and You receive columns, their own inventory scrolling and bounded pagination. At widths up to 1200px each side uses two item columns. Draft filters reserve 126px for their select. At 960×640 the inventory viewport is 148px, with 136px minimum item buttons and 60px art, so a complete first row includes name, condition and detail control above the reserved action row. Additional content scrolls within the body. At larger widths the draft inventory height follows clamp(165px, calc(100vh - 560px), 320px). Preserve this verified relationship when adding messages or consequences.

First-run content keeps owned artwork beside installation/account tasks within the same shell. The two columns are minmax(250px, 0.8fr) and minmax(400px, 1fr), capped at 1400px. Forms have durable labels and normal flow; the page scrolls when instructions, validation or account tasks need more space.

## Elevation & Depth

The default surface is flat and tonal, with one-pixel structural boundaries. The hero and setup art use dark vertical scrims for copy contrast. Existing shadows serve occlusion: the modal uses 0 20px 80px rgba(0, 5, 2, 0.7), with a dark backdrop, and the sticky settings action row uses 0 -8px 24px rgba(8, 10, 8, 0.65) to separate it from scrolling content.

**The Task Depth Rule.** Reserve elevation for a modal or an action region crossing scrolling content. Routine cards and item tiles rely on tone, borders and explicit state.

## Shapes

The shared control/panel radius is modest; smaller radii serve compact chips and selection marks, while dialogs use the larger recorded radius. Tabs remain square with a two-pixel active underline. Circular status dots, workflow markers and checkbox-switch knobs express their actual state. Item rarity is a bottom border, not a decorative glow.

Icons render as inline SVG from the shared Lucide React components, generally 16–20px in utility controls and larger in Play. Button SVG stroke width is 1.7. Use a filled Play triangle where implemented; do not substitute text glyphs, emoji or the old GDI path renderer.

## Components

### Buttons, fields and navigation

Shared primary and secondary actions have at least 40px height, semibold type and the recorded padding. Utility buttons default to a 36px minimum; text actions can be more compact. Primary hover brightens CT blue, secondary hover raises its neutral fill, and destructive controls use coral text on a subdued red background. Disabled controls have a real disabled attribute and distinct muted treatment.

Keyboard focus is a two-pixel CT blue outline with a three-pixel offset. Search composites use a two-pixel focus-within outline around the field; labels and aria-labels survive typing. Inputs, selects and textareas are real DOM form elements with a 42px general minimum height. Error feedback uses role=alert and successful feedback uses role=status. Dialog uses showModal(), a labelled heading, Escape dismissal and restoration of the invoking focus.

Navigation has exactly six tabs in this order: Play, Inventory, Trading, Match history, Friends and Settings. aria-current identifies the selected page. Visited page sections remain mounted and use hidden for inactive pages; activation focuses the current page heading without resetting its scroll. Account scope keys remount account-bound tools when identity changes.

### Persistent game state and onboarding

The footer's action follows actual state: Checking, Install CS:GO, Connect Steam, Finish setup, Installing, Connecting, Starting, In game or Play. The same action leads to installation, browser Steam authorization, in-app profile completion or game start. Installation progress uses Steam's downloaded/total bytes only; unavailable totals produce instructions rather than synthetic progress. Account setup shows the matching authorization code and validates a 3–20 character player name with the implemented letters/numbers/underscore/hyphen constraint.

Presentation calls launcher_call with a fixed operation vocabulary. Rust chooses API endpoints and attaches credentials; tokens, consent journals, file writes and game integration stay outside the webview. CSP restricts app resources and IPC; permitted external account/Steam links open through the checked Rust path. The Rust session owns starting/running/failed state across UI reads and tab changes. It is not derived from an ephemeral frontend event and is not a claim of persistence across process termination. Starting/running and protected file or mutation work block unsafe closure and offer minimization. A second executable launch focuses the existing window.

Missing Microsoft WebView2 is handled before the UI opens by src/webview_runtime.rs: obtain Microsoft's bootstrapper, validate Windows trust and Microsoft publisher, show its installation progress and provide a retryable failure if setup cannot finish. The launcher keeps the shared runtime dependency; it does not bundle a whole browser. Steam/game installation and B2G account onboarding then happen in the launcher flow above.

**The Real Work Rule.** Animate pending state only while its operation is active. Determinate progress comes from completed work, not elapsed time; progress width itself has no animation.

### Quiet reads and retained work

useRemote serves cached snapshots, coalesces in-flight requests, compares payloads before replacing data, rejects stale key/generation responses, bounds the cache and clears account data on disconnect. Periodic callbacks skip hidden documents, visibility restoration refreshes, and inactive account pages disable their reads. Local status polls at 1.5 seconds, bootstrap and active Inventory snapshots at 30 seconds, and active Trading/Friends data at 5 seconds. Inventory's quiet snapshot reads do not initiate a Steam import. Cached content stays readable during a recoverable read failure.

Settings drafts survive background account refreshes while dirty. Trading selections, message and review state remain in the mounted page when navigating away. These are retained in-session drafts; only pending Trading requests have the separate durable Rust recovery record.

**The Quiet Refresh Rule.** Background reads must not masquerade as foreground work, reset a draft or replace unchanged content. Name the actual save, repair, download or mutation in its own feedback.

### Inventory

Inventory browses the current account's compatible Steam items and items earned in B2G. Case-insensitive name search and All items/Steam/B2G source filters retain their values during refresh and reset pagination when changed. Pages contain up to 48 items. Each whole-card button shows catalog art, name, condition, source, a fine rarity edge and a textual Equipped state when reported. Missing or failed art uses the shared neutral package icon while preserving item identity.

Refresh Steam inventory is an explicit action with its own pending, success and error feedback. Show the last Steam import in the player's local date/time format and the remaining five-minute cooldown from the returned next-refresh timestamp; disable refresh while pending, cooling down or awaiting the first snapshot. Keep existing cards and filters readable during a refresh. Private inventory explains how to make Inventory public in Steam and identifies previously imported items; an unavailable Steam verification names retained items as the last import. A failed initial snapshot shows an actionable error and Retry without a continuing loading indicator or a fabricated empty inventory. Successful empty and no-match results have distinct guidance.

Inspecting a card opens the shared labelled dialog with the exact item name, condition, source, any Equipped state, item ID and available wear, pattern, paint kit, name tag and StatTrak kills. Preserve full supplied attribute values. Escape, the close control and backdrop dismissal return focus to the invoking card. Steam details state that imported items remain linked to the Steam account and cannot be traded through B2G. Compatibility guidance identifies CS:GO 2023 support, in-game equipping and the separate Trading tab for B2G items; Inventory adds no equip, trade or unboxing action.

Inventory is account-scoped. Signing out clears account data and unmounts the page, and late responses cannot repopulate the signed-out view. Tab changes preserve search, source, pagination and scroll in-session while inactive reads remain disabled.

### Trading

The exchange progresses through finding a player, selecting exact items on both sides and reviewing before Send offer. Item tiles combine catalog art, name, condition, rarity, tradability, aria-pressed selection and an independent Details button. Missing art uses a neutral package-icon fallback while retaining the item text. Selection persists across inventory pagination and filters; selected chips allow removal.

You give/You receive direction, exact asset IDs and fingerprints, message, revisions and item consequences travel with the reviewed terms. A one-sided exchange requires explicit gift confirmation. Selection changes clear review and gift consent; incomplete or changed incoming items cannot enable acceptance. Offer details, counteroffers and history retain their respective action/state language.

**The Exact Review Rule.** The commitment represents the exact displayed items and current revision. Changed selection requires another review; an uncertain mutation recovers the persisted request instead of submitting a new one.

The title's New trade/Continue draft action appears only outside active draft mode. Within compose/review, Review trade or Send offer is the sole forward action; Back/Edit remains a distinct reverse action. The recovery panel stays available when Rust reports a pending mutation, and readiness for a new commitment depends on resolving that uncertainty.

### Friends, profiles, match records and Settings

Friends retains player search by name, B2G player ID or trade code, incoming/sent requests and explicit relationship actions. A failed uncertain request retries the same request identity. Profiles show permitted identity, real rank art, linked account information and distinct Competitive/Deathmatch summaries; privacy restrictions remain explicit.

Match history preserves map/mode, played date, result, K/D, ADR and ELO or Unrated. Details retain extended participant statistics, including assists, KAST, openings, trades, clutches, flash assists and utility damage. Available demos can be downloaded and verified, then opened in their folder; unavailable demos say so.

Paired Settings retains Account, Matchmaking, Privacy & notifications and Launcher sections. Account options, region, preferences and privacy save explicitly; local profile picture choices remain portrait, rank, blue, green and gold. Signed-out Settings exposes only Launcher maintenance without account/bootstrap API calls: debug console, log, diagnostics, repair and uninstall remain accessible before pairing. Local operations still use the Rust bridge and installation/game-state guards. Uninstall and sign-out require their implemented consequence dialog. The paired layout is unchanged by this signed-out path.

### Motion

The shared easing is cubic-bezier(0.16, 1, 0.3, 1). Controls transition color/fill/border/shadow over 150ms; tabs enter their active underline over 180ms. Page entry is 180ms and dialog entry 160ms. Hover moves Trading item art by two pixels over 180ms, scales Inventory art to 1.04 over 180ms and scales hero art to 1.045 over 500ms. A pending spinner rotates over 850ms. These are bounded state or interaction cues, with no idle ambient animation.

OS prefers-reduced-motion and the account reduced-motion setting disable transitions and animations and remove hero/item hover motion. The account preference previews immediately and reverts with Discard changes. Preserve this behavior for new animation; the current immediate one-pixel button press is not a license for additional movement.

## Do's and Don'ts

### Do:

- **Do** preserve the supplied artwork, B2G wordmark, bundled font licenses and authentic rank provenance.
- **Do** derive state, population, progress and release content from real account, content and worker data.
- **Do** keep Play and current game state visible across all six tabs.
- **Do** retain Inventory cards during refresh and keep source, exact attributes, cooldown and privacy/retry state explicit.
- **Do** preserve draft state, keyboard focus, labels and recoverable read feedback during quiet refreshes.
- **Do** keep complete Trading item rows and exact commitment consequences reachable at 960×640.
- **Do** retain the reserved Trading action row and explicit gift/recovery paths.
- **Do** make local Launcher maintenance reachable before pairing while keeping account requests gated.
- **Do** respect OS and account reduced motion and keep credentials and game-session ownership in Rust.
- **Do** state the scope of browser, native smoke and physical desktop acceptance separately.

### Don't:

- **Don't** import fabricated population, ping, news claims or timer-driven progress from the prototype.
- **Don't** replace the pinned Rajdhani/Geist pairing, CT blue identity or supplied home composition with a generic dashboard.
- **Don't** restore the legacy Win32 control, font-metric or no-webview constraints as current platform guidance.
- **Don't** overlay Trading actions on item content or add Continue draft inside an active draft.
- **Don't** accept changed/incomplete trade terms or bypass a persisted uncertain request.
- **Don't** present a PC-local portrait as a synchronized Steam avatar.
- **Don't** canonize tiny carryover descriptors as a reusable decorative kicker system.
- **Don't** present browser captures or a startup smoke check as live production trading or physical desktop/game acceptance.
