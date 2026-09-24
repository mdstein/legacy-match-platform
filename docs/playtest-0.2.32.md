# Final first-run release 0.2.32

This patch completes the [0.2.31 template, motion and onboarding release](playtest-0.2.31.md).
Use https://play.back2go.net/downloads/b2g-launcher-v0.2.32-windows-x86_64.exe
for the installation test. Game node remains 0.1.28; the GC and database schema
are unchanged.

## Post-reset correction

The requested local uninstall exposed an existing discovery error: App 730's
public CS2 installation was described as an incomplete CS:GO legacy branch.
Its download counters also appeared in the new first-run progress display.
Discovery now directs that state to B2G's Install action, and setup only reads
download counters for standalone CS:GO or an actual csgo_legacy branch.

A real temporary Steam manifest/files regression passes, along with the three
setup/native interaction tests. Four corrected desktop/native captures were
reviewed; the F4 follow-up was scored resolved. Design documentation was updated
after that correction. The local release executable's doctor command confirms
the correct Install instruction against the actual reset machine. Earlier
0.2.31 regression, motion, browser, accessibility and build evidence remains
applicable to the unchanged functionality.

## Local installation test is prepared

At 22:23:43 UTC the authorized reset removed standalone CS:GO's executable and
Steam installation manifest, the installed B2G launcher bin, Start menu shortcut
and protocol registration. The local device authorization was also removed.
Steam itself, CS2 and other games remain installed. No online profile,
inventory, XP, medal, trade or match history was deleted.

205 files totaling 1,574,796 bytes were backed up and restored at their original
relative paths; SHA-256 verification of every restored file passed at 22:29 UTC.
The preserved set includes game settings and any demos found under the game
directory. Steam userdata and other B2G settings/demo directories remain in
place. Local backup and receipts:
`.artifacts/clean-install-backup/20260907T222330Z/`.
Those personal files are excluded from Git.

1. Double-click the 0.2.32 download; this installs the launcher and its shortcut.
2. Choose Install and confirm the CS:GO download in Steam. Keep B2G open while
   Steam downloads/verifies; B2G prepares its game files automatically.
3. Choose Continue with Steam and approve the matching code in the browser.
   Existing cubsfan49 goes straight back to its account. With a new account,
   finish the name and region fields in the launcher.
4. Press Play once ready; check the hover/loading effects on the physical
   display and verify the preserved settings when the game starts.

The full Steam download and alternate-account first approval are deliberately
left for this owner test. Automated fixture coverage is not a claim that those
physical journeys have already been completed.

## Release evidence

| Artifact | SHA-256 |
|---|---|
| Launcher, 11,388,928 bytes | `3914cc51021744c6abfa77ad77e45f7e3ce2599a72f5221a9bc4e65acb89fbcd` |
| API/web archive | `e86c46318ec396b99980f84033522f58c1f06ebe422b329c4de269bcc2bf4457` |
| App-host ZIP | `908b18734d581db734bc37eee54dda532457989c6e619b30bbad5606587f0648` |

Published and externally verified at 22:37:48 UTC: downloaded executable bytes,
checksum, reported version, website release binding, protected-route 401s and
PostgreSQL/Redis/object-storage readiness all pass.

Release: `/opt/aftertick/releases/0.2.32-alpha.20260907.2235`.
API image: `aftertick-api:b2g-20260907-2235`, ID
`sha256:19410a6bac30fd3acb5927cdfe78b4cb9abc4147fe186a052eb9bdba7d0652a9`.
Web image: `aftertick-web:b2g-20260907-2235`, ID
`sha256:d9481793745467d9ae914704e9a2400602bf2ec293b397e671d40a1bbf16df5b`.
Website bundle: `/assets/index-sNcjwt5q.js`.

Verified DB backup:
`/var/backups/aftertick/pre-0.2.32-alpha.20260907.2235.dump`, SHA-256
`d57379c60d8e25086f0b81bbd656d6a6897bb477dd83a2ba2cbbcd077146bfd4`.
The rollout validates unchanged topology/migrations and replaces only API/web.
Rollback uses the compatible 0.2.31 images, release pointer and saved environment;
it does not restore the database over newer inventory activity.
