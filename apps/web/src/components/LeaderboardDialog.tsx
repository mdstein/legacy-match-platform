import type { LeaderboardEntry } from "@aftertick/contracts";
import { DetailDialog } from "./DetailDialog.js";
import { RankIcon } from "./RankIcon.js";

interface LeaderboardDialogProps {
  entries: LeaderboardEntry[];
  region: string;
  onClose: () => void;
  onPlayer: (playerId: string) => void;
}

export function LeaderboardDialog({ entries, region, onClose, onPlayer }: LeaderboardDialogProps) {
  return (
    <DetailDialog title="Leaderboard" eyebrow={`${region} · current season`} onClose={onClose} wide>
      {entries.length === 0 ? (
        <p className="detail-empty">No rated players are listed in this region yet.</p>
      ) : (
        <div className="leaderboard-table" role="table" aria-label={`${region} leaderboard`}>
          <div className="leaderboard-head" role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">Player</span>
            <span role="columnheader">Rank</span>
            <span role="columnheader">Matches</span>
            <span role="columnheader">Win rate</span>
            <span role="columnheader">Elo</span>
          </div>
          {entries.map((entry) => (
            <button
              className="leaderboard-row"
              type="button"
              role="row"
              key={entry.playerId}
              onClick={() => onPlayer(entry.playerId)}
            >
              <span className="leaderboard-position" role="cell">{entry.position}</span>
              <span className="leaderboard-player" role="cell">{entry.displayName}<small>{entry.region}</small></span>
              <span className="leaderboard-rank" role="cell"><RankIcon rank={entry.rank} size="sm" />{entry.rank}</span>
              <span role="cell">{entry.matchesPlayed}</span>
              <span role="cell">{entry.winRate}%</span>
              <strong role="cell">{entry.rating.toLocaleString()}</strong>
            </button>
          ))}
        </div>
      )}
    </DetailDialog>
  );
}
