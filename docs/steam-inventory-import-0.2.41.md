# Steam import correction and launcher Inventory — 0.2.41

The September 8 missing Karambit report exposed two independent import defects.
The importer recognized firearms only, while its generated compatibility catalog
discarded repeated Valve schema sections and did not resolve inherited knife
loadout positions. This excluded supported finishes as well as all Steam knives.
Neither defect was caused by the player's knife being too new for CS:GO 2023.

The importer now reuses the existing B2G knife identities and accepts Steam's
starred knife names, including StatTrak prefixes. Exact inspect-certificate asset
and definition checks remain enforced. Unsupported CS2 content is still excluded.
The schema generator merges repeated object sections and resolves prefab loadout
positions, rejecting ambiguous or cyclic inheritance rather than guessing slots.
The same source SHA-256, unchanged on disk, now produces the complete catalog:
`510e09b68a01d88edba2342972960025fd6484aaaa58365fcf47d8513de79623`.

## Launcher behavior

Open **Inventory** beside Play to browse compatible Steam skins and earned B2G
items. Search or filter by source, then select a card to inspect its exact wear,
pattern, paint kit and available StatTrak/name-tag attributes. Equipping remains
in the game; B2G item exchanges remain in Trading.

**Refresh Steam inventory** explicitly requests a new import. The page shows the
last import and the existing five-minute cooldown, retains cards while updating,
explains private/unavailable Steam states, and provides Retry for failed reads.
Signing out removes account data and rejects delayed responses from the old account.
Successful imports advance the existing inventory revision so the running
launcher's synchronization worker can pick up newly imported items.

The new authenticated account inventory GET and refresh POST routes use the
Rust-held launcher bearer token. The server derives the player from that token,
rejects unexpected refresh-body fields and returns private/no-store responses.
No credentials enter the frontend. This release adds no database migration.

## Verification

- Actual public Steam response: 10 compatible imported items before correction,
  35 afterward, including Karambit definition 507, paint kit 572 (Gamma Doppler
  Phase 4), wear 0.02451576478779316 and pattern 205. The full public payload
  remains in ignored local diagnostics; committed fixtures use synthetic IDs.
- At 23:54 UTC, a scoped production refresh through the normal InventoryService
  confirmed the same 10→35 change in the affected player's saved snapshot and
  the exact knife attributes. No manual item grant or cooldown bypass was used.
- 11 importer unit tests, 23 API tests and two schema generator tests pass.
  Coverage includes starred StatTrak/vanilla knives, localized names with numeric
  definitions, exact-asset binding and rejection of unsupported/mismatched data.
- 14 isolated PostgreSQL inventory tests pass, including exact knife import,
  native bundle creation, equipping and inventory revision advancement.
- 27 launcher browser tests pass, including retained cards/filters, cooldown
  expiry, failed initial read/Retry, privacy, sign-out isolation, detail focus
  restoration and layout at 1360×820 and 960×640.
- 131 Rust library and four CLI/integration tests pass; five child watchdog
  entries are ignored separately and exercised by parent tests. API/frontend
  builds and the Windows release build pass.
- The UI reviewer scored the two listed final corrections resolved. Browser
  fixtures and source checks do not establish physical WebView2 acceptance or
  the affected player's in-game rendering. That last visual check remains open.

## Delivery

Deployed API/web release `0.2.41-alpha.20260908.2346` with a verified database
backup, unchanged migration checksums and automatic deployment rollback checks.
Public readiness, website version, protected routes and executable bytes were
verified at 2026-09-08 23:53 UTC. No GitHub Actions run was used.

Launcher download: `/downloads/b2g-launcher-v0.2.41-windows-x86_64.exe`.
SHA-256: `5dbd6542475e252918fae1f15f36dd94d7be99d5f7ae73ef51c0d16d74884f87`.
The owner's per-user launcher was updated to those exact bytes; the running game,
game files, settings and demos were not changed by launcher installation.

API image: `sha256:dd0cded9cf478a14bb6cb432b4066268938aa72d1ea51e1969bd980c1cf4021d`.
Web image: `sha256:2fa9050452a1d2307b904fa96788a704aa79fee23785efa19b154ba0010ce033`.
Previous compatible release: `0.2.40-alpha.20260908.2240`.
