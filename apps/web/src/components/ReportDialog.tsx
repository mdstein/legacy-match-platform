import type { ReportCategory } from "@aftertick/contracts";
import { Flag } from "lucide-react";
import { type FormEvent, useState } from "react";
import { DetailDialog } from "./DetailDialog.js";

const CATEGORIES: Array<{ value: ReportCategory; label: string }> = [
  { value: "griefing", label: "Griefing or match disruption" },
  { value: "toxicity", label: "Toxic or abusive communication" },
  { value: "smurfing", label: "Smurfing or account misuse" },
  { value: "cheating", label: "Suspicious gameplay" },
  { value: "platform_abuse", label: "Platform abuse" }
];

interface ReportDialogProps {
  displayName: string;
  onClose: () => void;
  onSubmit: (category: ReportCategory, description: string | null) => Promise<void>;
}

export function ReportDialog({ displayName, onClose, onSubmit }: ReportDialogProps) {
  const [category, setCategory] = useState<ReportCategory>("griefing");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(category, description.trim() || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit the report.");
      setPending(false);
    }
  };

  return (
    <DetailDialog title={`Report ${displayName}`} eyebrow="Match-specific player report" onClose={onClose}>
      <form className="report-form" onSubmit={(event) => void submit(event)}>
        <p>
          This report is tied to the match roster, event journal, and canonical GOTV evidence.
          A moderator will review the surrounding context.
        </p>
        <label>
          Category
          <select value={category} onChange={(event) => setCategory(event.target.value as ReportCategory)}>
            {CATEGORIES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>
          What happened? <span>Optional</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
            rows={5}
            placeholder="Include rounds, timing, or behavior that helps a moderator locate the evidence."
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="report-actions">
          <button className="btn btn--secondary" type="button" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="btn btn--primary" type="submit" disabled={pending}>
            <Flag size={14} /> {pending ? "Submitting…" : "Submit report"}
          </button>
        </div>
      </form>
    </DetailDialog>
  );
}
