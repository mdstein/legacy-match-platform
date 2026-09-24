import type { PartyInvite, PartyState, PlayerView } from "@aftertick/contracts";
import { RANKS } from "@aftertick/rating";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { PartyPanel } from "./PartyPanel.js";
import { RankIcon } from "./RankIcon.js";

interface PlayerSidebarProps {
  player: PlayerView;
  lastFourDelta: number;
  party: PartyState | null;
  partyInvites: PartyInvite[];
  partyPending: boolean;
  partyError: string | null;
  onCreateParty: () => void;
  onInvite: (playerId: string) => void;
  onAcceptInvite: (inviteId: string) => void;
  onPartyReady: (ready: boolean) => void;
  onTransferLeader: (playerId: string) => void;
  onLeaveParty: () => void;
}

export function PlayerSidebar({
  player,
  lastFourDelta,
  party,
  partyInvites,
  partyPending,
  partyError,
  onCreateParty,
  onInvite,
  onAcceptInvite,
  onPartyReady,
  onTransferLeader,
  onLeaveParty
}: PlayerSidebarProps) {
  const [copiedId, setCopiedId] = useState(false);
  const pointsToPromotion = player.rank.nextRankFloor
    ? player.rank.nextRankFloor - player.rank.rating
    : 0;

  const copyPlayerId = () => {
    void navigator.clipboard.writeText(player.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  return (
    <aside className="sidebar-card" id="rating">
      {/* ── Rating ── */}
      <div className="sb-rating">
        <div className="sb-identity">
          <span className="sb-avatar">{player.initials}</span>
          <div className="sb-identity-details">
            <strong className="sb-name">{player.displayName}</strong>
            <span className="sb-region">{player.region}</span>
          </div>
          <button
            type="button"
            className="sb-id-copy"
            onClick={copyPlayerId}
            title={`Copy player ID (${player.id}) for party invites`}
            aria-label="Copy player ID for party invites"
          >
            {copiedId ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>

        <div className="sb-rank-heading">
          <RankIcon rank={player.rank.name} size="lg" />
          <p className="sb-rank-label">{player.rank.name}</p>
        </div>
        <div className="sb-elo-row">
          <span className="sb-elo">{player.rank.rating.toLocaleString()}</span>
          <span className="sb-elo-unit">Elo</span>
        </div>

        <div className="sb-progress">
          <div className="sb-progress-labels">
            <span>{player.rank.shortName}</span>
            <span>{player.rank.nextRank ?? "Top"}</span>
          </div>
          <div
            className="sb-bar"
            role="progressbar"
            aria-label="Progress to next rank"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(player.rank.progress * 100)}
          >
            <i style={{ transform: `scaleX(${player.rank.progress})` }} />
          </div>
          <p className="sb-progress-note">
            {player.rank.nextRank
              ? `${pointsToPromotion} to ${player.rank.nextRank}`
              : "Global Elite secured"}
          </p>
        </div>

        <div className="sb-stats">
          <div>
            <span className="sb-stat-label">Win rate</span>
            <span className="sb-stat-value">{player.winRate}%</span>
          </div>
          <div>
            <span className="sb-stat-label">Matches</span>
            <span className="sb-stat-value">{player.matchesPlayed}</span>
          </div>
          <div>
            <span className="sb-stat-label">Last 4</span>
            <span className={`sb-stat-value ${lastFourDelta >= 0 ? "color-positive" : "color-negative"}`}>
              {lastFourDelta >= 0 ? "+" : ""}{lastFourDelta}
            </span>
          </div>
        </div>
      </div>

      <PartyPanel
        player={player}
        party={party}
        invites={partyInvites}
        pending={partyPending}
        error={partyError}
        onCreate={onCreateParty}
        onInvite={onInvite}
        onAcceptInvite={onAcceptInvite}
        onReady={onPartyReady}
        onTransferLeader={onTransferLeader}
        onLeave={onLeaveParty}
      />

      {/* ── Trust ── */}
      <div className="sb-section sb-trust">
        <ShieldCheck size={14} />
        <strong>Clear to queue</strong>
        <span className="sb-dim">&middot; {player.matchesPlayed} matches, no penalties</span>
      </div>

      {/* ── Expandables ── */}
      <details className="sb-expand">
        <summary>
          How Elo moves <span className="sb-chevron">+</span>
        </summary>
        <div className="sb-expand-body">
          <p>
            Outcome and opponent strength carry the most weight. Performance adjusts
            the result but never inverts it.
          </p>
          <dl className="sb-expand-dl">
            <div><dt>Balanced match</dt><dd>+25 / &minus;25</dd></div>
            <div><dt>Performance adj.</dt><dd>&plusmn;7 max</dd></div>
            <div><dt>Placement period</dt><dd>10 matches</dd></div>
          </dl>
        </div>
      </details>

      <details className="sb-expand">
        <summary>
          All 18 ranks <span className="sb-chevron">+</span>
        </summary>
        <div className="sb-expand-body">
          <ol className="sb-rank-list">
            {[...RANKS].reverse().map((rank) => (
              <li
                key={rank.name}
                className={rank.name === player.rank.name ? "is-current" : ""}
              >
                <span><RankIcon rank={rank.name} size="sm" decorative />{rank.name}</span>
                <strong>{rank.floor}+</strong>
              </li>
            ))}
          </ol>
        </div>
      </details>
    </aside>
  );
}
