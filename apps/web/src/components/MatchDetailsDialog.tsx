import type { MatchDetails, MatchPlayerDetails } from "@aftertick/contracts";
import { Check, Copy, Download, FileCheck2, Flag } from "lucide-react";
import { useState } from "react";
import { DetailDialog } from "./DetailDialog.js";

interface MatchDetailsDialogProps {
  match: MatchDetails;
  onClose: () => void;
  onPlayer: (playerId: string) => void;
  currentPlayerId: string;
  onReport: (player: MatchPlayerDetails) => void;
}

function formatDate(value: string | null): string {
  if (!value) return "Pending";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function TeamTable({
  name,
  players,
  score,
  onPlayer,
  currentPlayerId,
  onReport,
  unrated = false
}: {
  name: string;
  players: MatchPlayerDetails[];
  score: number | null;
  onPlayer: (playerId: string) => void;
  currentPlayerId: string;
  onReport: (player: MatchPlayerDetails) => void;
  unrated?: boolean;
}) {
  return (
    <section className="team-card">
      <header><h3>{name}</h3><strong>{score ?? "–"}</strong></header>
      <div className="team-table" role="table" aria-label={`${name} statistics`}>
        <div className="team-head" role="row">
          <span role="columnheader">Player</span><span role="columnheader">K</span>
          <span role="columnheader">D</span><span role="columnheader">A</span>
          <span role="columnheader">ADR</span><span role="columnheader">KAST</span>
          <span role="columnheader">{unrated ? "Rating" : "Elo"}</span><span role="columnheader" className="sr-only">Actions</span>
        </div>
        {players.map((player) => (
          <div className="team-row" role="row" key={player.playerId}>
            <span className="team-player-cell" role="cell">
              <button className="team-player" type="button" onClick={() => onPlayer(player.playerId)}>{player.displayName}</button>
            </span>
            <span role="cell">{player.kills}</span><span role="cell">{player.deaths}</span>
            <span role="cell">{player.assists}</span><span role="cell">{player.adr}</span>
            <span role="cell">{player.kast}%</span>
            <strong className={player.ratingDelta >= 0 ? "color-positive" : "color-negative"} role="cell">
              {unrated ? "—" : <>{player.ratingDelta > 0 ? "+" : ""}{player.ratingDelta}</>}
            </strong>
            <span className="team-action-cell" role="cell">
              {player.playerId !== currentPlayerId && (
                <button className="team-report" type="button" onClick={() => onReport(player)} aria-label={`Report ${player.displayName}`}>
                  <Flag size={12} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function MatchDetailsDialog({ match, onClose, onPlayer, currentPlayerId, onReport }: MatchDetailsDialogProps) {
  const [copiedHash, setCopiedHash] = useState(false);
  const deathmatch = match.mode === "deathmatch";

  return (
    <DetailDialog title={deathmatch
      ? `${match.map} · ${match.score.alpha ?? "–"} top frags`
      : `${match.map} · ${match.score.alpha ?? "–"}–${match.score.bravo ?? "–"}`}
      eyebrow={`${deathmatch ? "Deathmatch" : "Competitive"} · ${match.status} · ${match.region}`} onClose={onClose} wide>
      <div className="match-meta">
        <span>Played {formatDate(match.endedAt ?? match.startedAt)}</span>
        <span>Ruleset {match.rulesetVersion}</span>
        <span>ID {match.id.slice(0, 8)}</span>
      </div>

      {deathmatch ? (
        <div className="team-grid team-grid--ffa">
          <TeamTable name="FFA standings" players={match.teams.ffa ?? []} score={match.score.alpha}
            onPlayer={onPlayer} currentPlayerId={currentPlayerId} onReport={onReport} unrated />
        </div>
      ) : (
        <div className="team-grid">
          <TeamTable name="Alpha" players={match.teams.alpha} score={match.score.alpha} onPlayer={onPlayer} currentPlayerId={currentPlayerId} onReport={onReport} />
          <TeamTable name="Bravo" players={match.teams.bravo} score={match.score.bravo} onPlayer={onPlayer} currentPlayerId={currentPlayerId} onReport={onReport} />
        </div>
      )}

      <section className="demo-card" aria-labelledby="demo-title">
        <div>
          <FileCheck2 size={18} />
          <div>
            <h3 id="demo-title">GOTV evidence</h3>
            {match.demo ? (
              <div className="demo-meta-row">
                <p>{match.demo.analysisStatus} · {(match.demo.sizeBytes / 1_048_576).toFixed(1)} MB · SHA-256 {match.demo.checksum.slice(0, 12)}…</p>
                <button
                  type="button"
                  className="demo-checksum-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(match.demo!.checksum);
                    setCopiedHash(true);
                    setTimeout(() => setCopiedHash(false), 2000);
                  }}
                  title="Copy full SHA-256 checksum"
                  aria-label="Copy demo checksum"
                >
                  {copiedHash ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            ) : <p>No canonical demo has been uploaded.</p>}
          </div>
        </div>
        {match.demo?.available && match.demo.downloadUrl && (
          <a className="btn btn--secondary" href={match.demo.downloadUrl} download>
            <Download size={15} /> Download demo
          </a>
        )}
        {match.demo?.analysisStatus === "deleted" && (
          <p className="detail-dialog__retention-note">Demo bytes were removed under the retention policy; checksum evidence remains.</p>
        )}
        {match.demo && match.demo.warnings.length > 0 && (
          <ul className="demo-warnings" aria-label="Analysis warnings">
            {match.demo.warnings.map((warning) => <li key={warning}>{warning.replaceAll("_", " ")}</li>)}
          </ul>
        )}
      </section>
    </DetailDialog>
  );
}
