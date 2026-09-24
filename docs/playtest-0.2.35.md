# B2G launcher 0.2.35 — restored skin loadouts

A reinstall exposed a loadout restoration bug: web preferences select an item
per weapon definition, but the manifest expands each selection to both teams.
The affected inventory had an AK and M4 in both teams' rifle slots, two knives
in both knife slots, and a USP assigned to T. The local saved loadout retained
those assignments. Server validation rejects a conflicting cache in full,
so otherwise valid skins disappeared in Practice with Bots and Deathmatch.

The client now reads `used_by_classes` from the game schema, including inherited
prefabs, and reconciles owned equipment on startup and inventory reload. It
preserves valid team choices and resolves ambiguous slots using the newest
asset ID. It also rejects new unsupported-team equips before displacing any
existing selection. No items or cosmetic attributes are removed or changed;
ownership-generation checks and server validation remain intact.

The local reset helper now preserves `b2g_loadout_<SteamID>.txt` and saved
shuffles alongside settings and demos. Its dry run includes those files;
no installation reset was performed for this release.

## Verification

- The new regression failed against the previous implementation. It covers a
  fresh install, conflicting saved equipment, inventory refresh, both server
  acceptance paths, inherited team restrictions, and separate T/CT knives
  after a restart. All ten native suites pass.
- The real Panorama archive and 390 Escape-close regression pass.
- All 122 Rust library tests and three executable checks pass; five existing
  interactive/opt-in tests remain ignored. The production launcher and website
  image build successfully.
- A copy of the affected inventory produced: 172 owned items, 11 initially
  equipped items, original cache rejected, 10 repaired equipped items, and
  acceptance by both practice and server validators. The extra knife remains
  owned and can be selected normally.
- Installed locally with backups under
  `.artifacts/launcher/rollback-loadout-0.2.34`. CS:GO reopened at 03:59 UTC;
  its live GC log confirms five repaired assignments and 172 loaded/published
  owned items. The launcher bridge connected successfully. Visual rendering
  inside a new bot/Deathmatch session remains the user's playtest check.
- Public download bytes/checksum, executable version, website release binding,
  protected routes and service readiness passed at 04:04 UTC. Receipt:
  `.artifacts/diagnostics/public-loadout-release-0.2.35.json`.

## Release

- Download: https://play.back2go.net/downloads/b2g-launcher-v0.2.35-windows-x86_64.exe
- Launcher: 11,495,424 bytes; SHA-256
  `7b23a8e394642ee169cb391da7383b4f5d5817775f81033d9cfd4346c668b236`.
- GC DLL: 1,879,040 bytes; SHA-256
  `210895abd0cf57e8cc6d4c3b090e30cc4243162df8f081867c5037cd5ca1635f`.
- Hosted release: `/opt/aftertick/releases/0.2.35-alpha.20260908.0400`.
- Web image: `aftertick-web:b2g-20260908-0400`, ID
  `sha256:aeeefcfb7ed14054a728cd3b1df381b03ff5d7c6f02e13947ac0e33e5719ee9f`.

The rollout verifies archive/image checksums and unchanged topology, retains a
rollback environment, and replaces only the web container. API, data services
and game node 0.1.28 remain on their existing releases. The startup ICU fix
remains in the client wrapper. Diagnostic receipts are under
`.artifacts/diagnostics/loadout035-*`.
