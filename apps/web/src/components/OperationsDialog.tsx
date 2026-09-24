import type {
  AntiCheatSignal,
  AuditEntry,
  MatchRecoveryAction,
  MatchRecoveryIncident,
  PlatformControls,
  PlayerReport,
  SanctionAppeal,
  SanctionType
} from "@aftertick/contracts";
import { AlertTriangle, Check, Download, Gavel, RefreshCw, Shield } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { DetailDialog } from "./DetailDialog.js";

type Tab = "reports" | "signals" | "appeals" | "recovery" | "controls" | "audit";

interface OperationsDialogProps {
  role: "moderator" | "admin";
  onClose: () => void;
  onControlsChanged: (controls: PlatformControls) => void;
}

function ReportReview({ report, onChanged }: { report: PlayerReport; onChanged: () => Promise<void> }) {
  const [resolution, setResolution] = useState("");
  const [sanctionType, setSanctionType] = useState<SanctionType>("cooldown");
  const [duration, setDuration] = useState(30);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Moderation action failed.");
    } finally {
      setPending(false);
    }
  };

  const timed = sanctionType === "cooldown" || sanctionType === "temp_ban";
  return (
    <article className="ops-card">
      <header>
        <div><strong>{report.reportedDisplayName}</strong><span>{report.category.replaceAll("_", " ")}</span></div>
        <span>{report.matchId.slice(0, 8)}</span>
      </header>
      <p>{report.description ?? "No player description supplied."}</p>
      <label>
        Moderator finding
        <textarea rows={3} value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="Record the evidence and decision." />
      </label>
      <div className="ops-sanction-row">
        <select value={sanctionType} onChange={(event) => setSanctionType(event.target.value as SanctionType)} aria-label="Sanction type">
          <option value="warning">Warning</option>
          <option value="cooldown">Queue cooldown</option>
          <option value="temp_ban">Temporary ban</option>
          <option value="perm_ban">Permanent ban</option>
        </select>
        {timed && (
          <label>Minutes<input type="number" min={1} max={525600} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="ops-card-actions">
        {report.status === "pending" && (
          <button className="btn btn--secondary" type="button" disabled={pending} onClick={() => void run(() => api.reviewReport(report.id, "under_review", null))}>
            Start review
          </button>
        )}
        <button className="btn btn--secondary" type="button" disabled={pending || resolution.trim().length < 3} onClick={() => void run(() => api.reviewReport(report.id, "dismissed", resolution.trim()))}>
          Dismiss
        </button>
        <button className="btn btn--danger" type="button" disabled={pending || resolution.trim().length < 3 || (timed && duration < 1)} onClick={() => void run(async () => {
          await api.createSanction({
            playerId: report.reportedId,
            sanctionType,
            reason: resolution.trim(),
            durationMinutes: timed ? duration : null,
            reportId: report.id,
            matchId: report.matchId
          });
          await api.reviewReport(report.id, "resolved", resolution.trim());
        })}>
          <Gavel size={14} /> Resolve + sanction
        </button>
      </div>
    </article>
  );
}

function AppealReview({ appeal, onChanged }: { appeal: SanctionAppeal; onChanged: () => Promise<void> }) {
  const [resolution, setResolution] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (status: "upheld" | "overturned") => {
    setPending(true);
    setError(null);
    try {
      await api.resolveAppeal(appeal.id, status, resolution.trim(), null);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve the appeal.");
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="ops-card">
      <header><div><strong>{appeal.displayName}</strong><span>Sanction {appeal.sanctionId.slice(0, 8)}</span></div></header>
      <blockquote>{appeal.statement}</blockquote>
      <label>Appeal finding<textarea rows={3} value={resolution} onChange={(event) => setResolution(event.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="ops-card-actions">
        <button className="btn btn--secondary" type="button" disabled={pending || resolution.trim().length < 3} onClick={() => void resolve("upheld")}>Uphold</button>
        <button className="btn btn--primary" type="button" disabled={pending || resolution.trim().length < 3} onClick={() => void resolve("overturned")}><Check size={14} /> Overturn</button>
      </div>
    </article>
  );
}

function AntiCheatSignalReview({ signal }: { signal: AntiCheatSignal }) {
  return (
    <article className={`ops-card${signal.synthetic ? " ops-card--synthetic" : ""}`}>
      <header>
        <div>
          <strong>{signal.displayName}</strong>
          <span>{signal.synthetic ? "Pipeline self-test · not a detection" : `${signal.module.replace("smac_", "").replaceAll("_", " ")} · detector ${signal.detectionType}`}</span>
        </div>
        <span>{signal.synthetic ? "SYNTHETIC" : signal.matchId.slice(0, 8)}</span>
      </header>
      <p>
        {signal.synthetic
          ? "Controlled evidence-pipeline check. Never use this event in a player finding or sanction."
          : "Server-side heuristic signal only. No automatic action was taken; correlate repeated signals with the signed match timeline and GOTV before making a moderation decision."}
      </p>
      <p>
        {signal.mode === "deathmatch" ? "Deathmatch" : "Competitive"} · {signal.map} · {signal.matchStatus}
        {` · ${new Date(signal.occurredAt).toLocaleString()}`}
      </p>
      <div className="ops-card-actions">
        <a className="btn btn--secondary" href={`/api/matches/${encodeURIComponent(signal.matchId)}/demo`}>
          <Download size={14} /> Download GOTV evidence
        </a>
      </div>
    </article>
  );
}

function RecoveryReview({
  incident,
  onChanged
}: {
  incident: MatchRecoveryIncident;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState(incident.resolutionNote ?? "");
  const [pending, setPending] = useState<MatchRecoveryAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (action: MatchRecoveryAction) => {
    setPending(action);
    setError(null);
    try {
      await api.resolveMatchRecovery(incident.id, action, note.trim());
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Match recovery action failed.");
    } finally {
      setPending(null);
    }
  };
  const active = incident.status !== "resolved";
  return (
    <article className="ops-card">
      <header>
        <div>
          <strong>{incident.map} · {incident.region}</strong>
          <span>Server lease expired · {new Date(incident.detectedAt).toLocaleString()}</span>
        </div>
        <span>{incident.status} · {incident.matchId.slice(0, 8)}</span>
      </header>
      <p>
        Evidence is preserved and the failed server is quarantined. A void produces no rating change;
        a remake creates a new match, lease, credentials, and player assignment.
      </p>
      {incident.replacementAssignment && (
        <p>
          Replacement {incident.replacementMatchId?.slice(0, 8)} on <code>{incident.replacementAssignment.address}</code>
          {` · delivered to ${incident.queueReassignedPlayers}/10 players`}
        </p>
      )}
      {incident.resolutionError && <p className="form-error" role="alert">{incident.resolutionError}</p>}
      {incident.queueDeliveryError && <p className="form-error" role="alert">{incident.queueDeliveryError}</p>}
      {active ? (
        <>
          <label>
            Operator finding
            <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Record the evidence reviewed and recovery decision." />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="ops-card-actions">
            <button className="btn btn--secondary" type="button" disabled={pending !== null || note.trim().length < 3 || incident.status === "resolving"} onClick={() => void resolve("void")}>
              Void without rating
            </button>
            <button className="btn btn--danger" type="button" disabled={pending !== null || note.trim().length < 3} onClick={() => void resolve("remake")}>
              <RefreshCw size={14} /> {pending === "remake" ? "Provisioning…" : incident.status === "resolving" ? "Retry remake" : "Remake on new server"}
            </button>
          </div>
        </>
      ) : (
        <p>Resolved as <strong>{incident.resolutionAction}</strong>: {incident.resolutionNote}</p>
      )}
    </article>
  );
}

export function OperationsDialog({ role, onClose, onControlsChanged }: OperationsDialogProps) {
  const [tab, setTab] = useState<Tab>("reports");
  const [reports, setReports] = useState<PlayerReport[]>([]);
  const [signals, setSignals] = useState<AntiCheatSignal[]>([]);
  const [appeals, setAppeals] = useState<SanctionAppeal[]>([]);
  const [recovery, setRecovery] = useState<MatchRecoveryIncident[]>([]);
  const [controls, setControls] = useState<PlatformControls | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reportResult, signalResult, appealResult] = await Promise.all([
        api.moderationReports("pending"),
        api.antiCheatSignals(),
        api.moderationAppeals()
      ]);
      setReports(reportResult.reports);
      setSignals(signalResult.signals);
      setAppeals(appealResult.appeals);
      if (role === "admin") {
        const [controlResult, auditResult] = await Promise.all([
          api.adminControls(),
          api.audit()
        ]);
        setControls(controlResult);
        setAudit(auditResult.entries);
        try {
          const recoveryResult = await api.matchRecovery();
          setRecovery(recoveryResult.incidents);
        } catch (caught) {
          setRecovery([]);
          setError(caught instanceof Error
            ? `Match recovery: ${caught.message}`
            : "Match recovery data is unavailable.");
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load platform operations.");
    } finally {
      setLoading(false);
    }
  }, [role]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveControls = async () => {
    if (!controls) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateAdminControls({
        version: controls.version,
        registrationEnabled: controls.registrationEnabled,
        queueEnabled: controls.queueEnabled,
        serverAllocationEnabled: controls.serverAllocationEnabled,
        userMessage: controls.userMessage
      });
      setControls(updated);
      onControlsChanged(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update platform controls.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailDialog title="Platform operations" eyebrow={`${role} console`} onClose={onClose} wide>
      <nav className="ops-tabs" aria-label="Operations sections">
        {(["reports", "signals", "appeals", ...(role === "admin" ? ["recovery", "controls", "audit"] : [])] as Tab[]).map((item) => (
          <button type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)} key={item}>
            {item} {item === "reports" ? `(${reports.length})` : item === "signals" ? `(${signals.length})` : item === "appeals" ? `(${appeals.length})` : item === "recovery" ? `(${recovery.filter((incident) => incident.status !== "resolved").length})` : ""}
          </button>
        ))}
        <button className="ops-refresh" type="button" onClick={() => void refresh()} aria-label="Refresh operations data"><RefreshCw size={13} /></button>
      </nav>
      {error && <p className="ops-error" role="alert"><AlertTriangle size={14} /> {error}</p>}
      {loading ? <p className="detail-empty">Loading operational state…</p> : (
        <div className="ops-content">
          {tab === "reports" && (reports.length ? reports.map((report) => <ReportReview report={report} onChanged={refresh} key={report.id} />) : <p className="detail-empty">No pending reports.</p>)}
          {tab === "signals" && (signals.length ? signals.map((signal) => <AntiCheatSignalReview signal={signal} key={signal.id} />) : <p className="detail-empty">No server-side anti-cheat signals.</p>)}
          {tab === "appeals" && (appeals.length ? appeals.map((appeal) => <AppealReview appeal={appeal} onChanged={refresh} key={appeal.id} />) : <p className="detail-empty">No pending appeals.</p>)}
          {tab === "recovery" && (recovery.length ? recovery.map((incident) => <RecoveryReview incident={incident} onChanged={refresh} key={incident.id} />) : <p className="detail-empty">No game-server recovery incidents.</p>)}
          {tab === "controls" && controls && (
            <section className="controls-card">
              <h3><Shield size={15} /> Emergency controls</h3>
              <label><input type="checkbox" checked={controls.registrationEnabled} onChange={(event) => setControls({ ...controls, registrationEnabled: event.target.checked })} /> New registrations enabled</label>
              <label><input type="checkbox" checked={controls.queueEnabled} onChange={(event) => setControls({ ...controls, queueEnabled: event.target.checked })} /> New queue entries enabled</label>
              <label><input type="checkbox" checked={controls.serverAllocationEnabled} onChange={(event) => setControls({ ...controls, serverAllocationEnabled: event.target.checked })} /> New server allocations enabled</label>
              <label className="controls-message">Player-facing message<textarea rows={3} value={controls.userMessage ?? ""} onChange={(event) => setControls({ ...controls, userMessage: event.target.value.trimStart() || null })} /></label>
              <button className="btn btn--danger" type="button" disabled={saving} onClick={() => void saveControls()}>{saving ? "Saving…" : `Save controls · v${controls.version}`}</button>
            </section>
          )}
          {tab === "audit" && (
            <ol className="audit-list">
              {audit.map((entry) => <li key={entry.id}><strong>{entry.action}</strong><span>{new Date(entry.createdAt).toLocaleString()} · {entry.targetType ?? "platform"}</span><code>{JSON.stringify(entry.detail)}</code></li>)}
            </ol>
          )}
        </div>
      )}
    </DetailDialog>
  );
}
