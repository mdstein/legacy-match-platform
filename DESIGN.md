---
name: "back2csgo"
description: "A disciplined tournament desk for the next honest CS:GO match."
colors:
  graphite-base: "#161719"
  graphite-surface: "#18191b"
  graphite-layer: "#202225"
  graphite-input: "#101214"
  rule: "#34383b"
  rule-strong: "#464a4d"
  ct-blue: "#6fa5e9"
  ct-blue-action: "#385fab"
  ct-blue-hover: "#456fb8"
  rank-sand: "#b99a63"
  score-paper: "#f1efea"
  score-paper-field: "#faf8f3"
  score-ink: "#24272a"
  text: "#f3efeb"
  text-secondary: "#b3b5b6"
  text-muted: "#85898b"
  on-action: "#ffffff"
  health: "#5fbd67"
  failure: "#e54d49"
  warning: "#f59e0b"
  focus: "#8da9e9"
typography:
  display:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(2.5rem, 7vw, 5.25rem)"
    fontWeight: 600
    lineHeight: 0.92
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Barlow, Segoe UI, sans-serif"
    fontSize: "clamp(2.4rem, 6vw, 4.25rem)"
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Barlow, Segoe UI, sans-serif"
    fontSize: "0.93rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.055em"
  body:
    fontFamily: "Barlow, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Barlow, Segoe UI, sans-serif"
    fontSize: "0.67rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.075em"
  data:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "normal"
  rank-label:
    fontFamily: "Encode Sans Expanded, Segoe UI, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  mark:
    fontFamily: "Unbounded, Segoe UI, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "normal"
rounded:
  none: "0"
spacing:
  xxs: "0.25rem"
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.25rem"
  xl: "1.5rem"
  2xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.ct-blue-action}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.65rem 1.25rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.ct-blue-hover}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.none}"
  button-secondary:
    backgroundColor: "{colors.graphite-layer}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.65rem 1.25rem"
    height: "2.75rem"
  field-queue:
    backgroundColor: "{colors.score-paper-field}"
    textColor: "{colors.score-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 1rem"
    height: "3.25rem"
  navigation-active:
    backgroundColor: "transparent"
    textColor: "{colors.ct-blue}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "4.85rem"
  mode-selected:
    backgroundColor: "{colors.score-paper-field}"
    textColor: "{colors.ct-blue-hover}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.65rem 1rem"
    height: "3.55rem"
  card-queue:
    backgroundColor: "{colors.score-paper}"
    textColor: "{colors.score-ink}"
    rounded: "{rounded.none}"
    padding: "clamp(1rem, 2vw, 1.75rem)"
  card-dossier:
    backgroundColor: "{colors.graphite-surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "1.4rem 1.35rem 1.2rem"
  match-ledger-row:
    backgroundColor: "{colors.graphite-surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "1rem 0.75rem"
  status-live:
    backgroundColor: "{colors.graphite-input}"
    textColor: "{colors.health}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.35rem 1rem"
    height: "3rem"
---

# Design System: back2csgo

## Overview

**Creative North Star: "The Tournament Desk"**

back2csgo feels like the working desk behind an organized Counter-Strike competition: disciplined, documentary, operational, and immediately familiar to a returning player. The dark graphite shell holds persistent navigation, standing, and evidence; a warm score-paper queue surface turns the next match into the one obvious task. Dense information is acceptable when it reads like a match sheet rather than a generic dashboard.

The system is deliberately human-made. CT blue identifies decisions and selected state, rank sand is reserved for earned standing, and green or red appears only when the underlying fact is healthy or failed. Authentic rank SVGs and generated map plates are product assets with their own provenance; they are not palette or shape tokens.

**Key Characteristics:**

- Graphite operations shell around a warm, paper-like queue workspace.
- Sharp match-sheet geometry, hairline rules, and almost no decorative depth.
- Barlow-led typography with condensed data figures and a single expanded rank label.
- CT blue for action and selection; rank sand for standing; semantic status colors only.
- Real match imagery, real rank marks, tabular numerals, and evidence-first states.

## Colors

The palette separates the operational shell from the score-paper task surface, then uses small, disciplined color signals to mark decisions, standing, and match truth.

### Primary

- **CT Signal Blue:** The brighter blue identifies active navigation, progress, focus-adjacent emphasis, and selected-state details.
- **CT Action Blue:** The deeper blue fills queue, route, party, and primary form actions; its hover step is the established lighter deep-blue state.

### Secondary

- **Rank Sand:** A restrained warm metal used for rank name, Elo, and the B2G wordmark detail. It signals earned standing, never a generic call to action.

### Tertiary

- **Health Green:** Reserved for connected, ready, clear-standing, win, and validated states.
- **Failure Red:** Reserved for losses, destructive actions, queue errors, and cancellation or failure states.
- **Operational Amber:** Reserved for warnings, ready-check urgency, and paused service conditions.

### Neutral

- **Graphite Base:** The outer application field and page background.
- **Graphite Surface:** The default dossier, ledger, settings, and dark card material.
- **Graphite Layer:** A small tonal lift for secondary controls and hover rows.
- **Graphite Input:** The recessed dark field and connection-control surface.
- **Structural Rules:** Quiet and strong hairlines divide surfaces and controls without creating card clutter.
- **Score Paper:** The warm queue work surface; its brighter field step separates selectable form values.
- **Score Ink:** Near-black copy used on the paper surface.
- **Warm Text:** High-contrast shell text supported by secondary and muted gray levels.

### Named Rules

**The Decision Blue Rule.** Blue means the player can act, has selected something, or is reading the current route; it never becomes ambient decoration.

**The Earned Gold Rule.** Rank sand belongs to standing and identity, not buttons, warnings, or broad surface fills.

**The Status Is Evidence Rule.** Green, red, and amber must pair with a word, value, or state change; color alone never carries operational meaning.

## Typography

**Display Font:** Barlow Condensed (with Arial Narrow and sans-serif fallback)

**Body Font:** Barlow (with Segoe UI and sans-serif fallback)

**Label/Rank Font:** Barlow for operational labels; Encode Sans Expanded for the dossier rank name; Unbounded is limited to compact player initials and mark-like accents.

**Character:** Barlow keeps the interface plainspoken and athletic without copying broadcast graphics. Condensed figures make match evidence compact, while the expanded rank label slows down the one piece of identity that should feel earned.

### Hierarchy

- **Display** (600, fluid 2.5–5.25rem, 0.92): Large authentication and ceremonial entry headlines only.
- **Headline** (700, fluid 2.4–4.25rem, 0.95): Uppercase page titles for Matches and Settings.
- **Title** (700, 0.93rem, 1): Section and ledger titles; normally uppercase with tracked lettering.
- **Body** (400, 0.875rem, 1.5): Instructions, explanations, and supporting operational copy.
- **Label** (700, 0.67rem, 0.075em tracking): Uppercase field names, column heads, status labels, and compact controls.
- **Data** (600, 1.25rem, 1): Elo, match totals, queue facts, and other short tabular figures.
- **Rank Label** (700, 0.7rem, 1.3): The authentic rank name beneath its emblem in the player dossier.

### Named Rules

**The Match Sheet Rule.** Use uppercase tracked labels to identify a value, then let the value carry the visual weight; never enlarge helper copy to manufacture hierarchy.

**The Numeric Evidence Rule.** Ratings, scores, timings, and match statistics use tabular figures and stay aligned across rows and state changes.

## Layout

The authenticated shell is full-width and edge-aware rather than centered inside a marketing container. Header and main padding scale from 1rem to 1.9rem and include safe-area insets; the page bottom breathes from 2rem to 4rem. The base spacing rhythm uses quarter-rem increments, with 0.75rem, 1rem, 1.25rem, and 1.5rem doing most of the work.

At 64rem and above, Play is a two-column desk: the queue and recent-match ledger occupy a `2.5fr` left column, while a minimum 20rem dossier occupies the right and remains sticky beneath the header. The left ledger begins immediately below the queue; the absence of a gap between queue and ledger makes them read as one working sheet, while a 1.1rem gutter separates the dossier.

Below 64rem, content becomes a single sequence: queue, player identity and party, then recent matches. At 45rem and below, the header wraps into a full-width navigation row, queue fields become one column, map plates become a two-column grid, and outer page padding tightens to 0.75rem. No capability disappears; compact labels and secondary mode descriptions yield before controls do. Coarse pointers receive a practical 2.75rem minimum target height.

**The Next Match Rule.** The queue task remains first in responsive reading order, followed by identity and standing, then recent evidence.

## Elevation & Depth

The system is flat at rest. Graphite layers, paper-versus-shell contrast, hairline borders, and row dividers establish depth; queue, dossier, and ledger surfaces carry no resting shadow. Shadows acknowledge the primary action or a transient overlay, while an inset blue rule marks an active queue without pretending the whole surface floats.

### Shadow Vocabulary

- **Primary Action:** `0 8px 22px rgba(34, 61, 113, 0.2)` at rest and `0 10px 25px rgba(34, 61, 113, 0.25)` on hover; only for the central Find a Match action.
- **Connection Popover:** `0 1rem 2.5rem rgba(0, 0, 0, 0.42)`; separates realtime details from the sticky shell.
- **Modal Overlay:** `0 16px 48px rgba(0, 0, 0, 0.8)`; reserved for blocking dialogs over a dark scrim.

### Named Rules

**The Flat Desk Rule.** Resting product surfaces are separated by material and rules, not ambient card shadows.

**The Acknowledged Action Rule.** A shadow is allowed only when it confirms the primary next action or separates a transient overlay.

## Shapes

The product uses square corners throughout: radius tokens resolve to zero, fields meet their borders directly, and cards read as sections of one match desk rather than floating objects. One-pixel rules are the dominant silhouette; selected map plates add a two-pixel CT-blue outer stamp.

Skew is a mark language, not a container language. The B2G wordmark and player-initial block carry a slight forward lean, while operational surfaces remain orthogonal. Circles are limited to status dots and progress signals whose roundness conveys a point rather than a container.

**The Hard Edge Rule.** New cards, fields, buttons, and overlays inherit square corners; do not reintroduce rounded SaaS capsules.

## Components

### Buttons

- **Shape:** Rectangular and square-cornered, with a 2.75rem minimum height; the queue CTA grows to 3.6rem and a maximum width of 24rem.
- **Primary:** CT Action Blue with white type, uppercase labeling, and compact tracking. The central queue action alone receives structural shadow and a small forward icon motion on hover.
- **Hover / Focus:** Hover advances to CT Blue Hover in 120ms; keyboard focus uses a two-pixel Focus outline with a two-pixel offset; active state compresses to 0.99 scale.
- **Secondary / Danger:** Secondary controls use a graphite layer and strong rule. Danger uses a dark red field and red border; its label changes to white only at the destructive hover state.

### Chips

- **Style:** Status chips are squared, bordered, and text-led. The live control is a three-rem-high graphite block with a colored dot and explicit Live or Offline label.
- **State:** Opening a status chip reveals useful route, API, platform, and season details. Never ship a decorative presence pill without this underlying evidence.

### Cards / Containers

- **Corner Style:** Square corners throughout.
- **Background:** Warm Score Paper for the queue task; Graphite Surface for dossier, history, settings, and evidence containers.
- **Shadow Strategy:** Flat at rest; follow the Elevation rules for action and overlays.
- **Border:** One-pixel Structural Rules frame and divide all major working surfaces.
- **Internal Padding:** Dense sections use 1–1.35rem; primary work areas scale from 1rem to 1.75rem.

### Inputs / Fields

- **Style:** Paper-side fields are 3.25rem high with a bright paper fill, dark score ink, a strong neutral rule, uppercase value text, and no radius. Dark-shell fields use Graphite Input with the same hard edge.
- **Focus:** Focus is a two-pixel pale-blue outline; hovered queue selects shift their border to CT Blue Hover.
- **Error / Disabled:** Disabled controls reduce opacity or use muted copy without losing their label. Errors pair Failure Red with a message and border or left rule.

### Navigation

The top navigation lives on the darkest shell strip. Barlow labels are bold and lightly tracked; the active item turns CT blue and carries a four-pixel bottom rule. On narrow screens it becomes a full-width equal-column row beneath the brand and account controls, preserving every destination.

### Mode and Map Selection

Mode choice is a two-part paper control. The selected half lifts to the brightest paper, turns deep CT blue, and receives an inset blue bottom stamp. Competitive maps are real image plates in a seven-column desktop grid; selection restores saturation, adds a two-pixel blue frame, and stamps a checked square in the upper-left. The grid contracts to four and then two columns without changing selection behavior.

### Player Dossier

The dossier is the persistent dark counterweight to the queue sheet. It centers the authentic rank SVG, renders rank name and Elo in Rank Sand, aligns supporting figures as a three-column ledger, and keeps party, standing, and rating explanation in ruled sections below.

### Match Ledger

Recent matches are compact, full-width evidence rows. Result letters remain plain text in Health Green, Failure Red, or neutral gray; map, score, K–D, ADR, and Elo align as tabular columns. Mobile rows remove lower-priority columns, while the Matches page restores full date and demo evidence at wider widths.

## Do's and Don'ts

### Do:

- **Do** keep the next honest match visually dominant through the warm queue sheet and a single central blue action.
- **Do** use authentic rank SVGs and real map plates wherever standing or map identity is shown.
- **Do** pair every operational color with a label, value, icon, border, or explicit state change.
- **Do** preserve square geometry, one-pixel structural rules, tabular numerals, visible focus, reduced-motion behavior, and responsive task order.
- **Do** let mode changes rewrite the same queue workspace; Deathmatch condenses the map controls into its factual rules strip.

### Don't:

- **Don't** turn the shell into generic AI SaaS with floating metric cards, decorative hero copy, or interchangeable dashboard tiles.
- **Don't** use casino neon, FACEIT orange imitation, gradients, glassmorphism, broad glow, or spectacle that competes with queueing.
- **Don't** spend rank sand on primary actions or use green and red as decoration.
- **Don't** add excessive rounding, capsule controls, or ambient shadows to resting surfaces.
- **Don't** invent live activity, capacity, match evidence, or status; the desk shows only facts the product can support.
