import type { GameMode, RecentMatch } from "@aftertick/contracts";
import { CalendarDays, Crosshair, FileCheck2, Search } from "lucide-react";
import { useMemo, useState } from "react";

interface MatchesPageProps {
  matches: RecentMatch[];
  onMatch: (matchId: string) => void;
  title?: string;
  description?: string;
  total?: number;
  pending?: boolean;
  onLoadMore?: () => void;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function MatchesPage({
  matches,
  onMatch,
  title = "Your last ten",
  description = "Your match archive keeps scores, performance, Elo movement, demos, and report evidence in one ledger.",
  total,
  pending = false,
  onLoadMore
}: MatchesPageProps) {
  const [mode, setMode] = useState<"all" | GameMode>("all");
  const [result, setResult] = useState<"all" | RecentMatch["outcome"]>("all");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => matches.filter((match) => {
    const matchMode = match.mode ?? "competitive";
    return (mode === "all" || matchMode === mode)
      && (result === "all" || match.outcome === result)
      && match.map.toLowerCase().includes(query.trim().toLowerCase());
  }), [matches, mode, query, result]);
  const wins = matches.filter((match) => match.outcome === "W").length;
  const netElo = matches.reduce((total, match) => total + match.ratingDelta, 0);

  return (
    <section className="matches-page" aria-labelledby="matches-page-title">
      <header className="page-heading">
        <div>
          <h1 id="matches-page-title">{title}</h1>
          <p>{description}</p>
        </div>
        <dl className="matches-summary">
          <div><dt>{total === undefined ? "Record" : "Shown"}</dt><dd>{total === undefined ? `${wins}–${matches.length - wins}` : `${matches.length}/${total}`}</dd></div>
          <div><dt>Net Elo</dt><dd className={netElo >= 0 ? "color-positive" : "color-negative"}>{netElo >= 0 ? "+" : ""}{netElo}</dd></div>
          <div><dt>Demos</dt><dd>{matches.filter((match) => match.hasDemo).length}/{matches.length}</dd></div>
        </dl>
      </header>

      <div className="matches-toolbar" aria-label="Match filters">
        <label className="matches-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search maps</span>
          <input name="match-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search map" />
        </label>
        <label>
          <span>Mode</span>
          <select name="match-mode" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="all">All modes</option>
            <option value="competitive">Competitive</option>
            <option value="deathmatch">Deathmatch</option>
          </select>
        </label>
        <label>
          <span>Result</span>
          <select name="match-result" value={result} onChange={(event) => setResult(event.target.value as typeof result)}>
            <option value="all">All results</option>
            <option value="W">Wins</option>
            <option value="L">Losses</option>
            <option value="D">Draws</option>
          </select>
        </label>
      </div>

      <div className="matches-ledger">
        {filtered.length === 0 ? (
          <div className="matches-empty">
            <Crosshair size={22} />
            <strong>{pending ? "Loading match archive…" : "No matches fit those filters."}</strong>
            <span>{pending ? "Pulling your completed matches and evidence." : "Clear a filter to return to the full archive."}</span>
          </div>
        ) : filtered.map((match) => (
          <button className="matches-ledger__row" type="button" key={match.id} onClick={() => onMatch(match.id)}>
            <span className={`result-badge result-badge--${match.outcome.toLowerCase()}`}>{match.outcome}</span>
            <span className="matches-ledger__identity">
              <strong>{match.map}</strong>
              <small>{match.mode === "deathmatch" ? "Deathmatch" : "Competitive"}</small>
            </span>
            <span><small>Score</small><strong>{match.score}</strong></span>
            <span><small>K–D</small><strong>{match.kills}–{match.deaths}</strong></span>
            <span><small>ADR</small><strong>{match.adr}</strong></span>
            <span className={match.ratingDelta >= 0 ? "color-positive" : "color-negative"}>
              <small>Elo</small><strong>{match.ratingDelta > 0 ? "+" : ""}{match.ratingDelta}</strong>
            </span>
            <span className="matches-ledger__date"><CalendarDays size={13} /> {formatDate(match.playedAt)}</span>
            <span className="matches-ledger__demo" title={match.hasDemo ? "Demo available" : "Demo pending"}>
              {match.hasDemo && <FileCheck2 size={15} />}
            </span>
          </button>
        ))}
      </div>
      {total !== undefined && matches.length < total && onLoadMore && (
        <div className="matches-load-more">
          <button className="btn btn--secondary" type="button" disabled={pending} onClick={onLoadMore}>
            {pending ? "Loading matches…" : `Load more · ${total - matches.length} remaining`}
          </button>
        </div>
      )}
    </section>
  );
}
