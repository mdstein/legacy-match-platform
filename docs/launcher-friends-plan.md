# Launcher friends and profiles

Implemented and deployed in [0.2.33](playtest-0.2.33.md). The stages below record
the implementation scope; two-account human acceptance remains outstanding.

Build on `claude/b2g-launcher-icons-and-profile-picture` at `fdde8b0`, retaining
both author commits and the established native palette, icon rasterizer,
picture chooser, typography, hover behavior and persistent Play footer.

1. Add durable B2G friendships: player search, incoming/outgoing requests,
   explicit acceptance, decline/cancel/remove, bounded lists, retry-safe request
   identities and stale-request protection. Use authenticated launcher devices;
   no operations on the owner's real friend list during automated tests.
2. Expose a minimal public profile projection with current ELO/authentic rank,
   membership date, Steam link, mode-specific games/wins/win rate/KD/ADR and
   paged recent matches. Follow the information hierarchy of the supplied
   FACEIT profile without copying its branding or adding unrelated features.
   Private profiles reveal only identity and relationship controls.
3. Build a native Friends tab with list/request/search navigation and a full
   profile view. Include own-profile and direct profile links from trading and
   match-player details where practical. Keep all I/O off the window thread,
   fence stale account/view responses and update lists quietly without losing
   focus or selection. Preserve the author's local profile-picture preference.
4. Verify real-DB request lifecycle, concurrent/crossed requests, retry and stale
   acceptance, authorization/privacy, mode statistics and pagination. Exercise
   native controls and supported size/DPI states, then perform the bounded
   Impeccable reviewer/documenter handoffs.
5. Version, build, publish and verify launcher/API/web; apply the additive friend
   migration with backup/rollback checks. Commit/push the completed work using
   the owner's standing authorization. Preserve their clean-install test state.

Acceptance still needs two human accounts observing requests and profiles in
the launcher. A recruited 5v5 is not a prerequisite for implementation.
