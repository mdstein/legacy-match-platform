import { Check, KeyRound, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";

interface LauncherAuthorizationDialogProps {
  userCode: string;
  pending: boolean;
  approved: boolean;
  error: string | null;
  onApprove: () => void;
  onClose: () => void;
}

export function LauncherAuthorizationDialog({
  userCode,
  pending,
  approved,
  error,
  onApprove,
  onClose
}: LauncherAuthorizationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const validCode = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(userCode);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="launcher-auth-dialog"
      aria-labelledby="launcher-auth-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="launcher-auth-inner">
        <div className="launcher-auth-heading">
          <span className="launcher-auth-mark" aria-hidden="true">
            {approved ? <ShieldCheck size={21} /> : <KeyRound size={21} />}
          </span>
          <div>
            <h2 id="launcher-auth-title">
              {approved ? "Launcher connected" : "Connect this launcher"}
            </h2>
            <p>
              {approved
                ? "The launcher can now open B2G and use your account without keeping this browser open."
                : "Approve only when this code exactly matches the B2G Launcher window on your PC."}
            </p>
          </div>
          <button
            className="detail-close"
            type="button"
            aria-label="Close launcher authorization"
            onClick={onClose}
            disabled={pending}
          >
            <X size={16} />
          </button>
        </div>

        <div className="launcher-auth-code" aria-label={`Launcher code ${userCode}`}>
          {userCode}
        </div>

        <div className="launcher-auth-scope">
          <strong>{approved ? "Pairing complete" : "What this permits"}</strong>
          <p>
            {approved
              ? "Return to the launcher to finish setup or play. You can close this page."
              : "The launcher may read your B2G status and operate queues, ready checks, and game connections. It cannot access your Steam password."}
          </p>
        </div>

        {error && <p className="launcher-auth-error" role="alert">{error}</p>}

        <div className="launcher-auth-actions">
          <button
            className="btn btn--secondary"
            type="button"
            onClick={onClose}
            disabled={pending}
          >
            {approved ? "Close" : "Cancel"}
          </button>
          {!approved && (
            <button
              className="btn btn--primary"
              type="button"
              onClick={onApprove}
              disabled={pending || !validCode}
              autoFocus
            >
              <Check size={16} />
              {pending ? "Connecting…" : "Connect Launcher"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
