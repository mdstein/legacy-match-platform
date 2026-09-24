import type { PlayerProfile } from "@aftertick/contracts";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { DetailDialog } from "./DetailDialog.js";
import { RankIcon } from "./RankIcon.js";

interface ProfileDialogProps {
  profile: PlayerProfile;
  onClose: () => void;
  onLogout?: () => void;
  onDiscipline?: () => void;
}

export function RatingChart({ profile }: { profile: PlayerProfile }) {
  const points = [...profile.ratingHistory].reverse();
  if (points.length === 0) {
    return <p className="detail-empty">Complete a rated match to begin the rating timeline.</p>;
  }

  const ratings = [points[0]?.previousRating ?? profile.rank.rating, ...points.map((point) => point.rating)];
  const minimum = Math.min(...ratings) - 20;
  const maximum = Math.max(...ratings) + 20;
  const range = Math.max(1, maximum - minimum);
  const coordinates = ratings.map((rating, index) => {
    const x = ratings.length === 1 ? 0 : (index / (ratings.length - 1)) * 100;
    const y = 44 - ((rating - minimum) / range) * 40;
    return `${x},${y}`;
  }).join(" ");

  return (
    <figure className="rating-chart">
      <svg viewBox="0 0 100 48" role="img" aria-label={`Rating changed from ${ratings[0]} to ${ratings.at(-1)}`}>
        <polyline className="rating-chart-fill" points={`0,48 ${coordinates} 100,48`} />
        <polyline className="rating-chart-line" points={coordinates} />
      </svg>
      <figcaption>
        <span>{ratings[0]?.toLocaleString()} start</span>
        <strong>{ratings.at(-1)?.toLocaleString()} current</strong>
      </figcaption>
    </figure>
  );
}

export function ProfileDialog({ profile, onClose, onLogout, onDiscipline }: ProfileDialogProps) {
  const [copiedId, setCopiedId] = useState(false);
  const kd = profile.totals.deaths === 0
    ? profile.totals.kills.toFixed(2)
    : (profile.totals.kills / profile.totals.deaths).toFixed(2);

  const copyPlayerId = () => {
    void navigator.clipboard.writeText(profile.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  return (
    <DetailDialog title={profile.displayName} eyebrow={`${profile.region} player profile`} onClose={onClose}>
      <div className="profile-hero">
        <RankIcon rank={profile.rank.name} size="lg" />
        <div className="profile-hero-info">
          <strong>{profile.rank.name}</strong>
          <span>{profile.rank.rating.toLocaleString()} Elo</span>
        </div>
        <button
          type="button"
          className="profile-id-copy"
          onClick={copyPlayerId}
          title={`Copy player ID (${profile.id})`}
          aria-label="Copy player ID"
        >
          {copiedId ? <Check size={13} /> : <Copy size={13} />}
          <span>{copiedId ? "Copied ID" : "Copy ID"}</span>
        </button>
      </div>

      <dl className="detail-metrics">
        <div><dt>Matches</dt><dd>{profile.matchesPlayed}</dd></div>
        <div><dt>Win rate</dt><dd>{profile.winRate}%</dd></div>
        <div><dt>K/D</dt><dd>{kd}</dd></div>
        <div><dt>ADR</dt><dd>{profile.totals.averageAdr}</dd></div>
        <div><dt>KAST</dt><dd>{profile.totals.averageKast}%</dd></div>
        <div><dt>Record</dt><dd>{profile.totals.wins}-{profile.totals.losses}-{profile.totals.draws}</dd></div>
      </dl>

      <section className="detail-section" aria-labelledby="rating-history-title">
        <div className="detail-section-heading">
          <h3 id="rating-history-title">Rating history</h3>
          <span>{profile.ratingHistory.length} rated matches</span>
        </div>
        <RatingChart profile={profile} />
      </section>
      {onLogout && (
        <div className="profile-account-actions">
          {onDiscipline && <button className="btn btn--secondary" type="button" onClick={onDiscipline}>Account standing</button>}
          <button className="btn btn--secondary" type="button" onClick={onLogout}>Sign out</button>
        </div>
      )}
    </DetailDialog>
  );
}
