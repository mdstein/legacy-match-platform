import type { MapVetoState } from "@aftertick/contracts";
import { Ban, Check, LoaderCircle, Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface MapVetoDialogProps {
  veto: MapVetoState;
  playerId: string;
  pending: boolean;
  onBan: (map: string) => void;
}

function secondsRemaining(expiresAt: string | null): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function MapVetoDialog({ veto, playerId, pending, onBan }: MapVetoDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [secondsLeft, setSecondsLeft] = useState(() => secondsRemaining(veto.expiresAt));
  const actingCaptainId = veto.captains[veto.actingTeam];
  const isActingCaptain = actingCaptainId === playerId && veto.status === "active";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    setSecondsLeft(secondsRemaining(veto.expiresAt));
    if (!veto.expiresAt) return;
    const timer = window.setInterval(
      () => setSecondsLeft(secondsRemaining(veto.expiresAt)),
      250
    );
    return () => window.clearInterval(timer);
  }, [veto.expiresAt]);

  return (
    <dialog
      ref={dialogRef}
      className="veto-dialog"
      aria-labelledby="veto-title"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="veto-inner">
        <div className="veto-topline">
          <span className="ready-badge"><Shield size={13} /> Captain veto</span>
          <span className="ready-match-id">{veto.matchId.slice(0, 8)}</span>
        </div>

        <div className="veto-heading">
          <div>
            <h2 id="veto-title">
              {veto.status === "allocating" ? "Preparing your server" : "Ban one map"}
            </h2>
            <p>
              {veto.status === "allocating"
                ? `${veto.selectedMap} survived the veto. A signed server manifest is being allocated in ${veto.region}.`
                : isActingCaptain
                  ? `You are the ${veto.actingTeam} captain. Remove one map from the shared pool.`
                  : `Waiting for the ${veto.actingTeam} captain (${actingCaptainId.slice(0, 8)}).`}
            </p>
          </div>
          {veto.status === "active" ? (
            <div
              className="countdown"
              aria-live="polite"
              aria-label={`${secondsLeft} seconds remaining in this veto turn`}
            >
              <strong>{String(secondsLeft).padStart(2, "0")}</strong>
              <span>sec</span>
            </div>
          ) : (
            <LoaderCircle className="veto-spinner spin" size={30} aria-label="Allocating server" />
          )}
        </div>

        <div className="veto-captains" aria-label="Team captains">
          {(["alpha", "bravo"] as const).map((team) => (
            <div className={veto.actingTeam === team && veto.status === "active" ? "is-acting" : ""} key={team}>
              <span>{team}</span>
              <strong>{veto.captains[team].slice(0, 8)}</strong>
            </div>
          ))}
        </div>

        <div className="veto-map-grid" aria-label="Maps remaining in veto">
          {veto.remainingMaps.map((map) => (
            <button
              type="button"
              className={veto.selectedMap === map ? "is-selected" : ""}
              disabled={!isActingCaptain || pending || veto.remainingMaps.length <= 1}
              onClick={() => onBan(map)}
              key={map}
            >
              {veto.selectedMap === map ? <Check size={15} /> : <Ban size={15} />}
              <strong>{map}</strong>
              <small>{veto.selectedMap === map ? "selected" : isActingCaptain ? "ban" : "available"}</small>
            </button>
          ))}
        </div>

        <ol className="veto-history" aria-label="Completed map bans">
          {veto.bans.length === 0 ? (
            <li>No maps banned yet.</li>
          ) : veto.bans.map((ban) => (
            <li key={ban.sequence}>
              <span>{String(ban.sequence).padStart(2, "0")}</span>
              <strong>{ban.map}</strong>
              <small>{ban.team}{ban.automated ? " · timeout" : ""}</small>
            </li>
          ))}
        </ol>

        <p className="veto-note" role="status">
          {pending
            ? "Recording ban…"
            : veto.status === "allocating"
              ? "Your assignment will appear automatically when the regional node accepts the fenced lease."
              : secondsLeft === 0
                ? "Turn expired; the service will apply the deterministic timeout ban."
                : "Turns alternate between captains. Expired turns ban the lowest-priority remaining map automatically."}
        </p>
      </div>
    </dialog>
  );
}
