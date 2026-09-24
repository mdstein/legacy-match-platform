# Player trading release 0.2.29

Launcher/API/web **0.2.29** and game node **0.1.27** are deployed. Trading was
enabled at **2026-09-07 19:18:05 UTC** after the coordinated release passed its
deployment checks. The app release is `0.2.29-alpha.20260907.1900`.

## Try it

1. Close CS:GO and the old launcher once to install this release. Download
   [launcher 0.2.29](https://play.back2go.net/downloads/b2g-launcher-v0.2.29-windows-x86_64.exe),
   or run the repository copy:

   ```powershell
   .\apps\web\public\downloads\b2g-launcher-v0.2.29-windows-x86_64.exe ui
   ```

2. Pair the launcher if needed, open **Trading**, and copy your trade code.
   Your partner uses **New Offer** to find that exact code. Both accounts must
   be B2G players. The tab also supports player-name lookup; verify the code
   before sending when names are similar.
3. Select items under **You give** and **You receive**. Inspect wear, pattern,
   stickers, name and counter; add an optional note, then **Review Offer** and
   **Send Offer**. A one-sided offer requires explicit gift confirmation.
4. The recipient opens **Incoming**, reviews the items and identity, and chooses
   **Accept Trade**, **Counter**, or **Decline**. The sender can be offline.
   Counteroffers require a fresh review by the other player. Senders may cancel
   pending offers; items are not reserved while an offer is pending.
5. Check **History** and both inventories. A transferred StatTrak item starts
   at **0** for its new owner; the receipt preserves its prior count. Ordinary
   trades use automatic inventory synchronization without restarting the client.

If a network failure leaves the outcome uncertain, use **Recover Request**.
The launcher retries the exact saved request and revision, so a committed trade
cannot execute twice. Reopening the launcher retains that recovery path.

## Item rules

B2G skins and unopened cases, pin/souvenir packages and sealed graffiti are
tradable. Containers move with their opening entitlement. Paint, wear, seed,
stickers, names and original item identity survive transfer. Service medals,
free name tags, unsealed graffiti and imported Steam items stay with their
account. Hidden keys travel with their case rather than appearing as an
independent trade selection. Maximum 50 items per side and 512 visible items
per resulting inventory. Offers expire after seven days.

## Verification

- 23 real PostgreSQL trading integration tests: authenticated two-device HTTP
  journey, atomic exchanges, gifts, counteroffers, cancellation, expiry,
  idempotency, rollback, participant isolation, exact terms, capacity, inbox
  pagination, opening/crafting races and recipient use of each container type.
- Full database integration run: 86 passing tests across 13 suites, including
  inventory, StatTrak, medals, settlement, node control, recovery and retention.
- JavaScript unit checks: 210 passing after updating the expected release-news
  title; environment-dependent integrations ran separately as noted above.
- Launcher: 105 library tests and the version CLI test pass. Two child entry
  points are intentionally invoked by their watchdog tests. Native controls
  exercise discovery, selection, review, send, counter, gift, lost acceptance
  response, recovery, history access, keyboard traversal and returning to Play.
- All eight x86 GC CTests pass. The actual final-client Panorama archive patch
  and 390 Unlock/Escape cleanup regression pass; normal reveal remains intact.
- Saved equipment and queued loadout/acknowledgement snapshots carry captured
  ownership epochs. Old epochs cannot restore equipment, acknowledge new items
  or apply counters after an item trades away and returns. Node retry/restart
  tests preserve a kill's original captured epoch.
- Native visual evidence covers 50 captures. The Impeccable reviewer scored
  all three material fixes resolved, **ship** at fix-list scope: StatTrak
  disclosure before commitment, full Item Details label, contextual guidance.
  The size/DPI matrix is memory GDI; three captures use actual offscreen HWNDs
  on the 125% host. This does not establish all-monitor or screen-reader coverage.
- Artwork has 1,445 catalog mappings, 1,440 source-provenanced PNGs and bounded
  loading: two workers, 16 queued images, 96 cached images. Hosted art adds no
  embedded browser or store runtime to the launcher.

The new graffiti transfer test exposed an existing SQL alias error in unsealing;
the release corrects it. User accounts were not used as fixtures. No real trade,
synthetic reward grant or reset of the owner's existing counters was performed.

## Release evidence

| Artifact | SHA-256 |
|---|---|
| Launcher, 10,498,048 bytes | `e2273d4bf7c91197376a0bcc277e6dee92dc21f4ca5d165bd7e7b98addb50e83` |
| Shared x86 GC, 1,873,920 bytes | `9fab2c34aa26f39dcd56e9418842b98feab0b3e0bbf320efc6e151315c0c19e4` |
| Game node 0.1.27 ZIP, 28 verified files | `5ca030b9cba2c0065a5ca93d2e7b320bcc6a49603d65aabfe7e1a492e2757923` |
| Match plugin (reports 0.1.7; release identified by hash) | `f56cb8bfefdad651a3bb799dc1cc83e63680ede8933bc58a76fe242a9feb205a` |
| API/web image archive | `4a396b00a360aea785d665cc7f94798db64099fcf1bbf839f6689d5cbf5e40bd` |
| App-host release ZIP | `39b723802aac8a960c7366548ccb2b17528b73790b890a39661dfd5c5a1a1568` |

Public verification fetched the executable and checksum, ran its version CLI,
checked the website's 0.2.29 download binding, fetched three representative art
files by content hash, confirmed unauthenticated Trading requests return 401,
and verified PostgreSQL/Redis/object-storage readiness. The public web bundle is
`/assets/index-5J2v0Z1M.js`.

Migration 032 applied once after the verified database backup
`/var/backups/aftertick/pre-0.2.29-alpha.20260907.1900.dump` (SHA-256
`f3cc3c9e126dd34dc14424df111c05cd099f81ce41b82ae08a33dce59bd100aa`).
The Windows rollback backup is
`C:\ProgramData\Aftertick\backups\before-node-0.1.27-20260907T190831Z`.
No loaded client files were replaced. Allocations reopened at 19:15:03 UTC after
fresh node 0.1.27 heartbeat, ready instance, reachable RCON and zero human
players. Trading diagnostics showed zero inconsistent container owners, invalid
B2G loadouts, expiry backlog or transferred assets when enabled.

## Human acceptance checks

The remaining checks need real gameplay observation: trade with another account
while both clients are open, verify removal/addition and equipment in game,
open a received container, make a new StatTrak kill and reconnect. Also inspect
the full receipt window and your actual monitor/DPI setup. Automated fixtures
establish the implementation paths; they do not substitute for that observation.
Recruiting players or organizing a 5v5 is not needed to use the implemented tab.

For rollback, diagnostics and disable/recovery procedures, see
[player-trading-operations.md](player-trading-operations.md). After transfers
begin, disable trading and use a compatible fix; do not roll back to an API or
node that lacks ownership-generation support.
