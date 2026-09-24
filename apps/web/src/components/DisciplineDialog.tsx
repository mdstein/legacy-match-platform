import type { PlayerSanction } from "@aftertick/contracts";
import { Scale } from "lucide-react";
import { useState } from "react";
import { api } from "../api.js";
import { DetailDialog } from "./DetailDialog.js";

function SanctionCard({ sanction, onAppealed }: { sanction: PlayerSanction; onAppealed: () => void }) {
  const [statement, setStatement] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const appeal = async () => {
    setPending(true);
    setError(null);
    try {
      await api.appealSanction(sanction.id, statement.trim());
      setSubmitted(true);
      onAppealed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit this appeal.");
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="discipline-card">
      <header>
        <div><strong>{sanction.sanctionType.replaceAll("_", " ")}</strong><span>{sanction.isActive ? "Active" : "Expired or inactive"}</span></div>
        <time>{new Date(sanction.startsAt).toLocaleDateString()}</time>
      </header>
      <p>{sanction.reason}</p>
      {sanction.endsAt && <small>Ends {new Date(sanction.endsAt).toLocaleString()}</small>}
      {sanction.isActive && !submitted && (
        <div className="appeal-form">
          <label>Appeal statement<textarea rows={4} minLength={10} maxLength={4000} value={statement} onChange={(event) => setStatement(event.target.value)} placeholder="Explain specifically why the decision or evidence should be reviewed." /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn--secondary" type="button" disabled={pending || statement.trim().length < 10} onClick={() => void appeal()}>
            <Scale size={14} /> {pending ? "Submitting…" : "Submit appeal"}
          </button>
        </div>
      )}
      {submitted && <p className="appeal-submitted" role="status">Appeal submitted for moderator review.</p>}
    </article>
  );
}

export function DisciplineDialog({ sanctions, onClose }: { sanctions: PlayerSanction[]; onClose: () => void }) {
  const [, refreshMarker] = useState(0);
  return (
    <DetailDialog title="Account standing" eyebrow="Sanctions and appeals" onClose={onClose}>
      {sanctions.length === 0 ? (
        <p className="detail-empty">This account has no sanctions.</p>
      ) : (
        <div className="discipline-list">
          {sanctions.map((sanction) => <SanctionCard sanction={sanction} onAppealed={() => refreshMarker((value) => value + 1)} key={sanction.id} />)}
        </div>
      )}
    </DetailDialog>
  );
}
