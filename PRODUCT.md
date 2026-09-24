# B2G Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary (inferred from the product brief):** active and returning CS:GO players who want dependable community-run matches after the official ecosystem shifted its attention to CS2.
- Competitive solo players need visible rating, familiar CS:GO ranks, fair team assembly, predictable regions and maps, and fast queue entry.
- Party leaders need readiness, route compatibility, party-aware matchmaking, and clear abandon handling.
- Trust and match-operations staff need evidence-backed reports, sanctions, appeals, demos, server health, and an auditable event trail.

## Product Purpose

B2G provides structured legacy CS:GO Competitive and Deathmatch play. A player should be able to understand a mode's rules and trust conditions, enter its queue confidently, play on a managed server, and review the result and supporting evidence afterward.

Success means the early playtest can reliably run up to five simultaneous 5v5 matches for 50 players.

## Positioning

**Inferred pending owner confirmation:** B2G is a CS:GO-first competitive home rather than a broad multi-game ladder. Its differentiator is the complete legacy-CS:GO loop—managed queues and servers, visible ranks, non-kernel evidence-first trust controls, demos, and auditable match operations—without requiring invasive client access.

## Operating Context

Players sign in with Steam, choose Competitive or Deathmatch, enter a regional queue, accept a ready check where applicable, connect through the B2G launcher, and return to the web product for results, demos, reports, standing, and account management.

Competitive is ranked 5v5 with player map preferences and a captain veto. Deathmatch is unrated free-for-all, first to 40 kills or 10 minutes, and always launches on a randomly selected eligible map; players never choose or veto its map.

The current launch phase is a free private playtest.

## Capabilities and Constraints

- React/Vite web client, Express API, PostgreSQL, Redis, S3-compatible demo storage, a Windows game-node agent, legacy CS:GO SRCDS, and a native Windows launcher.
- Steam OpenID identity; B2G never receives Steam passwords.
- Competitive requires 10 players. Deathmatch targets 14 free-for-all players.
- Deathmatch ends at 40 kills or 600 seconds and uses a server-selected random eligible map.
- The initial target is 50 concurrent playtesters and at most five concurrent 5v5 matches; deployed capacity can be lower until more game nodes are added and must be presented honestly.
- New accounts must choose a unique in-game name.
- Anti-cheat should be powerful but minimally invasive: server-side and evidence-first, no kernel driver, human review for severe actions, and no automatic permanent bans during the initial playtest.
- Authentic CS:GO matchmaking rank imagery is sourced from `apps/web/public/ranks/`; provenance is documented in `docs/third-party-assets.md`.
- Internal `aftertick` package and environment names may remain temporarily for deployment compatibility, but user-facing product language is B2G/back2csgo.

## Brand Commitments

- Product name: **back2csgo**. Compact product mark: **B2G**. Do not show the retired Aftertick name to players.
- The owner selected a polished, familiar esports-dashboard visual world. Execute that convention at the craft level of FACEIT, ESEA, and Steam while retaining B2G's own palette, typography, assets, and product structure; do not import competitor branding or FACEIT orange.
- The product should feel deliberately human-made and rooted in organized Counter-Strike, not like a generic AI-generated SaaS dashboard, casino, or FACEIT imitation.
- Preserve the strongest competition-bulletin and tactical-match-sheet ideas already present.
- Do not use FACEIT-like orange as the primary accent. Current binding direction uses muted CT blue for primary actions, restrained T-side sand for secondary emphasis, green only for health/live status, and red only for actual failure or cancellation.
- Real rank icons must be used wherever rank identity is shown.
- The header connection/live control must provide useful realtime details, not exist as decoration.

## Evidence on Hand

- Product/workflow foundation: `docs/product-foundation.md`.
- Implemented platform and operational claims: `README.md` and `docs/remaining-work.md`.
- Current interface: `apps/web/src/`.
- Rank icons are not included in the public source (Valve artwork).
- Rank provenance: `docs/third-party-assets.md`.
- No customer testimonials, public adoption claims, or audited anti-cheat efficacy evidence is available; future UI must not fabricate them.

## Product Principles

1. Put trustworthy match facts ahead of decorative gaming spectacle.
2. Make the next competitive action unmistakable and keep its consequences legible.
3. Preserve legacy CS:GO familiarity while giving B2G an independent identity.
4. Prefer transparent, evidence-backed enforcement over invasive or opaque client control.
5. Keep playtest limitations, capacity, and operational health honest.

## Accessibility & Inclusion

The web interface must support keyboard use, visible focus, semantic controls and headings, useful live regions, reduced motion, color-independent status cues, responsive layouts, and touch targets of at least 44 by 44 CSS pixels where practical. The production readiness gate includes automated and rendered accessibility/responsive verification.
