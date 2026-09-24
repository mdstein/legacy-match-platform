import type { PlayerProfile } from "@aftertick/contracts";
import { ArrowLeft, Check, Copy, Settings, ShieldCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import { MatchesPage } from "./MatchesPage.js";
import { RatingChart } from "./ProfileDialog.js";
import { RankIcon } from "./RankIcon.js";

interface PlayerProfilePageProps {
  profile: PlayerProfile;
  currentPlayerId: string;
  onBack: () => void;
  onMatch: (matchId: string) => void;
  onSettings: () => void;
  onStanding: () => void;
  onInvite: (playerId: string) => void;
}

export function PlayerProfilePage({
  profile,
  currentPlayerId,
  onBack,
  onMatch,
  onSettings,
  onStanding,
  onInvite
}: PlayerProfilePageProps) {
  const [copiedId, setCopiedId] = useState(false);
  const isSelf = profile.id === currentPlayerId;
  const kd = profile.totals.deaths === 0
    ? profile.totals.kills.toFixed(2)
    : (profile.totals.kills / profile.totals.deaths).toFixed(2);

  const copyPlayerId = () => {
    void navigator.clipboard.writeText(profile.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  return (
    <section className="player-profile-page" aria-labelledby="player-profile-title">
      <button className="profile-back" type="button" onClick={onBack}>
        <ArrowLeft size={16} /> Back
      </button>

      <header className="profile-page-hero">
        <div className="profile-page-identity">
          <span className="profile-page-avatar">{profile.initials}</span>
          <div>
            <span className="profile-page-kicker">{profile.region} player</span>
            <h1 id="player-profile-title">{profile.displayName}</h1>
            <button className="profile-id-copy" type="button" onClick={copyPlayerId} aria-label="Copy player ID">
              {copiedId ? <Check size={13} /> : <Copy size={13} />}
              {copiedId ? "Copied ID" : "Copy player ID"}
            </button>
          </div>
        </div>

        <div className="profile-page-rank">
          <RankIcon rank={profile.rank.name} size="lg" />
          <span><strong>{profile.rank.rating.toLocaleString()}</strong> Elo</span>
          <small>{profile.rank.name}</small>
        </div>
      </header>

      <div className="profile-page-actions">
        {isSelf ? (
          <>
            <button className="btn btn--secondary" type="button" onClick={onSettings}><Settings size={15} /> Account settings</button>
            <button className="btn btn--secondary" type="button" onClick={onStanding}><ShieldCheck size={15} /> Account standing</button>
          </>
        ) : (
          <button className="btn btn--primary" type="button" onClick={() => onInvite(profile.id)}><UserPlus size={15} /> Invite to party</button>
        )}
      </div>

      <dl className="profile-stat-grid">
        <div><dt>Current Elo</dt><dd>{profile.rank.rating.toLocaleString()}</dd></div>
        <div><dt>Rank</dt><dd>{profile.rank.shortName}</dd></div>
        <div><dt>Matches</dt><dd>{profile.matchesPlayed}</dd></div>
        <div><dt>Win rate</dt><dd>{profile.winRate}%</dd></div>
        <div><dt>K/D</dt><dd>{kd}</dd></div>
        <div><dt>ADR</dt><dd>{profile.totals.averageAdr}</dd></div>
        <div><dt>KAST</dt><dd>{profile.totals.averageKast}%</dd></div>
        <div><dt>Record</dt><dd>{profile.totals.wins}–{profile.totals.losses}–{profile.totals.draws}</dd></div>
      </dl>

      <section className="profile-rating-section" aria-labelledby="profile-rating-title">
        <div className="profile-section-heading">
          <div>
            <span>Performance</span>
            <h2 id="profile-rating-title">Elo trajectory</h2>
          </div>
          <small>{profile.ratingHistory.length} rated matches recorded</small>
        </div>
        <RatingChart profile={profile} />
      </section>

      <MatchesPage
        matches={profile.recentMatches}
        onMatch={onMatch}
        title="Recent matches"
        description={`${profile.displayName}'s latest scores, performance, Elo movement, and available match evidence.`}
      />
    </section>
  );
}
