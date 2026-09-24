# Legacy CS:GO item colors in drop chat

Corrected in match plugin 0.1.7 / game node 0.1.26. The owner correctly identified
that the old purple was too light. Byte `0x03` is a player-name/team color and
resolves to `#ba81f0` for a neutral author. Item rarity 4 uses `#8847ff`.

## Evidence from the actual supported client

The installed final legacy `csgo/bin/client.dll` has SHA-256
`183d42fac8a4ecc24dc02edf5f09122f37fe9e7533ca093a867718b25cfdeb03`.
Read-only PE/Capstone inspection found the chat palette function at preferred VA
`0x10550580`. Its dispatch table at `0x10550644` routes bytes `0x0A` through
`0x10` to `0x105505E1`, which subtracts 9 from the code and calls the item-schema
color lookup. Byte `0x03` instead selects CT/T/neutral name colors, including
the literal `#ba81f0`. The caller formats the resolved color into a Panorama
`<font color="%s">%s</font>` span. No client binary was modified for this check.
The inspection output is retained in `.artifacts/diagnostics/legacy-chat-palette.txt`.

The final September 2023 `items_game.txt` and the actual `code.pbin`'s
`panorama/styles/csgostyles.css` agree on these rarity colors:

| Rarity | Chat byte | Color |
| --- | --- | --- |
| Consumer / common | `0x0A` | `#b0c3d9` |
| Industrial / uncommon | `0x0B` | `#5e98d9` |
| Mil-Spec / rare | `0x0C` | `#4b69ff` |
| Restricted / mythical | `0x0D` | `#8847ff` |
| Classified / legendary | `0x0E` | `#d32ce6` |
| Covert / ancient | `0x0F` | `#eb4b4b` |
| Rare special / immortal | `0x10` | `#e4ae39` |

This also corrects generic white `0x01` and penalty red `0x07` previously used
for rarities 1 and 6. The player name remains neutral, item-only coloring and
StatTrak/Souvenir qualifiers are preserved, and chat stays reliable SayText2.

The [older Multi-Colors aliases](https://github.com/Bara/Multi-Colors/blob/master/addons/sourcemod/scripting/include/multicolors/colors.inc)
call `0x0D` gray and `0x03` purple. Those aliases were the source of our mistake;
they do not describe this final Panorama client's item-rarity dispatch.
SourceMod's [CS:GO quirks](https://wiki.alliedmods.net/CSGO_Quirks) also explains
the leading space/default-color prefix already present in our messages.

Source-contract tests and actual SourcePawn compilation verify the transmitted
codes. A fresh in-game capture of an opened purple item remains the visual
acceptance check; disassembly does not substitute for that screenshot.
