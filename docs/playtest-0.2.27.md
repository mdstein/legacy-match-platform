# Native launcher reference polish 0.2.27

Independent review disposition: **ship**, with all five scored fixes resolved.
Deployed as `0.2.27-alpha.20260907.0545`; allocations reopened at 05:56:11 UTC
on September 7, 2026. The public executable, SHA-256 sidecar, version CLI,
website version binding and public API readiness were verified. Game-node
0.1.26 and the 0.2.26 embedded GC are retained. No gameplay/economy changes or account grants.

## What changed

The native Rust/Win32 dashboard follows the owner's ZIP: a 56px integrated
header, compact horizontal profile, 300/flexible/320 wide columns, image and
bottom scrim, compact release history, Rajdhani/Geist Mono type, and a 64px Play
action in the persistent launch bar. At 1024px it keeps usable 250/flexible/264
columns instead of reproducing the prototype's overflowing compact grid.

Actual rank emblems and access state remain. Initials are used because the
bootstrap has no authoritative avatar field. Extra Store/Inventory/Stats/social
navigation, fake counts/ping/news, kernel-driver claims and simulated progress
are omitted. News and error text is selectable and scrollable in a native
owned window. Available updates link to the versioned official download.
The existing Steam, GC, inventory, party and queue workers are retained.

The 0.2.26 economy fixes remain: medal action only at 40; two independent
93% case / 5% souvenir / 2% pin container rolls plus graffiti; dark purple
#8847ff in container chat. No profile, XP, inventory or prestige reset occurred.

## Reference evidence

Source ZIP SHA-256: f0ea14374b6fa3ae96c1a6828a2366ad9b8a9d6001ca4daa2b339d0b9540b096.
Reference captures and computed CSS geometry: `.artifacts/reference-harness/captures`.
Before: `.artifacts/launcher-ui-0.2.26-baseline/ready.png`.
Candidate: `.impeccable/review/native-0.2.27`, including matched region pairs.

The matrix covers 1024×664, 1280×780 and 1360×800 logical client sizes at
96/120/144/192 DPI (100/125/150/200%). Fixtures include signed out, pairing,
ready, starting, running, exited, repair/error, stale/offline, update, level 40,
empty content, long/expired access, hover and focus. Matrix images are pure
memory rendering. `native-window.png` and `native-details.png` use PrintWindow
on isolated offscreen HWNDs at the machine's 125% DPI; these are not desktop
captures or the owner's live account. They exercise actual child controls/frame.

## Performance evidence (final reviewed candidate)

Three newly started release-build processes on the same machine; the OS file
cache was not flushed. Measurements exclude
network/authentication and game startup. The benchmark uses the same first-paint
and 8-resize section as the saved 0.2.26 executable; later window tests occur
after the timed section. Idle samples span two seconds each.

| Measurement | 0.2.26 median | 0.2.27 median |
|---|---:|---:|
| First paint including private fonts | 31.68 ms | 41.14 ms |
| Process start to fixture ready | 88.92 ms | 109.02 ms |
| Eight resize/control cycles | 28.00 ms | 30.38 ms |
| Working set | 21.21 MiB | 21.29 MiB |
| Private memory | 6.84 MiB | 6.76 MiB |
| Idle CPU consumed in 2 s | 0.00 s | 0.00 s |

Final first paint increases by about 9.5 ms, staying below 44 ms in all three
runs, for four extra private font faces, measured text fitting and the richer
painter. The median resize increase is about 2.4 ms across eight cycles (0.3 ms
per cycle). Working memory changes by about 76 KiB; private memory falls slightly.
Two final idle samples consumed zero CPU time, one consumed one 15.625 ms timer
quantum over two seconds (about 0.78% of one core); all three baseline samples
were zero. These short samples do not establish a sustained CPU rate.
Process-ready time is noisier (315/101/109 ms final versus 208/78/89 baseline),
including process creation, OS caching/scheduling and the readiness-file sampler.

Final executable: 10,002,944 bytes, up 156,160 bytes (1.59%) from 0.2.26.
The four additional font files account for 118,212 bytes before linking.
No production JS/browser runtime, new polling or network image fetches were added.
These are UI fixture measurements, not FPS, network or gameplay-latency claims.
Raw results: `.artifacts/launcher-polish/performance-0.2.27-final.json` and
`.artifacts/launcher-0.2.26-source-baseline/performance.json`.

## Verification and external checks

83 Rust tests and the executable version CLI pass. The native watchdog covers
real owner-draw reentry, control updates, title-bar resize/drag hit tests, all
visible tab targets, native minimize/close, bounded full-text scrolling and
hidden maximized work-area geometry. Suggested DPI rectangles are exercised;
a final hidden-HWND monitor check enumerated one available display at 120 DPI
(125%) and verified actual control scaling on it. Physical mixed-display dragging
and real fullscreen maximize appearance require human observation. Maximize geometry tests do not claim that observation. The additional monitor
check passed in `.artifacts/diagnostics/launcher-0.2.27-monitor-test.log`.
API TypeScript checks and the authenticated bootstrap contract test (including
shared release history) pass. No new GC build was needed; existing embedded pins
must be verified during immutable staging.

Close CS:GO and any old launcher; download [launcher 0.2.27](https://play.back2go.net/downloads/b2g-launcher-v0.2.27-windows-x86_64.exe) and run it with `ui`.
Check tab/focus, hover, drag/resize, maximize/restore, minimize, Details scrolling,
and Play → starting → running → closed. Open long news and any error in Details.
Confirm your own Steam pairing, skins and in-game queue still work. Physical
mixed-DPI monitor transitions and subjective fidelity to the reference remain
human acceptance checks. No new live multiplayer or 5v5 observation is claimed.

## Artifact and review

Launcher 0.2.27 SHA-256:
`cb265a920484c7100189c411d0270032a82737994ebf195c5a2a5c3e326a69d4`.
Embedded GC SHA-256:
`4402b8646294b8c70ce24df028e7fd8b98bc78229891dfd739342d46039b63da`.
Immutable staging verifies executable identity, launcher/shared version agreement,
both GC asset pins, package size and checksum sidecar. Game-node remains 0.1.26.

The initial independent review accepted reference fidelity with documented
native/content adaptations and identified state clarity, footer clipping,
long-summary truncation, native button edges and unsupported seed provenance.
One correction batch resolved all five; all 31 originals were independently
reopened in the verdict pass. The **ship** verdict covers those scored fixes,
with the original review's offscreen/live-observation limits retained.
Reports: `.artifacts/launcher-polish/finish-review-0.2.27.md` and
`finish-verdict-0.2.27.md`. Asset provenance scan: one raster, zero missing.

## Deployment and rollback

Public verification at 05:58:39 UTC: `.artifacts/releases/launcher-0.2.27-public-verification.json`.
Website bundle `/assets/index-C3qRGY1g.js` binds the advertised launcher version
to 0.2.27; its generated download filename uses that binding. The initial
literal-object assertion did not account for Vite's constant extraction; the
actual version binding was inspected and verified, not assumed from a string hit.

API image ID: `sha256:05fdc58feaa0038f1049f5a897c864cf51ba21b345f65a40e145f703cce45059`.
Web image ID: `sha256:22e2e950a550873c9ab00d65cca508fb79f69917daea95ee498fe2781b9c9678`.
Image archive SHA-256: `cf05190c4d3557de7e1f0834f2507c1178cbff9d4f8777f41cd3e29a42925350`.
App-host ZIP SHA-256: `46441a29bb44f300e8d2b77c9a229dc46a4c19eaca266f70f3a1e087bda78697`.

The prepared script verified the previous 0.2.26 release and images, both input
archives, no active leases/recent pending allocations, and the allocation hold.
It backed up PostgreSQL and release configuration, installed the pinned images,
and retained a rollback trap. No database migration was pending.
Backup: `/var/backups/aftertick/pre-0.2.27-alpha.20260907.0545.dump`, SHA-256
`b8c7a4f0cf06391d8ec38b4fb16237fb7fe55ae60946ef5a3069022342609c05`.
Previous app release and environment remain for rollback. No node stop/install
command, game-file replacement or account mutation was performed. The reopened
node reported active/ready, plugin 0.1.7, fresh RCON health and no active lease.

The documentation agent hit its usage limit before writing; the native
DESIGN.md and schema-v2 sidecar were refreshed locally from final source using
the skill's fallback. Root website design guidance was left unchanged.
