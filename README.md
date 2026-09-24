# B2G legacy match platform

This is the earlier (2023-client) version of B2G, a community matchmaking platform
for a legacy Source engine shooter: a desktop launcher, matchmaking API, web app,
game-node agent, SourceMod match plugin and a replacement game-coordinator library.
Its successor, B2G Classic, targeted the 2018 client and is published separately.
Both are **discontinued**. This repository is an archive of the source code under
the GPL-3.0; it is not maintained and there is no hosted service.

## Important

- **Not affiliated with or endorsed by Valve Corporation.** Game names mentioned
  in the source and documentation are trademarks of their owners.
- **No game assets are included.** Valve's artwork (item icons, map and rank
  images, logos), game files, Steamworks SDK headers and game-coordinator message
  definitions were removed before publication. Parts of the UI and build therefore
  reference files that are not in this repository.
- The code expected every player and server operator to own the game and obtain
  its files from Steam themselves. Distributing a game's assets or engine code
  requires a license from the rights holder; this project does not grant one.

## Layout

| Path | What it is |
|------|------------|
| `apps/launcher` | Tauri desktop launcher (Rust core, React UI) |
| `apps/api` | Matchmaking, inventory, trading and account API (Node.js) |
| `apps/web` | Web front end |
| `apps/node-agent` | Game-node agent that runs and supervises dedicated servers |
| `packages/` | Shared contracts, database migrations and services, rating |
| `infra/` | Server configuration, the SourceMod match plugin and infrastructure code |
| `vendor/csgo-gc` | Fork of the BSD-licensed csgo_gc game-coordinator emulator (see its `THIRD_PARTY.md`) |
| `scripts/`, `deploy/` | Development, release and host provisioning scripts |
| `docs/` | Design notes, investigations and runbooks written during development |

`docs/development-notes.md` is the original developer README.

## License

GPL-3.0-only (see `LICENSE`). Third-party components keep their own licenses:
`vendor/csgo-gc` (BSD 2-Clause, see `vendor/csgo-gc/LICENSE`), the bundled Geist
Mono and Rajdhani fonts (SIL Open Font License, license files beside them) and npm/Cargo
dependencies under their respective licenses.
