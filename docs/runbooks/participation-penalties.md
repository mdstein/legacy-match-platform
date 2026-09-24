# No-show and abandon penalties

Policy v1 uses signed server observations rather than browser presence. Warmup allows 300 seconds for all ten rostered Steam identities to arrive. Live disconnects allow 300 seconds to reconnect. A return before expiry clears the pending slot timer. Warmup expiry cancels without rating; live expiry forfeits the abandoning player's team and settles the result through the normal exactly-once rating ledger.

The offense number counts all recorded no-shows and abandons for that player in the preceding 30 days. The current violation type selects the duration:

| 30-day offense | No-show | Live abandon |
|---:|---:|---:|
| 1 | 15 minutes | 30 minutes |
| 2 | 60 minutes | 120 minutes |
| 3 | 6 hours | 12 hours |
| 4 | 24 hours | 48 hours |
| 5+ | 7 days | 7 days |

## Investigation

1. Locate the match in operations and confirm the canonical `roster.no_show` or `roster.abandoned` event. Record its event ID, SteamID64, team, absence start, grace duration, lease, and node.
2. Compare the event to `match_participation_violations`, the linked cooldown sanction, and the `sanction.automatic_participation` audit entry. One match/player/type must have exactly one of each even after node/API retries.
3. For a no-show, verify the match is `cancelled` with reason `no_show`, has no rating ledger entries, and the released lease completed its terminal drain. For an abandon, verify the `match.forfeited` event, canonical result reason `forfeit`, exactly ten rating entries, and released lease.
4. Treat a malformed policy version, Steam identity, team, timestamp, grace interval, or match state as rejected evidence. Do not recreate a sanction manually until the node/lease/event chain has been examined.
5. The player may use the ordinary sanction appeal flow. A moderator can uphold, reduce, or overturn the sanction with a written resolution; every action remains audited. Do not edit participation, sanction, result, or audit tables directly.
6. If several players are affected by a server or routing incident, pause queue/allocation as appropriate, preserve node and network evidence, and review sanctions consistently. Use the game-node incident procedure for an SRCDS failure; do not label infrastructure loss as a player abandon without signed roster evidence.
