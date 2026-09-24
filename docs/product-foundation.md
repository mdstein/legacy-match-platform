# Product foundation

## Purpose

back2csgo (B2G) gives players who still prefer CS:GO a credible place to play structured Competitive and Deathmatch sessions. The first screen has one primary job: let a player understand the quality and rules of the selected mode and enter the queue with confidence.

The intended feeling is a competition match sheet: direct, editorial, and specific to organized Counter-Strike. It should not resemble a SaaS dashboard, a gaming landing page, a casino, or a copy of FACEIT. Evidence stays visible: rating, rank threshold, selected maps, route, trust state, expected wait, and recent rating movement.

## Initial personas

### Mara — returning competitive solo player

“Show me that the match will be fair, then get me into it quickly.”

Needs visible Elo, familiar CS:GO rank language, predictable map/region selection, low-friction queueing, and a clear match-found alert.

### Ilya — party leader

“I need to know everyone is ready and that our party will not be fed into an unfair stack matchup.”

Needs party state, route compatibility, ready status, party-size matchmaking rules, and useful abandon feedback.

### Ren — trust and match operations moderator

“Every sanction and disputed result needs evidence I can reconstruct.”

Needs append-only match events, demo references, rating explanations, report history, server health, and an auditable moderation trail. The current role-gated operations surface includes report review, sanctions, appeals, platform controls, roles, and immutable audit history.

## Primary use cases in this slice

1. A player checks current numeric Elo and the corresponding CS:GO rank.
2. The player chooses Competitive or Deathmatch. Competitive uses region and map choices; Deathmatch uses the selected region and a server-random map from the full pool.
3. The player enters the queue and sees mode-specific roster size, rules, elapsed time, and the widening rating window where applicable.
4. The platform publishes a match-found event and opens an accessible ready check.
5. All ten accept; the two team captains alternate map bans in a timed, reload-safe match room.
6. Once one map remains, every player receives the same one-match server credential through the native launcher, with a Steam fallback link.
7. The player reviews recent `+/- Elo` results and opens profiles, match details, the full rank ladder, demo downloads, or rating explanations.
8. The player files a roster-backed report or appeals an active sanction; authorized staff review it through the operations surface.
9. Fourteen Deathmatch players receive a random map, play a ten-minute free-for-all to 40 kills, and receive an unrated standings result without changing Competitive Elo.
10. A moderator reviews server-side anti-cheat signals against the signed event timeline and GOTV; the platform takes no automatic punitive action.

## Information wireframe

```text
┌────────────────────────────── matchroom masthead ───────────────────────────────┐
│ back2csgo       play / matches / ladder / settings    connection + identity    │
├──────────────────────────────── edition / rules line ───────────────────────────┤
│ ranked 5v5 + queue state                    │ continuous player dossier          │
│ wait / Elo window / party rule / tickrate   │ CS:GO rank + visible Elo           │
│ region                                       │ progress + rating explanation      │
│ map ledger                                   │ full rank ladder                   │
│ search order                    primary CTA  │ party roster                       │
├──────────────────────────────────────────────┤ trust / eligibility                │
│ recent match rating ledger                   │                                     │
└──────────────────────────────────────────────┴─────────────────────────────────────┘
```

On narrow screens the player dossier follows the queue and match ledger. Navigation remains horizontal, controls reflow, match rows gain inline labels, and no capability is removed.

## Visual system

- Direction: **competition bulletin / tactical match sheet**.
- Typeface: Barlow for interface copy and Barlow Condensed for display/data emphasis. Both are bundled locally.
- Proportion: a practical 3:4 scale informs type, gaps, and the asymmetric main-to-dossier relationship.
- Palette: warm score-sheet white and green-black ink dominate. Muted CT blue drives actions and selection; restrained T-side sand marks secondary emphasis. Green is reserved for healthy live state, while red is reserved for actual failure and cancellation.
- Shape language: flat surfaces, square controls, one continuous dark dossier, and typographic data. No ornamental rank badge, gradients, glows, floating cards, or decorative telemetry.
- Motion: 100–220 ms input/state feedback and one restrained live signal. Reduced-motion preferences disable it.
- Hierarchy: white space and position first, then weight and size, then minimal color. Rules divide major editorial sections; alignment and proximity handle local grouping.
