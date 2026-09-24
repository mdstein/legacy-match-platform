# Windows launcher

The launcher is the Windows entry point for the private alpha. Since 0.2.39, its interface runs in Tauri 2 with a bundled React frontend: Play, Trading, Match History, Friends and Settings. Double-clicking the executable installs the per-user protocol handler and opens the launcher. Credentials, game sessions, installation and authenticated API requests remain in Rust. It is not an anti-cheat.

## Launcher-first game session

`Play` refreshes the paired account's available Steam-owned inventory, verifies/repairs the pinned compatibility GC, starts a credential-free local named-pipe broker, and launches CS:GO. Private, empty or temporarily unavailable Steam inventories do not prevent launching with B2G-owned items. The final 2023 Panorama interface remains the supported game shell for this phase. The launcher must remain open for the session: starting CS:GO directly from Steam intentionally produces only a minimal profile and cannot authenticate matchmaking. Pressing Play or Cancel inside Panorama sends the original 9101/9102 protobuf through the local GC; the launcher maps only proven Competitive/Premier and Deathmatch modes into authenticated B2G requests. Unsupported modes fail visibly instead of being guessed.

The broker accepts only the exact CS:GO executable discovered by the launcher and verifies that its SteamID matches the browser-paired account. The Windows Credential Manager bearer token never enters the game process or pipe. At session startup, the launcher obtains and submits its own short-lived signed regional latency challenge, so every native party member is route-ready before the lobby leader starts a search. B2G sends population, queue phase, competitive rank/wins, and profile level/XP back through the GC's existing 9104/9110/9194 messages.

B2G grants one non-tradable service-drop receipt on each real service-level increase. The game node presents it through the final client's native generic end-of-match reward path, relabeled `B2G Service Drop`; the launcher shows the accumulated count. This path never creates or modifies a Steam economy item.

Native parties remain Steam lobbies. When the lobby leader presses Play, the compatibility GC queries `ISteamMatchmaking` for the current owner and member roster instead of trusting account IDs in the matchmaking protobuf. The API resolves every SteamID to an onboarded B2G player, requires a non-revoked paired launcher used within the previous 15 seconds, applies queue eligibility and latency rules to every member, then creates one atomic Redis party ticket. Only the Steam lobby owner may initiate or cancel it. Each member still makes an individual match decision through the original ready prompt; local lobby data is never treated as acceptance. A follower who never accepts a leader-started native search is not given a ready-check cooldown, which prevents a locally forged roster claim from punishing another active account; the initiating leader and ordinary solo tickets retain the normal cooldown policy. Panorama's native player-profile requests also cross the PID-verified bridge: the API returns bounded B2G rank, wins, service level, and XP for the paired player and profiles visible to authenticated players, while private profiles remain minimal.

When Competitive finds ten players, the compatibility GC raises the final 2023 client's native `ServerReserved` and `PanoramaComponent_Lobby_ReadyUpForMatch` events. Panorama therefore supplies its original alert sound, green accept button, accepted-player count, and deadline; the button's `SetLocalPlayerReady("accept")` call is authenticated and forwarded to B2G instead of being accepted automatically. An assigned server still uses the proven post-start `WM_COPYDATA` handoff; the one-match password is never placed in a command line.

The pre-Panorama menu is explicitly deferred. Replacing Panorama is not part of the 0.2 line and must remain a separately reversible experiment after launcher-first matchmaking is stable.

## Commands

For a fresh B2G installation, close CS:GO and open **Settings → Launcher → Uninstall B2G**.
After confirmation, the launcher restores the original Valve executable, removes its managed GC,
then closes and removes the installed B2G executable, Start-menu shortcut and `b2g://` registration.
Steam's CS:GO remains installed. Local settings, demos, equipped loadout and account data are kept;
server-owned B2G items are unchanged. Download and run the launcher again, then press Play to
reinstall the integration without downloading CS:GO again. Launcher settings also provide
Repair game integration and Install CS:GO when the game is absent. Removal works while signed out.

Removal preflights the original game backup, managed file hashes and launcher registration.
It refuses live game sessions, other running installed launcher instances, linked target paths
and changed files. The installed executable is deleted only after the current launcher exits.
Failures leave an actionable message; helper-stage failures also write `B2G/logs/uninstall.log`.

```text
b2g-launcher doctor [--json]
b2g-launcher ui
b2g-launcher probe --server HOST:PORT [--samples 1-10] [--json]
b2g-launcher connect --server HOST:PORT --password TOKEN [--dry-run]
b2g-launcher protocol b2g://connect?... [--dry-run]
b2g-launcher install [--dry-run]
b2g-launcher install-protocol [--dry-run]
b2g-launcher inventory-sync [--dry-run]
b2g-launcher inventory-restore [--dry-run]
b2g-launcher game-repair [--dry-run]
b2g-launcher diagnostics [--json]
b2g-launcher game-uninstall [--dry-run]
b2g-launcher authorize [--api HTTPS_ORIGIN]
b2g-launcher account-status [--json]
b2g-launcher logout
b2g-launcher play
b2g-launcher check-update --manifest URL
b2g-launcher self-update --manifest URL
b2g-launcher verify-update --file EXE --sha256 HEX --publisher-identity-eku OID
b2g-launcher apply-update --parent-pid PID --staged EXE --target EXE --sha256 HEX --publisher-identity-eku OID
```

`doctor` discovers Steam across its configured library folders and prefers Valve's standalone CS:GO App 4465480. It falls back to App 730 only when `BetaKey=csgo_legacy`, then checks the legacy `csgo.exe` and build metadata. `connect` and `protocol` accept only a strict host/IPv4/IPv6 endpoint and base64url-style one-match password. Diagnostics redact the password. The launcher starts the discovered App ID through Steam with `-novid -condebug -conclearlog`. After it verifies the game window, it sends the password and connect commands through Source's `WM_COPYDATA` command channel; no shell command is composed and credentials are never put in the Steam process command line.

## Steam-owned inventory access

App 4465480 does not provide the old CS:GO Game Coordinator services needed by the native Inventory, Loadout, and Escape-menu data paths. B2G therefore installs a pinned local-GC compatibility wrapper for this standalone legacy client and installs the matching server component on each B2G game node. Before replacing a game file, the launcher verifies the expected layout and creates managed backups such as `csgo.exe.b2g-original`; the executable wrapper is activated last. `game-repair` verifies and reconstructs the managed install, `game-uninstall` restores the original files, and `diagnostics --json` records versions, hashes, backup paths, and game-console evidence without exposing the match password or inventory token.

The local GC is owned-only. At game-session startup, the API fetches a fresh public App 730 Steam inventory for the paired SteamID and validates every item and inspect link against the pinned legacy economy catalog. Match handoffs retain a short-lived match-scoped grant. The client receives all compatible owned items—including paint kit, wear, seed, StatTrak value, custom name, and sticker attributes—so multiple skins for one weapon appear in the native Inventory and can be selected in the native Loadout. The server independently loads the signed player policy and rejects unowned asset IDs, immutable-item changes, invalid slots, duplicate equips, item creation, item destruction, fake ranks, purchases, crafting, and cross-player item use. Only the local equipped choice is mutable; ownership and cosmetic attributes always come from server-verified Steam data.

For the App 730 fallback only, `inventory-sync` retains the prior narrow `steam.inf` compatibility repair. Its first change creates `csgo/steam.inf.b2g-backup`; `inventory-restore` restores that exact backup. Cosmetics introduced only for CS2 may not have a legacy definition or model and are omitted rather than approximated.

`probe` sends bounded Source A2S UDP queries, handles challenge responses, and reports median/p95 latency, successful samples, and packet loss. The standalone command is credential-free. In the player flow, the authenticated API issues a `b2g://probe` link containing one short-lived challenge, one-use HMAC key, HTTPS submission URL, and the exact regional endpoints. The launcher validates the link, measures every issued route, signs the canonical report, submits without browser cookies, and the API rejects replay, tampering, expiry, endpoint rotation, insufficient replies, or excessive loss.

## Build and test

```powershell
npm run launcher:test
npm run test:ui --workspace @aftertick/launcher-ui
npm run launcher:build
npm run launcher:doctor
powershell -ExecutionPolicy Bypass -File .\scripts\test-launcher-signing.ps1
```

Run `npm ci` first. The launcher build/test scripts compile the bundled interface before Cargo; direct Windows Cargo builds require an existing `apps/launcher/dist`. `npm run dev --workspace @aftertick/launcher-ui` serves frontend development on localhost:1420, and `npm run build --workspace @aftertick/launcher-ui` checks TypeScript and bundles assets. Browser tests inject an isolated Rust-command fixture; production builds contain no fixture account or mock mode. Install Playwright Chromium with `npx playwright install chromium` before the UI suite.

The Windows runtime uses the installed Evergreen WebView2 runtime. If missing, it downloads Microsoft's small bootstrapper, verifies its Authenticode publisher, then opens Microsoft's installation progress. The launcher does not bundle a second browser. The interface and fonts are local assets; account data passes through bounded Rust commands. Window state, launch progress and mutation recovery survive a frontend reload, and opening a second launcher focuses the existing Tauri window. See [the migration record](launcher-tauri-migration.md) and [the interface design contract](../apps/launcher/DESIGN.md).

The signing test uses the Microsoft-signed Windows PowerShell executable already trusted by the operating system. Through the actual launcher it verifies the SHA-256 digest, a valid Authenticode chain, acceptance of an exact signer EKU, and rejection of an incorrect identity. It does not create, import, or trust a test certificate. GitHub Actions repeats the same check on Windows.

## Unsigned alpha release

The `Release unsigned launcher` workflow builds the Windows executable from an immutable commit, runs the Rust tests, verifies the artifact has no Authenticode signature, exercises a real per-user install and `b2g://` registration on the disposable runner, and publishes the executable with a SHA-256 checksum to the private GitHub release archive. The verified executable and checksum are bundled into `apps/web/public/downloads` for public distribution from `https://play.back2go.net/downloads/` without exposing the source repository.

Unsigned alpha builds install normally under the current Windows account but Windows identifies them as an unknown publisher. Users may need to choose **More info** and **Run anyway** in SmartScreen. Automatic updates remain disabled: each new version must be downloaded manually from the launcher guide on the production site. The probe challenge, one-use HMAC report, strict endpoint and credential validation, public-address restriction, direct Steam invocation, owned-only inventory policy, and rollback-safe managed game installation are unchanged.

## Production signing

Production releases use Azure Artifact Signing Public Trust. Its leaf certificates renew daily and remain valid for only 72 hours, so pinning a leaf certificate thumbprint or public key is intentionally forbidden. The launcher instead embeds the profile-specific durable subscriber-identity EKU beginning with `1.3.6.1.4.1.311.97.` and requires both a valid Windows Authenticode chain and that exact EKU.

The `Release signed launcher` workflow uses GitHub OIDC and performs a two-sign process:

1. Build and sign a disposable probe.
2. Extract the one profile-specific durable identity EKU, excluding Artifact Signing’s generic Public Trust EKU.
3. Rebuild with `AFTERTICK_UPDATE_PUBLISHER_IDENTITY_EKU` embedded.
4. Sign and RFC 3161 timestamp the final executable.
5. Create the strict update manifest, verify the positive path through the launcher itself, and prove rejection of a different durable identity.

Configure a protected GitHub environment named `production-signing` with:

- secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` for the federated workload identity;
- variables `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME`, and `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME`;
- required reviewer protection if the selected GitHub plan supports it;
- the Azure `Artifact Signing Certificate Profile Signer` role scoped to the certificate profile.

Then dispatch `.github/workflows/release-launcher.yml` with a semantic version matching `apps/launcher/Cargo.toml` and the final credential-free HTTPS download URL. The workflow is permission-limited to `contents: read` and `id-token: write`; signing keys never enter GitHub secrets or the runner.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-launcher.ps1 -PublisherIdentityEku <durable-identity-oid>
powershell -ExecutionPolicy Bypass -File .\scripts\sign-launcher.ps1 -CertificateThumbprint <production-thumbprint>
powershell -ExecutionPolicy Bypass -File .\scripts\create-launcher-release.ps1 -Version 0.1.0 -DownloadUrl https://updates.back2go.net/b2g-launcher.exe -PublisherIdentityEku <durable-identity-oid>
```

The manual `sign-launcher.ps1` path remains available for a conventional certificate in the Windows certificate store. Azure Artifact Signing should use the production GitHub workflow above. Store only short-lived workload authorization in CI; never store a PFX, signing private key, Steam credential, or long-lived Azure client secret in the repository. Signed builds still verify their embedded publisher before installation and use the existing fail-closed update contract.

## Update contract

The update manifest is strict JSON containing:

- manifest version;
- semantic launcher version;
- credential-free HTTPS download URL;
- lowercase SHA-256 digest;
- expected profile-specific Artifact Signing publisher identity EKU;
- file size bounded to 128 MiB.

The launcher downloads with native OS TLS roots, verifies length and digest, validates Authenticode and its pinned durable publisher identity, then starts a helper to replace the executable. The helper re-verifies before replacement, keeps a backup, and restores it if the replacement cannot start.

## Installation

The launcher installs per user under `%LOCALAPPDATA%\\B2G\\bin` and registers `b2g://` under HKCU, so administrator rights are unnecessary. The protocol handler receives a short-lived server address/password only after the platform’s ready check.

Double-clicking a release performs the per-user installation and opens the launcher dashboard. Command-line installs remain available through `b2g-launcher install`; `b2g-launcher install-protocol` registers the current executable path without copying it.

The current machine diagnosis reports standalone App 4465480 ready at legacy build `1.38.8.1` / client version `1575`, matching the production dedicated server. Selecting App 730's `csgo_legacy` fallback remains a user-authorized Steam operation when the standalone app is unavailable.
