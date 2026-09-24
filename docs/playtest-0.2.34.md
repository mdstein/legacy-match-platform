# B2G launcher 0.2.34 — clean-install startup fix

Published and externally verified on 2026-09-08 at 03:28 UTC. Launcher and web
are 0.2.34; the existing API and game node were not redeployed.

## Problem and fix

A fresh Steam installation failed before CS:GO created its window, with ICU 58
entry-point popups such as `UVector::insertElementAt` naming `icui18n.dll`.
The installed ICU pair's imports/exports matched. The wrapper only placed `bin`
on PATH, where Windows' system `icuuc.dll` takes precedence during subsequent
library dependency resolution.

An isolated x86 loader probe reproduced error 127 with the original search
behavior and selected Windows' system ICU. Loading from the game directory
succeeded. The client wrapper now explicitly loads both game-local ICU DLLs,
using absolute paths and DLL-directory/system-directory dependency search,
before the Steam/Source startup path. References remain alive for the process.
Missing runtime files produce an explicit Steam file-verification instruction.
This follows [Microsoft's LoadLibraryEx dependency search documentation](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw).

## Evidence

- Ten native CTests pass: the eight existing suites plus game-local transitive
  ICU loading and missing-runtime rejection. The loader fixture intentionally
  uses Windows' conflicting DLL basename and an export absent from that DLL.
- The real final-client Panorama archive and 390 Escape-close regression pass.
- All 122 Rust library tests and three executable checks pass. The production
  launcher and website image build successfully.
- The fixed launcher was installed locally after backing up the 0.2.33 launcher
  and wrapper under `.artifacts/launcher/rollback-icu-0.2.33`. The original Valve
  executable backup remained hash-identical. Settings and demos were untouched.
- A real paired launch at 03:05 UTC created CS:GO's Direct3D 9 window. Both ICU
  modules resolved to the game's `bin` folder. The B2G bridge connected, loaded
  172 owned items and submitted a signed regional latency measurement.
- Public download bytes, checksum, executable version, website release link and
  service readiness passed. Gameplay and two-account Friends acceptance remain
  human checks; this startup test did not queue a match.

Reproduction/evidence files are under `.artifacts/diagnostics/`:
`game-icu-before.jsonl`, `icu-load-probe.cpp`, `icu-wrapper-build.log`,
`icu-launcher-tests.log`, `icu034-local-play.json`, and
`public-startup-release-0.2.34.json`.

## Release

Download: https://play.back2go.net/downloads/b2g-launcher-v0.2.34-windows-x86_64.exe

- Launcher: 11,490,304 bytes; SHA-256
  `49f5173cc06cb9aebfe4d389058d5545385b33f32786af8aca8aa8ce41830249`.
- Game wrapper: 279,040 bytes; SHA-256
  `65bf01f46fd9bd923bbd2cbd30eea004c3e1a00a3075fafcea87c63805dea148`.
- GC DLL remains `d6fccb8aa127022bdb6a5eecdd80e33ab4e872ede9afc25ba7bc73a442a2a22a`.
- Hosted release: `/opt/aftertick/releases/0.2.34-alpha.20260908.0305`.
- Web image: `aftertick-web:b2g-20260908-0305`, Docker image ID
  `sha256:00c6dac6d52075459734fb6d7c79b4f4650c42f92c787d42e452c54be6a088df`.
- Website asset: `/assets/index-BlBDf7_-.js`.

Rollout verified archive/image checksums and unchanged topology, retained the
previous release environment, and replaced only the web container with rollback
on failure. The API container ID was verified unchanged. No migration or data
restore was run.
