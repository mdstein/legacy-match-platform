# FACEIT public-repository review

Reviewed 2026-08-29 from the [FACEIT GitHub organization](https://github.com/faceit). The organization currently exposes 78 repositories: 73 forks and five original repositories. The originals are coding challenges or internal-development utilities; none contains FACEIT's matchmaking, queue, match-room, rating, game-server control, anti-cheat, or production platform implementation.

## Useful ideas, but no dependency to add now

| Repository | Finding | B2G decision |
|---|---|---|
| [`faceit/demoinfocs-golang`](https://github.com/faceit/demoinfocs-golang) | MIT-licensed fork of `markus-wa/demoinfocs-golang`; it has no unique commits and is 891 commits behind its parent. | Keep B2G's existing pinned upstream `github.com/markus-wa/demoinfocs-golang/v3` dependency. We already use the maintained parser for legacy CS:GO demos. |
| [`faceit/gelectron`](https://github.com/faceit/gelectron) | MIT fork of `hiitiger/goverlay`, last pushed by FACEIT in 2021. It injects an Electron web overlay into games. | Do not adopt. The private-alpha launcher does not need an overlay, and injection adds a large compatibility, security, and future anti-cheat surface. Re-evaluate only for an explicitly designed overlay milestone. |
| [`faceit/rollout-operator`](https://github.com/faceit/rollout-operator) | Apache-2.0 Kubernetes rollout controller. | Do not add during the VPS/Docker alpha. Its operating model becomes relevant only if the platform later moves to Kubernetes. |
| [`faceit/pyrra`](https://github.com/faceit/pyrra) | Fork of the Apache-2.0 Pyrra SLO project. | The SLO concept is useful, but use the maintained upstream project later rather than FACEIT's fork. Current Prometheus rules and Grafana dashboards are sufficient for alpha. |
| [`faceit/ratelimit`](https://github.com/faceit/ratelimit) | Fork of Envoy's Apache-2.0 rate-limit service. | Keep the current Redis-backed application rate limiter. A standalone Envoy service is unnecessary at one API deployment and can be reconsidered with a service-mesh or multi-service architecture. |
| [`faceit/secrets-manager`](https://github.com/faceit/secrets-manager) and infrastructure forks | Mostly Kubernetes, Vault, GitOps, CI, or observability forks. | Use their architecture as reference only. Select maintained upstream tools that fit the chosen host rather than depending on FACEIT mirrors. |

The practical reusable piece is already present in B2G: the maintained upstream lineage of the demo parser. Pulling code merely because FACEIT has a fork would add stale dependencies without revealing or recreating FACEIT's proprietary platform. Any future adoption still requires an individual license, maintenance, security, and architecture review.

## Competitive-platform capability audit

FACEIT's current official product material groups its CS offering into skill-based matchmaking, Elo/levels, parties and Party Finder, match history and Track statistics, anti-cheat/verification, Clubs/custom queues, tournaments/cups, team finding, scrims, ESEA leagues, highlights, spectating, missions, and rewards. B2G's 50-player private alpha deliberately implements the smallest trustworthy competition loop rather than imitating all of those surfaces.

| Capability | B2G alpha decision |
|---|---|
| Skill queue, party integrity, Elo/ranks, latency routing, ready check, captain veto, match room, reconnect/abandon policy | Implemented end to end. |
| Competitive and random-map free-for-all Deathmatch | Implemented; DM is 14 players, ten minutes, first to 40, and unrated. |
| Profiles, leaderboard, history, detailed stats, demos | Implemented at alpha depth; richer per-map/weapon/clutch trend analysis is a later analytics milestone. |
| Anti-cheat and moderation | Implemented as non-invasive server-side SMAC signals, signed event/GOTV evidence, reports, manual sanctions, appeals, and immutable audits. No client/kernel scanner or identity verification. |
| Friends/blocks, recent teammates, Party Finder/chat | Useful next social layer, but not required to run a controlled 50-person invite playtest; retain as public-beta work. |
| Clubs/custom queues, tournaments/brackets, team finder, scrims, leagues | Organizer products with substantially different scheduling, permissions, and dispute models; defer until the core queue has retention and integrity evidence. |
| Highlights, live spectator product, missions, points, prizes, shop | Engagement/reward systems, not match-integrity requirements; intentionally deferred. GOTV evidence downloads exist now. |

This audit uses FACEIT's official [beginner guide](https://support.faceit.com/hc/en-us/articles/14996562458268-FACEIT-Beginners-Guide), [navigation guide](https://support.faceit.com/hc/en-us/articles/14996885023516-Navigating-FACEIT), and [CS product page](https://www.faceit.com/cs/game/cs2) as feature references. It does not treat FACEIT's kernel anti-cheat or identity-verification model as appropriate for B2G's stated non-invasive requirement.
