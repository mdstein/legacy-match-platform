# Files not included in the public source

This fork of csgo_gc (BSD 2-Clause, see `LICENSE`) does not ship Valve's files:

- `steamworks/sdk/public/steam/*.h` — Steamworks SDK headers (Valve Corporation).
- `steamworks/sdk/public/steam_old/*.h` — older Steamworks interface declarations
  taken from earlier SDK releases.
- `protobufs/*.proto` — game-coordinator message definitions.

The upstream csgo_gc project provides these at the same paths; copy them from there
before building. `steamworks/sdk/public/proxy` contains csgo_gc's own proxy code.

`prebuilt/windows-x86` contains binaries built from this source (see
`prebuilt/windows-x86/PROVENANCE.md`); they are included because the launcher embeds
them at build time.
