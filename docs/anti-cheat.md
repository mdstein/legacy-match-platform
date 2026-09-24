# Private-alpha anti-cheat policy

Updated 2026-08-30. B2G uses server-side observation and signed match evidence. Players install no anti-cheat driver or background scanner. B2G does not inspect processes, memory, files, screenshots, hardware identifiers, or unrelated network activity.

## Selected stack

- [SMAC 0.8.8.0](https://github.com/Rushaway/sm-plugin-SMAC) is pinned to commit `ea15f3ec0c8d9c499d0e42d7174675dd6d30780b`. This fork includes the February 2025 CS:GO ConVar false-ban hotfix and builds against the pinned SourceMod compiler.
- B2G loads only the core, aimbot, auto-trigger/bunnyhop, eye-test/user-command, speedhack, and spinhack modules.
- Automatic aimbot, auto-trigger, and eye-test bans are explicitly `0`. Modules that kick for command spam, client state, or ConVar replies are not shipped.
- The unsupported SMAC wallhack module refuses to load on CS:GO. B2G instead enables the engine-native `sv_occlude_players 1` behavior.
- Every SMAC forward for an active roster player becomes an `anticheat.signal` event in the existing append-only match stream. The node agent signs it, the API validates it against the active lease, and PostgreSQL stores it with the match timeline.
- Moderators can review signals in Operations and download the corresponding GOTV demo. A signal is a lead, never a verdict. Sanctions remain manual, reasoned, auditable, and appealable.

The game-node release includes the exact compiled modules, English translation, provenance manifest, GPL licenses, and complete pinned SMAC/MultiColors source archives.

## Evaluated alternatives

| Project | Finding | Decision |
|---|---|---|
| [Little Anti-Cheat](https://github.com/srcdslab/sm-plugin-lilac) | Active GPL SourceMod fork with several useful heuristics, but its current runtime game dispatch recognizes `cstrike` (CS:S), not the legacy CS:GO `csgo` folder, and warns that unknown games may produce false positives. | Do not deploy on this server stack. |
| [Cow Anti-Cheat](https://github.com/eedson/Cow-Anti-Cheat) | GPL CS:GO plugin covering aim, trigger, bhop, strafe, and instant-defuse behavior. Its latest tagged changelog is from 2018 and it requires SteamWorks. | Useful prior art; too stale for the primary alpha detector. |
| [OSAntiCheat](https://github.com/Pintuzoft/OSAntiCheat) | Promising MIT, server-side statistical detector with log-only behavior and calibrated demo research. It is explicitly early-stage and targets CS2/CounterStrikeSharp rather than legacy CS:GO/SourceMod. | Track for a future CS2 product, incompatible here. |
| Client or kernel anti-cheat | Can observe far more of the endpoint, but requires invasive access, a signing/update pipeline, extensive compatibility work, and a materially larger trust burden. | Intentionally excluded from this private alpha. |

## Operating rules

1. Keep automatic SMAC bans and kicks disabled.
2. Require repeated/corroborated server signals plus GOTV review before a cheating sanction.
3. Record the reviewed rounds, detector limitations, and rationale in the moderation finding.
4. Preserve the signal, signed event stream, demo checksum, sanction, and appeal audit trail under evidence hold.
5. Recalibrate or disable a detector after game/server updates until clean-player samples show acceptable behavior.
6. Never describe server-side heuristics as equivalent to a client anti-cheat or proof that cheating is impossible.

## Controlled pipeline test

The match plugin includes a root-only synthetic signal command. It is disabled by default and cannot kick, ban, or change a match result. Run it only in a disposable controlled match with a consenting test account:

```text
aftertick_anticheat_self_test_enabled 1
sm_aftertick_test_anticheat <connected SteamID64>
aftertick_anticheat_self_test_enabled 0
```

The command accepts only a connected human on the signed active roster. The API rejects malformed, wrong-mode, or off-roster anti-cheat events. Operations labels the resulting event `SYNTHETIC` and tells moderators never to cite it in a player finding. Confirm that the event appears, that the GOTV link resolves, and that no player kick, ban, or sanction was created. Then disable the ConVar immediately and record the test match ID in the operator log.

Build with `npm run game:anticheat:build`. A full game-node release automatically rebuilds and packages the pinned modules and corresponding source.
