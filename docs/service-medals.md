# Native service medals

This records the implemented B2G service-medal flow in the existing CS:GO Panorama UI. The owner confirmed that redemption in `0.2.25` worked. Release `0.2.26` hides the entire medal action below level 40; see the [original release and level-40 grant evidence](playtest-0.2.25.md) and [follow-up release](playtest-0.2.26.md). This confirmation does not establish every recovery, upgrade, or equipment check below.

## Redemption and progression

At profile level 40, the player opens the native service-medal preview and confirms redemption. A successful claim saves the medal and resets profile progress to **level 1, XP 0** in the same database transaction. Previewing does not change progress. Lifetime XP is retained.

The progression visits **2015 through 2023 at tier 1**, then **2015 through 2023 at tier 2**, then repeats the year order for later tiers while skipping definitions absent from the final September 2023 item schema. It ends after **51 actual medal tiers**:

| Year | Available tiers | Definition indices |
| --- | --- | --- |
| 2015 | 1–2 | 1331–1332 |
| 2016 | 1–6 | 1339–1344 |
| 2017 | 1–7 | 1357–1363 |
| 2018 | 1–6 | 1367–1372 |
| 2019 | 1–6 | 1376–1381 |
| 2020 | 1–6 | 4674–4679 |
| 2021 | 1–6 | 4737–4742 |
| 2022 | 1–6 | 4819–4824 |
| 2023 | 1–6 | 4873–4878 |

Each year has one persistent inventory asset. Later tiers update that asset's definition, name, and icon, preserving its identity and equipped state. Completing the sequence produces nine medal assets and 51 redemption receipts. Medals use the native shared equipment class **0**, loadout slot **55**.

The API serializes claims by locking the player row. Repeating a completed definition returns its saved receipt and asset without granting another item or resetting progress again. Wrong, stale, unknown, early, or exhausted claims do not advance progression. If the inventory transition fails, the receipt and profile reset roll back with it. A new year's medal requires room below the 512 active-item limit; upgrading an existing medal does not require another inventory slot.

Sources: [medal sequence](../packages/db/src/services/service-medals.ts), [persistent preview and redemption](../apps/api/src/service-medal-service.ts), and [integration coverage](../apps/api/test/service-medal.integration.test.ts).

## Native presentation and states

The visual direction is the incumbent CS:GO Panorama interface: its existing rank panel, service-medal button, item inspection layout, confirmation controls, spinner, generic popups, and schema medal artwork. The extension changes eligibility, response handling, and recovery copy within those surfaces. This record establishes no new web design tokens, typography, palette, or replacement visual identity.

| State | Implemented behavior |
| --- | --- |
| Viewing another player's profile | The service-medal button is hidden. |
| Own profile below level 40 | The entire medal action is hidden. No **“Level up to upgrade”** banner is shown. |
| Own profile at level 40 | The button is enabled and uses the stock localized **Redeem Service Medal** label. The API validates actual eligibility when the preview is requested. |
| Eligible preview | The native inspection popup shows the next schema medal. Its existing confirmation flow distinguishes a new medal from an upgrade using the owned asset ID. Opening or cancelling the preview does not redeem it. |
| Confirmation submitted | The existing spinner appears and the confirmation control is hidden. Prestige operations wait up to **45 seconds** for a callback. |
| Saved claim received | The launcher installs the authoritative inventory, and the GC publishes item and profile updates before replying with success. The native flow acknowledges the item, marks it recent, and opens its inventory preview. |
| Below-level rejection | **Service medal unavailable** explains: “Reach level 40 for your next medal.” |
| Full inventory | **Service medal unavailable** explains: “Make room in your B2G inventory.” Preview checks capacity before confirmation for a new asset; redemption rechecks it transactionally. |
| Sequence exhausted | **Service medal unavailable** explains: “All available medal tiers redeemed.” |
| Connection or unconfirmed response | **Service medal unavailable** explains: “Keep B2G open; saved claims sync automatically. Reopen the preview.” |
| Callback timeout | The popup closes and **Service medal pending** explains: “Keep B2G open. A sent claim may still complete; saved medals sync automatically.” This state does not claim that a sent redemption failed. |

Queries and claims in B2G owned-inventory mode pass through the authenticated launcher. The GC does not mint a local medal or reset authoritative progress on that path. After a service-medal request, the launcher brings forward its account refresh so a persisted claim can synchronize even if its immediate response was lost. Transport failure recovery requests a fresh preview without automatically resubmitting the claim. Saved receipts make a repeated claim idempotent.

The narrow review's timeout, full-inventory explanation, and lost-response recovery findings are resolved in the source. Rendered appearance and the complete human interaction have not received visual approval.

Sources: [Panorama button, response, accept, and timeout patches](../vendor/csgo-gc/csgo_gc/panorama_patch.cpp), [GC prestige request and result handling](../vendor/csgo-gc/csgo_gc/gc_client.cpp), and [launcher service-medal request and synchronization](../apps/launcher/src/client_session.rs).

## Validation recorded for these candidates

| Check | Result and scope |
| --- | --- |
| Database-backed medal integration suite | **6/6 passed**, including the corrected full-inventory fixture. Covers preview and invalid claims, concurrent/idempotent redemption, saved receipt recovery, authoritative inventory publication, all 51 tiers, same-asset upgrades and retained equip state, exhaustion, rollback, and drops across prestiges. |
| Native CTest suite | **8/8 passed** after the final native build, including inventory-full failure reason 2 on the response wire and equipment class 0. |
| Actual September 2023 `code.pbin` | Patch application passed against the real archive. |
| Patched Panorama scripts | Full-script syntax parsing passed with Node `vm`. This does not execute the scripts inside Panorama. |
| Rust launcher | **79 unit tests passed, 1 ignored**; the version CLI check passed. The final release build succeeded. |
| Human redemption | **Owner confirmed successful redemption in 0.2.25.** Separate captures, later upgrades, equipment persistence and recovery checks remain pending. |

Published artifact SHA-256 values:

- Launcher `0.2.25`: `466c8a572a3b3552dc84ccd5a6ae80f2617ce4062b40eeae7651098af03c6372`.
- Game node `0.1.25` ZIP: `b47e2070d9b11219fe819ac2489ea7d6085d2d6cd1094906692c73dbad0f2079`.

## First in-game playtest

Run this checklist once the intended candidate is available in the playtest environment. Keep B2G open throughout redemption and synchronization.

- [ ] On an account at level 40 with no completed service-medal prestige, open the profile's native **Redeem Service Medal** action. Capture the enabled button and the **2015 Service Medal** preview.
- [ ] Inspect the native confirmation and cancel once. Confirm that no medal appears and level/XP remain unchanged.
- [ ] Reopen the preview and confirm redemption. Capture the resulting 2015 medal and verify **level 1, XP 0**, with one medal in the inventory.
- [ ] Equip that medal from the native inventory and verify that the equipped medal is shown on the profile.
- [ ] Restart the game and launcher, allow synchronization to complete, and verify the same medal and equipped selection persist with the saved profile progress.
- [ ] On 0.2.26, confirm the medal action is absent below level 40 and reappears at level 40.

Remaining human recovery checks: capture the full-inventory explanation before confirmation, the exhausted-sequence explanation on a prepared account, and the pending/recovery flow when a response is delayed or lost. Confirm that a saved claim eventually synchronizes without a duplicate medal or a second progress reset.
