# Launcher 0.2.30 / game node 0.1.28

Deployed September 7, 2026; matchmaking and trading reopened at 20:44:34 UTC.
Download: https://play.back2go.net/downloads/b2g-launcher-v0.2.30-windows-x86_64.exe
Close CS:GO and the old launcher, then run the new executable to load its GC and
Panorama changes.

## Changes

- Four native tabs: Play, Trading, Match History and Settings. Settings saves
  account preferences, region, privacy and notifications; provides logs,
  diagnostics, repair and account disconnection. Website default mode is labeled
  explicitly; native matchmaking mode is selected inside CS:GO.
- Match History includes Deathmatch and competitive results, eight-row paging,
  full selectable match details and authenticated demo downloads. Downloads are
  size/hash verified before promotion; failed downloads preserve existing files.
- The launcher starts without a console. Settings > Launcher & debugging can
  open a separate session-only log viewer; closing it leaves the launcher/game
  running. Logs are always saved, and CLI redirection still works.
- Trading checks leave controls active, retain local gift confirmation/errors,
  and do no redraw work for unchanged responses. Read acknowledgments also run
  in the background. Requests are fenced by account, view and foreground epoch.
- A shared antialiased icon system replaces the rough refresh, people and other
  controls. Settings/history preserve the active-game footer and keyboard focus.
  Repair and disconnection exclude launching the game until they finish.
- Profile levels now require 1,000 XP throughout the API, game node, plugin,
  launcher and the final-client card/tooltips/end-of-match progress display.

## Existing XP and rewards

Migration 033 preserves current levels and all unspent XP, grants ordinary
rewards for every newly crossed level, and banks XP beyond level 40 for the next
service-medal redemption. Lifetime XP stays unchanged. Conversion receipts,
profile changes and grants commit atomically. The migration lock prevents replay.
Each earned level still grants two primary containers and one graffiti; the
container distribution stays 93% cases, 5% souvenirs and 2% pins.

Production converted two accounts: 400 total XP before and after, zero bonus
levels and zero banked XP. cubsfan49 retained level 1 / 400 XP, now 600 XP from
level 2. No synthetic account reward or reset was performed in production.

## Verification

- All-workspace TypeScript checks and production builds pass; 211 JavaScript
  unit tests pass. Environment-dependent suites run separately.
- Full database integration run: 87 passing checks. The additional real-DB
  history regression passes: Deathmatch contributes to total, and equal-date
  results page consistently without duplicates or omissions.
- Conversion tests cover old 4,900/4,999 XP, multiple levels/rewards, level-40
  banking, redemption carry-over, concurrent migration calls and full rollback
  after an injected grant failure.
- Launcher: 111 library checks and three executable checks pass, plus the
  targeted connected-account rendering check. Three child entrypoints are
  invoked by their watchdog tests rather than independently.
- Native Settings journey covers saved/unsaved preferences, navigation during
  a save, pagination, details and game/repair exclusion. Demo tests cover bearer
  authentication, binary contents, hash/size failures and existing-file safety.
- All eight GC CTests pass; the real final-client archive patch and 390
  Unlock/Escape-close regression pass, as do normal reveal cycles.
- Impeccable final scored-fix verdict: ship. 83 required captures include a
  memory-GDI size/DPI matrix, targeted states and four actual offscreen HWND
  captures on this host at 125% DPI. It does not establish all-monitor or
  screen-reader coverage. Design documentation and sidecar were merged.
- The public executable/checksum/version and website version binding were
  verified. Account/history/demo routes reject unauthenticated requests with
  401. PostgreSQL, Redis and object storage readiness pass.
- Game-node package: 28 checked files; installed GC/plugin hashes match, node
  reports 0.1.28, scheduled task uses Normal priority, RCON responds and the
  fresh instance is ready. Zero human players were present during maintenance.

## Release evidence

| Artifact | SHA-256 |
|---|---|
| Launcher, 10,615,296 bytes | `458adcb87ba4370e732d7b6a65ec3a9149c64904ee833cbaad8c8ddf798f66be` |
| Shared GC, 1,874,944 bytes | `d6fccb8aa127022bdb6a5eecdd80e33ab4e872ede9afc25ba7bc73a442a2a22a` |
| Game node 0.1.28 ZIP | `3e6e014cba035342da3a4a625f6f1f585f23be74f136dd70fd26d5129b5a8d9a` |
| Match plugin (reports 0.1.7) | `3565b6bd0cd4d8a912d51cbe53df532cfc3d5a3d2416b4bd79e8506c394ca32e` |
| API/web image archive | `12947a04341ca15ae7a3a4efbe245fa047dccef37a93abda2257ca3042ab432e` |
| App-host ZIP | `ed7bae4f918360dba483ff25f232cdec799e3399b470b62d198afae2f56520fb` |

Active app release: `/opt/aftertick/releases/0.2.30-alpha.20260907.2035`.
API image: `aftertick-api:b2g-20260907-2035`, manifest-list ID
`sha256:488d4cce268555e5ab5c0e40453bf930bd84a71860167f85e45b27612f1faab8`.
Web image: `aftertick-web:b2g-20260907-2035`, manifest-list ID
`sha256:25f7d71d685d91f7da6a5297c1a0861e102a07521bf6a0669926d74c10024a8a`.
Public web asset: `/assets/index-DYR0x_mL.js`.

Verified DB backup: `/var/backups/aftertick/pre-0.2.30-alpha.20260907.2035.dump`,
SHA-256 `d8869cecaef1b8f26952c5f8c76d49f05568725b293fcbcf5222e33a28cc8af3`.
Windows backup: `C:\ProgramData\Aftertick\backups\before-node-0.1.28-20260907T204126Z`.
Trading is enabled, control version 4; ownership diagnostics are clear.

## Human acceptance still needed

Run the new launcher on your own display; toggle/close the debug viewer; save a
preference; inspect both history modes, details and a real downloadable demo.
While exchanging a real trade, confirm that automatic updates stay fluid and
selection/focus remain stable. Play a match and observe the in-game 1,000-XP
bar and level rewards. Existing live trade/StatTrak, long unboxing soak and
physical monitor-transition checks remain as described in earlier releases.
These checks do not require recruiting a full 5v5.

After migration 033, use a compatible forward fix if recovery is needed. Do not
resume a 5,000-XP API against converted profiles or restore the backup over new
inventory activity. The deployment kept the API stopped during conversion and
held allocations/trading until compatible node readiness was verified.
