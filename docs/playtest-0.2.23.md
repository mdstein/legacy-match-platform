# Launcher 0.2.23: native startup freeze

**Follow-up, 2026-09-07 01:41 UTC:** the owner successfully launched this build and
played Deathmatch. The [production game node was then updated to 0.1.23](game-node-0.1.23-deployment.md)
to enable the server-side unboxing and StatTrak changes. The original local-build
checkpoint below predates that server deployment.

This replaces the withdrawn 0.2.22 launcher. It is a local repair candidate,
not an installed client or website deployment. Node 0.1.23 and the embedded GC
are unchanged. The API and game-node deployment gates in the previous checkpoint
still apply to full gameplay acceptance.

## Reproduced cause and fix

The user's two attempts to open 0.2.22 produced Windows Application Hang events
1002 at approximately 01:08 UTC on 2026-09-07. The launcher log stopped after
opening the dashboard. `sync_controls` held the shared UI mutex while calling
`EnableWindow` and `SetWindowTextW`. Windows synchronously delivered an owner-draw
callback, whose painter tried to acquire the same mutex on the same thread.

The fix copies the required label/enabled values and releases the mutex before
calling Windows. Startup logs now distinguish window creation and the first
completed paint/message-loop handoff. This does not change the dashboard design,
game protocol, inventory rules, queue behavior or game files.

The prior memory-render tests could not reproduce HWND message reentrancy. A new
native-window regression runs in a separate child process with a 12-second
watchdog. It creates an off-screen Windows window, uses the production button and
message handlers, completes a synthetic bootstrap through the Windows message
queue, changes enabled/text states, resizes and closes the window. It reads no
credentials, contacts no API and launches no game.

Before the fix, this test hit its watchdog while completing bootstrap. After
the fix, the same debug test passed in 0.16 seconds and the optimized release
regression passed in 0.11 seconds.

## Verification and artifact

- Full Rust suite: 77 library tests and the version CLI test passed. The child
  helper is ignored by the regular harness and invoked by the watchdog test.
- Optimized native-window regression: passed, including its explicit completion
  marker to ensure the child actually exercised the window.
- API release metadata suite: 18 tests passed.
- Launcher release packaging, website build and API build: passed.
- Source and website-build download copies have matching SHA-256 checksums.

The local executable is
`apps/web/public/downloads/b2g-launcher-v0.2.23-windows-x86_64.exe`
(9,803,776 bytes). Its SHA-256 is:

```text
04f9e53aa31c28c645407fdb34a77608068cd55fdb95e58944f522eb27c2c274
```

The packaging manifest is `.artifacts/releases/launcher-0.2.23.json`. No 0.2.23
container image archive has been prepared; the withdrawn 0.2.22 website image
still contains the faulty old launcher and must not be deployed.

## Try the repaired dashboard

Close the old launcher, then run from the repository in PowerShell:

```powershell
.\apps\web\public\downloads\b2g-launcher-v0.2.23-windows-x86_64.exe ui
```

`ui` previews this executable without installing it. Let the account refresh
finish, click Refresh, resize/minimize/restore, and close it. It should remain
responsive. The owner subsequently confirmed successful game use of this exact
build; the remaining desktop interaction checklist still needs observation.

GO starts the real client and can apply its bundled GC; it is not part of the
dashboard-only preview. Full gameplay testing still needs the coordinated API
and node deployment and the local client repair. Nothing was published or
installed to address this startup report.
