import type { ReadyCheck } from "@aftertick/contracts";
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hasPlayerAccepted } from "../app-state.js";

interface ReadyCheckDialogProps {
  readyCheck: ReadyCheck;
  playerId: string;
  accepting: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export function ReadyCheckDialog({
  readyCheck,
  playerId,
  accepting,
  onAccept,
  onDecline
}: ReadyCheckDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(
      0,
      Math.ceil(
        (new Date(readyCheck.expiresAt).getTime() - Date.now()) / 1000
      )
    )
  );
  const accepted = hasPlayerAccepted(readyCheck, playerId);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsLeft(
        Math.max(
          0,
          Math.ceil(
            (new Date(readyCheck.expiresAt).getTime() - Date.now()) / 1000
          )
        )
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, [readyCheck.expiresAt]);

  return (
    <dialog
      ref={dialogRef}
      className="ready-dialog"
      aria-labelledby="ready-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!accepting) onDecline();
      }}
    >
      <div className="ready-inner">
        <div className="ready-top">
          <span className="ready-badge">Match found</span>
          <span className="ready-match-id">
            {readyCheck.matchId.slice(0, 8)}
          </span>
        </div>

        <div className="ready-heading">
          <div>
            <h2 id="ready-title">Confirm your slot</h2>
            <p>
              All ten players must accept before the server address is released.
            </p>
          </div>
          <div
            className="countdown"
            aria-live="polite"
            aria-label={`${secondsLeft} seconds remaining`}
          >
            <strong>{String(secondsLeft).padStart(2, "0")}</strong>
            <span>sec</span>
          </div>
        </div>

        <dl className="ready-info">
          <div>
            <dt>Region</dt>
            <dd>{readyCheck.region}</dd>
          </div>
          <div>
            <dt>Map pool</dt>
            <dd>{readyCheck.mapPool.length} shared</dd>
          </div>
          <div>
            <dt>Accepted</dt>
            <dd>
              {readyCheck.acceptedPlayerIds.length}/{readyCheck.totalPlayers}
            </dd>
          </div>
        </dl>

        <ol className="accept-row" aria-label="Player confirmations">
          {Array.from({ length: readyCheck.totalPlayers }, (_, i) => {
            const isReady = i < readyCheck.acceptedPlayerIds.length;
            return (
              <li
                className={`accept-slot ${isReady ? "is-ready" : ""}`}
                key={i}
                aria-label={`Player ${i + 1}: ${isReady ? "accepted" : "waiting"}`}
              >
                {isReady ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </li>
            );
          })}
        </ol>
        <p className="ready-status-text">
          {accepted
            ? "Your slot is confirmed. Waiting for remaining players."
            : "Accepting commits you to this match."}
        </p>

        <div className="ready-actions">
          <button
            className="btn btn--danger"
            type="button"
            onClick={onDecline}
            disabled={accepting}
          >
            <X size={15} /> Decline
          </button>
          <button
            className="btn btn--primary"
            type="button"
            disabled={accepting || accepted || secondsLeft === 0}
            onClick={onAccept}
            autoFocus
          >
            <Check size={16} />
            {accepting
              ? "Confirming…"
              : accepted
                ? "Confirmed"
                : secondsLeft === 0
                  ? "Expired"
                  : "Accept Match"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
