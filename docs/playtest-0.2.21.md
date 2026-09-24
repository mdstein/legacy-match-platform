# Native launcher redesign candidate: 0.2.21

This is a local test candidate, not a public-site deployment. The currently
installed launcher and game files were not modified during development.

Executable: `apps/web/public/downloads/b2g-launcher-v0.2.21-windows-x86_64.exe`,
9,804,800 bytes. `--version` reports `B2G Launcher 0.2.21` without opening a GUI.
Unsigned, consistent with the existing manual-distribution policy.
SHA-256: `98b4ad4f9a1c2110b95614548dc193f2d31e34cc3e98a5fac80854509b52ab01`.
Embedded GC pin: `bcd9ae594d564c08d1e8de3b48e1d357412c1e4d36f2cf98d88b7e2b0a2637aa`.

## What changed

The native Windows dashboard now follows the user's supplied
`reference-launcher-design.zip`: dark compact header, left profile rail,
image-led news, right changelog, and persistent blue GO bar. Rajdhani fonts,
the supplied artwork and existing authentic rank emblems are bundled locally.

Profile, rank, wins, XP, news and population come from
the existing authenticated bootstrap. Actual worker events control connecting,
starting and running states. The prototype's invented population, ping,
patch notes, avatar and timer-based launch progress are not production data.
Account initials are used until a real avatar pipeline is added. Demo-only
Store/Stats/Inventory tabs are omitted; inventory remains inside CS:GO.

GO, Refresh, Account and View Details are real native buttons with keyboard
navigation and focus/pressed states. View Details exposes full profile/news
and diagnostic text when a compact summary is truncated. The window supports
resizing, maximization and per-monitor DPI. Rendering uses a shared,
double-buffered GDI painter without an embedded browser or runtime image fetches.

This UI-only follow-up preserves 0.2.20's GC bundle and inventory synchronization
fixes. No API, queue, case odds, inventory rules or server plugin source changed.
Existing server candidate 0.1.20 is still required for the earlier live StatTrak
and chat changes; the launcher redesign itself needs no new game-node release.

## Test without replacing your installed launcher

After closing the old launcher yourself, you can preview just the new dashboard
without installing it or changing the protocol handler:

```powershell
& 'C:\Users\<user>\Desktop\goagain\apps\web\public\downloads\b2g-launcher-v0.2.21-windows-x86_64.exe' ui
```

This reads your saved account authorization and refreshes your profile. Account
opens the existing account page. Connect Account uses the existing pairing flow.
Pressing GO starts the real game session and applies the embedded GC normally;
close any existing game first. Double-clicking the executable without `ui` uses
the existing per-user installation behavior and updates the installed launcher.

The older versioned executables remain unchanged for rollback. No auto-update
manifest or advertised public download is changed by this local candidate.

## Reproduce verification

Verification completed: 74 Rust library tests and the actual version CLI test
passed. Twelve memory-render scenarios were generated. An independent finish
reviewer scored all three corrections resolved (multiline headings, redundant
eyebrow removal, enabled hover states), disposition **ship**, limited to those
fixes through off-screen rendering and static source inspection. No desktop
interaction or in-game end-to-end pass is claimed.

```powershell
node scripts/build-launcher-art.mjs
$env:B2G_RENDER_TEST_DIR='C:\Users\<user>\Desktop\goagain\.artifacts\launcher-ui-0.2.21'
cargo test --locked --offline --manifest-path apps/launcher/Cargo.toml
node scripts/render-launcher-previews.mjs
cargo build --release --locked --offline --manifest-path apps/launcher/Cargo.toml
```

The render tests use memory-only DIBs and the production painter. They do not
create a window, capture the desktop, read credentials, contact an API or start
the game. Their profile/count/time values are explicitly synthetic fixtures.
Scenarios cover ready, signed out, starting, running, pairing, error, stale and
long-content states, plus compact and 150% DPI sizes. Native OS interaction,
screen-reader behavior and actual in-game operation still need a human playtest;
off-screen renders are not evidence that those interactions were exercised.

For your playtest: check account/rank/XP/time, Tab and Space on each button,
resize/DPI behavior, full error details, GO, and the existing in-game inventory
and queue flow. Production and installed-client hashes are unchanged by this task.
