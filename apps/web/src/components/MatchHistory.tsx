import type { RecentMatch } from "@aftertick/contracts";
import { ArrowUpRight, FileCheck2 } from "lucide-react";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

interface MatchHistoryProps {
  matches: RecentMatch[];
  onMatch: (matchId: string) => void;
}

export function MatchHistory({ matches, onMatch }: MatchHistoryProps) {
  return (
    <section className="history-card" id="matches">
      <div className="history-header">
        <h2 className="history-title">Recent Matches</h2>
        <a className="history-link" href="#rating">
          Rating model <ArrowUpRight size={12} />
        </a>
      </div>

      <div className="match-table" role="table" aria-label="Recent rated matches">
        <div className="match-table-head" role="row">
          <span role="columnheader" />
          <span role="columnheader">Map</span>
          <span role="columnheader">Score</span>
          <span role="columnheader">K&ndash;D</span>
          <span role="columnheader">ADR</span>
          <span role="columnheader">Elo</span>
        </div>

        {matches.map((match) => (
          <button
            className="match-row"
            type="button"
            role="row"
            key={match.id}
            onClick={() => onMatch(match.id)}
            aria-label={`Open ${match.map} match, ${match.score}, ${match.outcome === "W" ? "win" : match.outcome === "L" ? "loss" : "draw"}`}
          >
            <span
              className={`result-badge result-badge--${match.outcome.toLowerCase()}`}
              role="cell"
            >
              {match.outcome}
            </span>

            <div className="match-cell" role="cell">
              <span className="match-cell-label">Map</span>
              <span className="match-map">
                {match.map}
                {match.hasDemo && <FileCheck2 className="match-demo-icon" size={11} aria-label="Demo available" />}
              </span>
              <span className="match-date">{formatDate(match.playedAt)}</span>
            </div>

            <div className="match-cell" role="cell">
              <span className="match-cell-label">Score</span>
              <span className="match-score">{match.score}</span>
            </div>

            <div className="match-cell" role="cell">
              <span className="match-cell-label">K&ndash;D</span>
              <span className="match-stat">
                {match.kills}&ndash;{match.deaths}
              </span>
            </div>

            <div className="match-cell" role="cell">
              <span className="match-cell-label">ADR</span>
              <span className="match-stat">{match.adr}</span>
            </div>

            <div
              className={`match-elo ${match.ratingDelta > 0 ? "color-positive" : "color-negative"}`}
              role="cell"
            >
              <span className="match-cell-label">Elo</span>
              {match.ratingDelta > 0 ? "+" : ""}
              {match.ratingDelta}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
