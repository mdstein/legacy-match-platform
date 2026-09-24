# Signed-out launcher recovery — 0.2.40

The signed-out Tauri launcher repeatedly switched between setup and the generic
loading screen. Settings also flashed and lost its mounted controls. The shared
cache reset erased native status along with account data: `paired=false` became
undefined, the next status response restored false, and the sign-out effect
cleared everything again. This created an immediate request/render loop rather
than the intended 1.5-second background polling.

The account-disconnect boundary now retains the native installation/session
snapshot and immediately records the confirmed signed-out state. It removes
private account data, advances the cache generation, rejects outstanding reads
from the previous session, and refreshes native status without starting more
authenticated requests through stale component closures. Account content is
also hidden as soon as native status reports disconnected.

Setup stays mounted while a newly paired account loads its profile. Failed sync
has an explicit retry, and Play stays disabled until the account is ready.
Profile drafts survive a failed submission and reset when the account changes.
No game integration, economy, matchmaking, or database behavior changed.

## Verification

- Before the fix, new sustained-render checks reproduced the fault for both
  first installation and signed-out launch. They observe whether the setup DOM
  is detached across multiple polling intervals; a single visible assertion had
  missed the intermittent defect.
- All 21 launcher Playwright tests passed. Added coverage includes signed-out
  Settings and its open confirmation dialog remaining mounted, late native
  status/account responses after logout, Steam cancellation/retry, slow/failed
  profile loading, and retaining profile inputs after a rejected name.
- Browser layout captures cover first installation, Steam authorization, profile
  completion and signed-out Settings at 1360×820 and 960×640, alongside the
  existing tab/trade checks. The harness uses synthetic IPC responses; it does
  not sign in to real Steam accounts or install/uninstall the real game.
- TypeScript/Vite and the optimized Windows build passed. Rust verification
  passed 130 library and four integration tests; five existing child/manual test
  entries remain ignored in the top-level listing.
- The installed executable reports `B2G Launcher 0.2.40`; its SHA-256 matches the
  immutable release. The real application reopened, connected the bundled
  interface to Rust, and Windows reported its process responding. This confirms
  startup/IPC, not a native visual or real Steam sign-in acceptance test.

Local evidence: `.artifacts/launcher-setup-20260908/`, the Playwright report at
`.artifacts/tauri-polish-20260908/ui-results.json`, and launcher capture files in
`apps/launcher/.impeccable/review/tauri/`. The full 21-test run completed at
22:30 UTC; the final report contains the two layout confirmation tests rerun
after correcting the synthetic missing-installation fixture's explanatory copy.

Release artifact: `b2g-launcher-v0.2.40-windows-x86_64.exe`, 13,621,248 bytes,
SHA-256 `5aa2adc334008d3e2e1d22b7d3aa0c7ddefc253e1c2deddd08c16b25cccae307`.
Builds and checks ran locally; this commit skips push CI to avoid additional
GitHub Actions usage. The Classic port remains paused at the owner's request.

The existing application host now runs release `0.2.40-alpha.20260908.2240`.
Publication verified unchanged migration files, created a restorable database
backup, and used the existing rollback guard. An anonymous public download at
22:43 UTC matched the artifact checksum and executable version; the website's
download binding selects 0.2.40 and `/ready` reports healthy. The receipt is
`.artifacts/diagnostics/public-tauri-release-0.2.40.json`.
