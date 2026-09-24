# Native launcher reference polish

Requested after the 0.2.26 medal, reward-odds and drop-chat corrections.
The controlled implementation and release are complete in [0.2.27](playtest-0.2.27.md).
The original scope and acceptance checklist below remain the audit authority;
human appearance/live-session checks are distinguished in the release notes.

## Authority and baseline

- Visual authority: `C:\Users\<user>\Downloads\reference-launcher-design.zip`.
  SHA-256 `f0ea14374b6fa3ae96c1a6828a2366ad9b8a9d6001ca4daa2b339d0b9540b096`.
- Verified extraction: `.artifacts/reference/counter-strike-game-launcher/`.
  All extracted files match the prior September 5 reference extraction.
- Native target: `apps/launcher/src/launcher_ui.rs` and its `drawing.rs`,
  render/state/window tests, embedded assets, and only the data contracts needed
  to populate the existing dashboard accurately.
- Current-source offscreen baseline: `.artifacts/launcher-ui-0.2.26-baseline/`.
  `ready.png` is 1360×800 and uses an explicitly synthetic test account/content.
  It is not a capture of the owner's live desktop or current account progress.
- Mode: Operate. Returning players should understand their account/client state
  and launch CS:GO immediately; first-time and disconnected users need a clear
  pairing or recovery action within the same visual system.

The reference is a Next/React prototype. Its visual structure is binding, but
its sample profile, ping, player count, news, kernel-driver claims, and timed
fake launch progress are not B2G product facts.

## Concrete differences to resolve

| Area | Current native baseline | Reference direction |
| --- | --- | --- |
| Header | 64px custom header plus native window frame; oversized logo/action density | Compact 56px header, restrained logo/tagline, precise rules, coherent real window controls |
| Columns | 272px profile / flexible center / 304px changes at wide sizes | Reference wide composition uses 300px profile / flexible center / 320px changelog, 16px outer spacing and gaps |
| Profile | Full-height rail, large centered rank inset and separated access block | Compact content-height card, horizontal avatar/name and rank rows, fine separators and quieter metadata |
| Typography | Two Rajdhani weights mixed with Segoe UI body and many bold blocks | Match Rajdhani's normal/medium/semibold/bold hierarchy, tracking and line-height; restrained mono numbers/version text |
| News | Fixed promotional hero text with a large separate text block underneath | Labeled news section, image with controlled gradient/crop, bottom-aligned headline/summary and compact secondary items where real content exists |
| Changelog | Two large text sections with sparse structure | Compact version/date groups, readable change rows and restrained change-type tags using actual release history |
| Footer | 128px bottom region with an extra version/footer line | Compact persistent launch bar; reference 64px action with 16px padding, well-grouped truthful status details |
| Finish | Large flat panels and basic drawn control states | Match subtle borders, 2–4px corners, icon weight, optical alignment, hover/pressed/focus transitions and native responsiveness |

Source dimensions are reference targets, not permission to clip real content at
smaller window sizes. Measure the rendered reference before fixing dimensions.

## Implementation sequence and acceptance

1. Render the supplied prototype locally in an isolated development harness,
   without adding its framework/dependencies to the shipped launcher. Capture
   it and the native baseline at matched client-area sizes; record measured
   geometry, fonts, colors and spacing. Include the actual Windows frame when
   comparing the whole window. Persist a native surface brief that supersedes
   the old 0.2.21 brief while retaining website design authority separately.
2. Refine the existing Rust/Windows UI to follow that reference. Use shared
   layout/type/color values, embedded and appropriately compressed reference
   art, authentic rank emblems and bounded account-avatar loading if an existing
   authoritative source supports it. Keep a clean initials fallback. Avoid
   placeholder identity/artwork masquerading as the signed-in player.
3. Restore the compact profile, news and changelog hierarchy, keeping real
   account, rank, XP, access, version, release history and client status. Add
   only the minimal data shape needed for these existing sections. Do not invent
   content to fill prototype tiles. News/detail actions must work and expose
   full text when condensed. Keep profile/action visibility correct at level 40.
4. Finish the full interaction path: signed out, pairing, ready, launching,
   running, exited, install/repair, unavailable game, stale/offline service,
   expired access, update available, errors/retry, long names and empty content.
   Preserve the working Steam/GC/inventory/queue bridge. Every retained control
   must have real behavior, a useful label, keyboard access and visible focus.
   Preserve drag, minimize, maximize/restore, close, resize and Windows shortcuts.
5. Keep work off the UI thread; avoid redraw re-entry and the 0.2.22 freeze.
   Measure startup-to-first-paint, idle CPU/memory, resize/repaint responsiveness
   and package size against 0.2.26 on the same machine. Use bounded/cached asset
   decoding and request lifetimes. Reuse the native runtime; no Electron,
   production Next server, analytics SDK, polling layer or dependency bulk for
   visual fidelity. Document any justified measured cost.
6. Verify representative 1024×664, 1280×780 and 1360×800 client areas and
   100/125/150/200% DPI, including transitions between displays where available.
   Inspect screenshots at matched scale, truncation/wrapping, contrast, focus,
   image quality and all meaningful states. Use the Impeccable bounded review
   workflow: one batched review, one batch of fixes and at most one confirmation
   round; obtain the skill's independent finish review when applicable.
7. Run appropriate Rust/native-window/render and changed contract tests. Retain
   the window responsiveness regression. Version, package and publish a coherent
   launcher release under existing deployment authorization, verify public hash
   and embedded GC pins, and provide before/after evidence and concise testing
   instructions. Do not interrupt a running human game to replace its GC.

## Scope limits and completion

Omit Store, commerce, inventory editing, extra Stats pages, social panels,
community server browsers and other prototype-only features. Inventory and
matchmaking continue in the game. Do not add dead navigation to mimic density.
Keep essential account/settings/recovery actions where they serve existing
launcher behavior. Do not redesign the website or game UI as part of this goal.

Completion requires the refined implementation, matched visual evidence,
functional and responsiveness checks, a verified distributable release, and
updated documentation. A plan, a green render test, or a subjective percentage
does not establish completion. Real human appearance/interaction confirmation
must be distinguished from offscreen rendering; unavailable human 5v5 testing,
player recruitment and owner-only account challenges are not goal dependencies.

## Completion audit — 0.2.27

| Requirement | Current evidence and result |
|---|---|
| 1. Measure reference and baseline | ZIP hash verified; isolated reference harness captures/JSON at three sizes; original 0.2.26 native baseline retained; matched region pairs in `.impeccable/review/native-0.2.27`. Reference harness was development-only and is stopped. |
| 2. Faithful native refinement | Independent review accepts wide geometry, header, type, imagery, ground and launch bar; compact/access/rank/initials adaptations are explicitly authorized. Final painter and assets are packaged in 0.2.27. |
| 3. Real content and full text | Bounded shared release history, authentic profile/XP/access, measured rows, scrolling selectable details, validated newer-version official download. Level-40 instruction remains conditional. No avatar source is invented. |
| 4. States and interactions | 17 synthetic state captures and 12 size/DPI captures; native HWND capture; error/access/recovery/whole-line tests; real button/tab/hit-zone/scroll/minimize/close tests and hidden maximized geometry. Existing Steam/GC/party/queue regression suite remains green. Only one actual monitor (125%) is exposed; physical mixed-monitor appearance and live human session remain external checks. |
| 5. Responsiveness and scope | Same-machine baseline/final process, first-paint, CPU, memory and resize samples in release notes. Final first-paint median 41.14 ms, eight resizes 30.38 ms, working set 21.29 MiB. Package +156,160 bytes / 1.59%, mainly font faces and native code. No web runtime, new polling or game logic added; workers and freeze regression retained. |
| 6. Bounded visual verification | Build review and one confirmation followed by independent review; one bounded five-fix batch scored resolved under ship disposition. All 31 originals reopened independently. Native detector skipped correctly; asset provenance scan passes. DESIGN.md and schema-v2 sidecar reflect the final source. |
| 7. Distributable and delivery | Immutable 0.2.27 exe, sidecar, version CLI and GC pins verified. Matching API/web deployed as 0.2.27-alpha.20260907.0545 with archive/image guards, database/config backup and rollback trap. Public download/hash/version, website metadata and readiness verified. Node 0.1.26 reopened active/ready with plugin 0.1.7; no game-node installation or active-game interruption. |

All controlled requirements are satisfied. Human appearance approval, real
fullscreen and physical mixed-DPI transitions, owner-authenticated Play/session
confirmation and real multiplayer/5v5 tests are not asserted by this audit.
The release notes provide their test instructions, before/after evidence,
exact artifacts, performance limits and rollback information.
