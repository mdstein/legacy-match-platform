# Native Trading tab: finish-review packet

Project root: `C:/Users/max/Desktop/goagain`. Prepared 2026-09-07.

## Request and settled direction

Build full Steam-style B2G player-to-player trading in a separate native launcher
tab. The owner explicitly chose **StatTrak resets to zero for the new owner**.
Preserve the original count in receipts. Exact offers, counteroffers, gifts,
accept/decline/cancel, history, discovery and recovery are in scope. This extends
the existing native launcher; it is not a redesign or a marketplace/chat product.

Authority: `apps/launcher/DESIGN.md`, `docs/player-trading-surface.md`,
`apps/launcher/.impeccable/surfaces/apps-launcher-src-launcher-ui-trading-rs.md`.
The opening contract in `apps/launcher/src/launcher_ui/trading.rs` pins the
Rajdhani/Geist Mono typography, near-black surfaces, restrained blue, real item
art, paired inventories and exact review. It is an Operate surface. This is a
code-led local extension; there is no approved replacement comp or concept card.

## Artifact and review boundary

Primary: `apps/launcher/src/launcher_ui/trading.rs`.
Related: `apps/launcher/src/trading.rs`, `apps/launcher/src/trading/art.rs`,
`apps/launcher/src/launcher_ui.rs`, `apps/launcher/src/launcher_ui/drawing.rs`,
`apps/launcher/src/launcher_ui/details.rs`.

Review the complete Trading surface, its shared native navigation and any
interaction issues affecting exact review. Existing Play content is preserved.
Review is read-only. Do not deploy, modify accounts, launch CS:GO, run new visual
build rounds or edit product files. Backend release work continues independently.
No HTML/CSS detector ran: this is native Win32/GDI, not a web view or mobile app.
Craft floor: `.agents/skills/impeccable/reference/craft-floor.md`.
Finish workflow: `.agents/skills/impeccable/reference/new-work.md`, section 7.

## Captures and validity

All required paths are explicitly indexed in
`apps/launcher/.impeccable/review/trading/screenshots.json`.
There are 50 Trading captures: three main states at 1024x664, 1280x780 and
1360x800, each at 96/120/144/192 DPI; eleven compact edge states; and three
actual-HWND captures (`native-trade-compose`, `native-trade-review`,
`native-trade-recover`). Those actual windows were offscreen, used synthetic
accounts and a loopback fixture server, and retained the running-game UI state.
They are PrintWindow captures of the real native controls, not desktop captures.
The matrix is memory GDI rendering, including a fixture-only rendering of native
edit text. Do not conflate simulated DPI rendering with actual monitor coverage.

Four `contact-*.png` sheets index every Trading image for capture validity; use
the full individual files to assess text, controls and geometry. The builder
opened all images through the batched sheets and representative full-size
native/compact files. No capture is blank, unrelated or half-loaded. Fixtures
are labeled in tests and this packet; names, population numbers and examples are
synthetic evidence, not claims about current production activity.

The first inspection found missing native field hints, clipped paging labels,
status text overlapping paging and a stale composer instruction. These were
corrected together and confirmed in the second inspection. Builder visual
polishing is now closed; material review findings drive any further fixes.

## Verification and limits

- Full launcher library suite: **103 passed**, two child entry points ignored
  because watchdog tests invoke them explicitly in isolated processes.
- Native button journey: find partner, load both inventories, select/review,
  read note, send, counter, confirm a gift, accept with an intentionally lost
  response, recover the exact request, read receipt and return to Play.
- Native keyboard traversal includes item buttons and message fields. An
  overfull 512-item-per-side fixture exercises bounded scroll work.
- Loopback timings vary by capture load: initial Trading request ~30–90 ms;
  two selections plus review ~60–125 ms; 20 scroll/control updates with 512
  items ~90–125 ms. These are fixture measurements, not internet latency claims.
- Image decoding and downloads use two background workers, a latest-view queue
  of 16 images and a 96-image cache (~15 MiB of decoded pixels maximum).
- 1,445 catalog mappings resolve to 1,440 original Valve thumbnails (~37.8 MB
  hosted separately, not embedded in the launcher). Each PNG embeds source
  provenance; source paths and hashes also appear in the public provenance file.
- API trading integration: **17 passing tests**, including authentic two-device
  HTTP credentials, atomic transfers/races/rollback and a 100-item offer with
  a full paginated inbox below 64 KiB. Folder summaries cannot be accepted until
  the full offer has loaded.

This is a **local candidate** still carrying baseline 0.2.28 version metadata.
No trading release, migration or item transfer has reached production. This
review is not release approval or live gameplay acceptance. The active goal
continues through additional integration checks, operations and verified delivery.

Return the shipped finish-review contract with its disposition and material
findings tied to concrete captures/code. Distinguish verified evidence from
checks the provided evidence cannot support.

## Final handoff

The reviewer scored all three material findings resolved after two bounded fix
rounds, disposition **ship** at fix-list scope. The documenter updated the
launcher DESIGN.md, sidecar and Trading surface brief. These captures predate
release metadata changes; deployment and final test evidence are in
`docs/playtest-0.2.29.md`. No additional visual redesign followed the review.
