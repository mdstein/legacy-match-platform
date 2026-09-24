import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "./BrandMark.js";

interface OnboardingDialogProps {
  defaultRegion: string;
  pending: boolean;
  error: string | null;
  onComplete: (displayName: string, region: string) => void;
}

const REGIONS = ["NA Central", "NA East", "NA West", "EU Central"];

export function OnboardingDialog({ defaultRegion, pending, error, onComplete }: OnboardingDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [region, setRegion] = useState(defaultRegion);
  const valid = /^[A-Za-z0-9_-]{3,20}$/.test(displayName);

  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <BrandMark />
        <h1 id="onboarding-title">Choose the name on your match sheet.</h1>
        <p>This one-time setup keeps your Steam account linked privately. Other players will know you by this in-game name.</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (valid) onComplete(displayName, region);
        }}>
          <label className="field-stack">
            <span>In-game name</span>
            <input
              autoFocus
              name="display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20))}
              placeholder="fragname"
              minLength={3}
              maxLength={20}
              autoComplete="nickname"
            />
            <small className={valid ? "is-valid" : ""}>
              <CheckCircle2 size={12} /> 3–20 letters, numbers, underscores, or hyphens
            </small>
          </label>
          <label className="field-stack">
            <span>Home region</span>
            <select name="home-region" value={region} onChange={(event) => setRegion(event.target.value)}>
              {REGIONS.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <div className="onboarding-policy">
            <strong>Your first name is free.</strong>
            <span>After launch, changes will cost $2 to discourage impersonation and churn.</span>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn--primary onboarding-submit" type="submit" disabled={!valid || pending}>
            {pending ? "Saving…" : "Enter B2G"} <ArrowRight size={15} />
          </button>
        </form>
      </section>
    </div>
  );
}
