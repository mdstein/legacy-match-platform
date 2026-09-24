# B2G trading operations

Candidate launcher/API/web 0.2.29 and game node 0.1.27. Migration 032 defaults
trading to disabled. Enable only after the matching API, node/plugin/GC and
launcher are available. The received item's StatTrak resets once to zero;
the immutable acceptance receipt retains its original count and ownership epoch.

## Controls

Use the intended database explicitly with `DATABASE_URL`. Source checkout:

```powershell
npm run trading:control -- status
npm run trading:control -- disable --reason "Investigating a reported transfer"
npm run trading:control -- enable --reason "Coordinated release verified"
npm run trading:control -- expire
```

In the deployed API container, use its existing database environment:

```sh
docker exec aftertick-api-1 node apps/api/dist/trading-control.js status
docker exec aftertick-api-1 node apps/api/dist/trading-control.js disable --reason "Investigating a reported transfer"
```

The control takes the same platform row lock as transfers. Disable waits for
already-running mutations to finish, then stops new sends, counters and accepts.
Cancellation, decline, history and idempotent recovery remain available. Changes
are recorded in the append-only audit log. The status output reports expiry
backlog, transferred assets, invalid B2G loadouts, inconsistent container owners
and table sizes; it does not print credentials or inventory contents.

## Offer lifecycle and storage

Pending items are not reserved. Players can equip, rename, open or craft them;
acceptance validates current ownership and exact cosmetic terms under sorted
player locks. Changed or consumed items invalidate acceptance. Live StatTrak,
equipment and acknowledgement changes do not invalidate an otherwise exact offer.
Counteroffers create a new revision and revoke earlier consent. One-way gifts
require explicit confirmation from both participants.

Pending offers expire after seven days, with at most 50 active offers per
participant, 50 items per side and 100 revisions. The API expires up to 100
offers every 30 seconds and on relevant reads; `expire` runs one bounded batch.
Folder pages contain 25 compact summaries. Inventories and history use bounded
keyset pages; exact item snapshots load only for the opened offer.

Retain completed receipts, original grant facts, ownership epochs and request
IDs. These support durable history and prevent retried requests from creating
new transfers. Do not run generic age-based deletion against trading tables or
their referenced assets. Active retention is bounded by expiry; historical
storage grows with actual activity and is measured by `status`. Archive planning
must preserve receipt access and idempotency tombstones before any deletion.

## Recovery

For a timeout after Send/Accept, use the launcher's **Recover Request**. Its
account/origin-bound local journal keeps the exact request UUID and reviewed
revision, without saving bearer credentials. Retrying or restarting cannot
settle it twice. Do not edit that journal to resend different terms.

Inspect the offer's history and the `trade.accepted` audit event before any
operator intervention. Do not manually change owner IDs or increment counters.
Transactions transfer all items, companion keys, current grant owners and
equipment cleanup together. API inventory revisions refresh both running
clients; the node updates signed ownership policies. Offline clients reload the
current inventory when reconnecting. Captured generations fence delayed kills,
counters, saved equipment and queued loadout/acknowledgement snapshots.

If a received case cannot open, disable trading and inspect its current grant
owner and compatible active hidden key. Preserve its historical grant recipient.
Missing entitlements must invalidate an offer without moving either side.

## Deployment and rollback

Take a verified PostgreSQL backup and configuration/image references. Hold new
allocations transactionally and prove no human match or active lease will be
interrupted before updating the node. Stage a new immutable launcher download;
never replace a loaded client DLL. Keep trading disabled through migration and
coordinated API/node deployment. Verify fresh node heartbeat, exact versions,
GC/plugin hashes, public launcher hash, image URLs and API readiness before
enabling. Existing users must launch the new client to use Trading.

After the first transfer, an old API/node/client is not a safe rollback target:
it lacks current grant ownership and generation checks. Disable trading first
and deploy a compatible fix. A database restore requires the whole economy to
be quiescent and a deliberate decision about all activity since the backup;
never automatically restore an old database over accepted trades. The untouched
previous release may be used only while trading has remained disabled and no
ownership generations have changed, with schema compatibility checked.

Automated evidence and human test instructions are recorded in the release
notes. Offscreen native fixtures and simulated DPI do not establish screen-reader
support, actual monitor behavior or live gameplay acceptance.
