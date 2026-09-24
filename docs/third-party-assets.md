# Third-party assets

## CS:GO matchmaking rank icons

- Source: [`itzarty/csgo-rank-icons`](https://github.com/itzarty/csgo-rank-icons/tree/main/matchmaking)
- Pinned source commit: `29cde4ddd2758458f1c67653ad32e0198b5484f9`
- Local files: `apps/web/public/ranks/1.svg` through `18.svg`
- Mapping: numeric source order maps to Silver I through The Global Elite in `packages/rating/src/ranks.ts`.

The source repository states that these assets were extracted from the CS:GO game binaries and does not declare an open-source license. Counter-Strike, CS:GO, and the rank artwork are property of Valve Corporation. They were used only in the private playtest and are **not included in this public release**.

## B2G map-selection plates

- Files used by the player application: `apps/web/public/plates/map-mirage.png`, `map-inferno.png`, `map-nuke.png`, `map-overpass.png`, `map-vertigo.png`, `map-ancient.png`, and `map-anubis.png`.
- Authored source copies: `assets/plates/`.
- Origin: original environment artwork produced for B2G with OpenAI image generation; these are not screenshots or extracted Counter-Strike map assets.
- Provenance: every PNG carries its full generation prompt in embedded metadata. Prompts can be audited with `.agents/skills/impeccable/scripts/embed-prompt.mjs --read <file>`.
- Constraints applied during generation: no logos, interface elements, signage, player characters, weapons, or copied game assets; restrained documentary color and map-readable architectural cues only.

The plates visually reference the broad environment categories needed to distinguish the B2G map pool. They do not claim to be official Valve artwork or exact reproductions of Counter-Strike levels.

The plates are **not included in this public release**, because they depict the game's maps.

## SourceMod Anti-Cheat

- Source: [`Rushaway/sm-plugin-SMAC`](https://github.com/Rushaway/sm-plugin-SMAC), pinned to `ea15f3ec0c8d9c499d0e42d7174675dd6d30780b`.
- Build dependency: [`srcdslab/sm-plugin-MultiColors`](https://github.com/srcdslab/sm-plugin-MultiColors), pinned to `d2f2dc9126255571c0fc4499d5729cacb57265ca`.
- License: GPL-3.0-or-later for SMAC; MultiColors is distributed under GPL-3.0.
- Release contents: selected compiled `.smx` modules, translation, provenance, both license texts, and complete source archives at the exact commits.

B2G does not modify the upstream source. `scripts/build-smac-plugins.mjs` verifies the commits, compiles only the documented evidence-oriented module set, and packages corresponding source so distributed game-node releases retain the required notices and source.

## NoLobbyReservation

- Source: [`nuxencs/NoLobbyReservation`](https://github.com/nuxencs/NoLobbyReservation), pinned to final-CS:GO update `fb575d575d88a0b3d70acc619f8d4d3223e12814`.
- Runtime inputs: `nolobbyreservation.sp` and `nolobbyreservation.games.txt`, each protected by an expected SHA-256 in `scripts/install-game-toolchain.ps1`.
- Purpose: allow direct Source 1 connections without an unavailable Valve lobby reservation.
- License: the upstream repository declares no license.

The B2G release archive does not redistribute this third-party source or compiled binary. During operator-controlled provisioning, the game node fetches the two exact files directly from the pinned upstream commit, verifies their hashes, and compiles the plugin locally with the pinned SourceMod toolchain.

## CS:GO archived-client Steam ticket fix

- Source: [`eonexdev/csgo-sv-fix-engine`](https://github.com/eonexdev/csgo-sv-fix-engine), pinned to `14e4d6b5e5b8c2f36446942daaf87b1beb8067b3` (patcher v2.1).
- Runtime inputs: `csgo_steamfix.ext.dll` and its empty `csgo_steamfix.autoload` trigger, protected by expected SHA-256 values in `scripts/install-game-toolchain.ps1`.
- Purpose: route AppID-4465480 archived-client Steam tickets through the final CS:GO server engine's accepted validation path instead of its wrong-game rejection path.
- License and signing: the upstream repository declares no license and the Windows DLL is not Authenticode-signed.

The B2G release archive does not redistribute this third-party binary. During operator-controlled provisioning, the game node downloads the exact Windows extension from the immutable upstream commit and rejects it unless its SHA-256 is `17C5D14AE141D20B25B8931983F98647BAE6CCDF527698101C3E217B0EF071D2`. The same bytes are used by the working [`FNScence/CSGO-Legacy-Server`](https://github.com/FNScence/CSGO-Legacy-Server) setup. The file was additionally scanned with Microsoft Defender before the first production deployment.

## Legacy Steam inventory research

- Reference implementation reviewed: [`Toaaa/csgo-inv-patcher`](https://github.com/Toaaa/csgo-inv-patcher), commit `6217ca37bc10f120e90fdfb3fc5753f7b2989d73`, AGPL-3.0.
- Server-side alternatives reviewed: [`kgns/weapons`](https://github.com/kgns/weapons) and the skin-changer setup documented by [`FNScence/CSGO-Legacy-Server`](https://github.com/FNScence/CSGO-Legacy-Server).

No code or binary from these projects is copied or distributed by B2G. The B2G launcher independently implements a narrow metadata synchronization with backup and restore. Unrestricted server skin changers were rejected because they synthesize cosmetics regardless of Steam ownership, which conflicts with B2G’s owned-items-only requirement.
