---
version: 1
slug: "apps-web-src-app-tsx"
primary_target: "apps/web/src/App.tsx"
related_targets: ["apps/web/src/styles.css","apps/web/src/components/QueuePanel.tsx","apps/web/src/components/PlayerSidebar.tsx","apps/web/src/components/MatchesPage.tsx","apps/web/src/components/AccountPage.tsx"]
---

# B2G Player Application

- **Scope:** signed-in player application shell, beginning with Play and governing Matches, Ladder, Account, onboarding, queue, and match-ready states.
- **Mode:** Operate.
- **Audience and job:** a legacy CS:GO player must understand match conditions, choose a mode, enter a trustworthy queue, and monitor the resulting state quickly.
- **Primary action:** Find a Match; cancellation, ready checks, connection, and match review remain immediately legible secondary actions.
- **Proof and content:** authentic CS:GO rank assets, visible Elo, route health, queue rules, selected Competitive maps, random-map Deathmatch rules, party state, trust/standing, and real recent-match data.
- **Constraints:** B2G/back2csgo only; no retired Aftertick name; no FACEIT orange; no invented adoption or capacity claims; Deathmatch never exposes map selection or veto; current playtest remains free.
- **Chosen direction:** polished familiar esports dashboard at FACEIT/ESEA/Steam craft level, with B2G's graphite, warm white, CT blue, T-side sand, and functional status colors.
- **Approved composition:** `.impeccable/mocks/b2g-play-comp-01.png` — top navigation, queue workspace on the left two-thirds, persistent player dossier on the right, recent-match ledger at the fold.
- **Memorable moment:** changing mode rewrites the queue workspace in place; Deathmatch visibly collapses map controls into a concise `40 kills · 10 minutes · random map` rules strip.
- **Responsive order:** navigation, queue task, player identity/standing, party, then recent matches. No capability disappears on narrow screens.
- **Unresolved:** live production capacity must come from real metrics rather than the mockup's synthetic counts.
