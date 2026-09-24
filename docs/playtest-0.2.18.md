# Local playtest checkpoint: launcher 0.2.18

2026-09-05. Installed locally, not published to production.

Follow-up at 21:16 UTC: the [server-side DM handoff fix](dm-server-handoff.md)
is deployed in API release `0.2.18-alpha.20260905.2110`. The website/download is
still 0.2.16, Windows node is still 0.1.16, and this local client is unchanged.
The historical deployment statements below describe the original client installation.

## Scope and evidence

The reported Deathmatch GO/notification problem had multiple contributing paths:

- Client GC did not acknowledge GO before the launcher performed synchronous latency/HTTP work. Idle bootstrap messages could therefore overwrite the pending search presentation.
- Successful joins discarded the returned queue state and waited for another bootstrap before presenting success.
- Deathmatch explicitly skipped the Competitive ready-check presentation and went directly to server handoff.
- Assigned queue phase 4 still advertised `matchmaking=1`, retaining a search/CANCEL presentation after assignment.
- Historical launcher logs also contain real HTTP 503 responses and 15-second join timeouts. Those are not proven to be purely visual failures or fixed server-allocation failures by this client update.

The existing final-2023 Panorama script, locally extracted at
`.artifacts/diagnostics/code-pbin-extracted/panorama/scripts/popups/popup_accept_match.js`,
already supports a map prefixed with `@`: it hides acceptance slots and the timer,
uses its original automatic-announcement styling, plays `popup_accept_match_confirmed`,
and calls `LobbyAPI.SetLocalPlayerReady('deferred')` after 1.9 seconds.
`party.js` forwards `ServerReserved` to that popup. No popup JavaScript, XML, CSS,
new font, or replacement layout was introduced for this change.

## Implemented behavior

- Native GO immediately publishes pending search state before HTTP work. Start/cancel messages carry monotonically increasing per-client request IDs; duplicate pending/active starts are suppressed, stale responses cannot undo a newer cancel, and IPC disconnect/reconnect clears abandoned pending presentation.
- Join responses immediately update the presented queue phase. Explicit HTTP errors are not mistaken for lost successful responses. Transport failures still reconcile against authoritative bootstrap, without using the same old assigned match as proof of a newly committed requeue.
- An assigned DM raises the native `@de_dust2` announcement with zero acceptance slots: there is no fake 10-player count and no user Accept requirement.
- The native `deferred` callback only permits an already-authorized matching DM handoff. It never calls the Competitive acceptance endpoint or Valve's original continuation. If the callback is unavailable, the handoff becomes eligible after three seconds and proceeds on the next session poll, rather than leaving a new acceptance gate stuck indefinitely.
- Notification state is deduplicated across polls, cleared on cancellation or assignment loss, and rearmed by an explicit fresh DM join, including reassignment to the same live match. Assigned state is no longer advertised as an active search.
- Competitive retains its existing ten-player acceptance, map, count, and deadline behavior. Existing owned-item, keyless case opening, profile, and Dust II menu patches remain in place.

The UI-hardening/interaction guidance influenced the choice to retain the native
presentation, acknowledge the first action promptly, correlate asynchronous
outcomes, and avoid fabricated progress or player counts.

## Verification

- Rust launcher: **66/66** library tests passed, including a real PID-authenticated local named-pipe exchange, queue wire validation, cancellation/superseded-response state, DM callback/fallback/requeue behavior, and existing inventory/launcher-UI regressions.
- Native GC: **8/8 CTest suites** passed, including queue presentation/wire tests, valid automatic notice versus fabricated slots, assigned-search state, and all existing inventory policy/cache tests.
- Exact installed final Panorama archive accepted by the patch test: `archive_size=4704521 result=1`.
- Release build completed; embedded-asset repair dry run passed. Local install and game repair completed successfully. Diagnostics verified the wrapper, GC DLL, and preserved original Valve launcher backup.
- No CS:GO/Steam GUI interaction, game launch, simulated mouse/keyboard actions, or Computer Use was performed. Popup appearance/sound, rapid-click behavior in the running client, and a real server join still need human UAT.

## Local files and rollback

- Installed launcher: `C:\Users\<user>\AppData\Local\B2G\bin\b2g-launcher.exe`
- Candidate/staged download: `apps/web/public/downloads/b2g-launcher-v0.2.18-windows-x86_64.exe`
- Launcher SHA-256: `1b92484497ec64b8770bfe5f929409ce8099100513c5abb0a1eaa2581e1df980` (3,864,064 bytes).
- Installed/prebuilt GC SHA-256: `e2bec65583cb177ff480441072d912389ef2294a113a410a5a1032aede63e5f5`.
- Previous launcher and DLL preserved in `.artifacts/launcher/rollback-0.2.17/`; the original 0.2.17 staged download also remains available.

Production website/API remains **0.2.16**, Windows game node **0.1.16**.
No production release or game-node archive was changed during this installation.
The server-GC source install pin now matches the newly built prebuilt DLL for
future releases; this does not modify the running VPS or existing release archives.

The DLL also contains the newer [live-inventory synchronization](live-inventory-sync.md)
consumer. Its complete server-side behavior still requires the separate coordinated
API/migration/node/GC rollout; installing this client alone does not deploy that work.

## Focused human UAT

Open the existing installed launcher, launch CS:GO, choose Official Matchmaking
→ Deathmatch → Dust II, and press GO once. Confirm visible search feedback followed
by the original green automatic match announcement/confirmation and server connection.
Leave the DM and repeat once to check reassignment to the same match. Separately try
cancelling a search and ensure a late response does not reconnect you. Competitive
should continue to require its normal ten-player acceptance.

Also recheck the reported quick-open/reveal/New-item behavior using the full-client
inventory handoff fix carried forward from 0.2.17. Do not describe the still-unreleased
server-side inventory/StatTrak rollout as visually verified by these client tests.

## Misleading launcher version banner — source follow-up

The owner reported this installed file showing 0.2.16. Rechecking both the installed
executable and the named 0.2.18 staged download produced the same recorded
`1b924844...1df980` hash above. The old header rendered
`launcher.content.releaseVersion` from the API, whose published-download version
is correctly still 0.2.16, instead of the running binary's build version.

The source fix makes the header begin with `LAUNCHER v<CARGO_PKG_VERSION>`, even
before pairing or during a service outage. The release-note status distinguishes
an older published download from the installed build; unavailable or malformed
release information no longer claims `CURRENT`. UI clarification guidance kept
this change scoped to factual version labels without a layout or identity redesign.

A new `version` / `--version` / `-V` CLI path prints the build version before any
installation, logging, network or window initialization. Regression tests cover
older/equal/newer/invalid release metadata and exercise the real CLI subprocess.
All 68 library tests and the CLI integration test pass. No GUI was opened or
controlled; rendered text placement has not been visually verified.

This is a **source-only follow-up for the next release**. The installed and staged
0.2.18 binaries were not rebuilt or overwritten, so their original banner can
still show the misleading 0.2.16 value. Use the existing local 0.2.18 for DM UAT;
do not expect the new CLI option or labels in that already-packaged executable.
