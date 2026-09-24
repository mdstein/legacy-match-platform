import type { GameMode, LatencyProbeStatus, MatchAssignment, QueueState } from "@aftertick/contracts";
import {
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  Crosshair,
  ExternalLink,
  Gamepad2,
  Gauge,
  HelpCircle,
  LoaderCircle,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Swords,
  Timer,
  X
} from "lucide-react";
import { useState } from "react";

const MAPS = ["Mirage", "Inferno", "Nuke", "Overpass", "Vertigo", "Ancient", "Anubis"];
const REGIONS = ["NA Central", "NA East", "NA West", "EU Central"];
const MAP_PLATES: Partial<Record<string, string>> = {
  Mirage: "/plates/map-mirage.png",
  Inferno: "/plates/map-inferno.png",
  Nuke: "/plates/map-nuke.png",
  Overpass: "/plates/map-overpass.png",
  Vertigo: "/plates/map-vertigo.png",
  Ancient: "/plates/map-ancient.png",
  Anubis: "/plates/map-anubis.png"
};

interface QueuePanelProps {
  queue: QueueState;
  assignment: MatchAssignment | null;
  selectedMaps: string[];
  selectedRegions: string[];
  selectedMode: GameMode;
  searching: boolean;
  queueElapsed: string;
  ratingWindow: number;
  requestPending: boolean;
  latencyProbes: LatencyProbeStatus | null;
  probePending: boolean;
  probeHandoffSlow: boolean;
  probeLauncherUrl: string | null;
  error: string | null;
  queueDisabled: boolean;
  platformMessage: string | null;
  competitiveQueuePlayers: number;
  deathmatchHumans: number;
  deathmatchBots: number;
  deathmatchCapacity: number;
  onToggleMap: (map: string) => void;
  onSelectAllMaps?: (select: boolean) => void;
  onRegionChange: (region: string) => void;
  onModeChange: (mode: GameMode) => void;
  onQueueAction: () => void;
  onMeasureLatency: () => void;
  onRetryLauncher: () => void;
  onOpenLauncherGuide?: () => void;
  onReset: () => void;
}

export function QueuePanel({
  queue,
  assignment,
  selectedMaps,
  selectedRegions,
  selectedMode,
  searching,
  queueElapsed,
  ratingWindow,
  requestPending,
  latencyProbes,
  probePending,
  probeHandoffSlow,
  probeLauncherUrl,
  error,
  queueDisabled,
  platformMessage,
  competitiveQueuePlayers,
  deathmatchHumans,
  deathmatchBots,
  deathmatchCapacity,
  onToggleMap,
  onSelectAllMaps,
  onRegionChange,
  onModeChange,
  onQueueAction,
  onMeasureLatency,
  onRetryLauncher,
  onOpenLauncherGuide,
  onReset
}: QueuePanelProps) {
  const [copiedConsole, setCopiedConsole] = useState(false);

  const availableRegions = latencyProbes?.enabled
    ? REGIONS.filter((region) => latencyProbes.regions.includes(region))
    : REGIONS;
  const selectedMeasurement = latencyProbes?.measurements.find((measurement) =>
    measurement.region === selectedRegions[0]
  );
  const measurementFresh = selectedMeasurement?.validUntil !== undefined
    && new Date(selectedMeasurement.validUntil).getTime() > Date.now()
    && selectedMeasurement.successfulSamples >= 3
    && selectedMeasurement.packetLossPercent <= 40
    && selectedMeasurement.p95Ms !== null;
  const measurementRequired = latencyProbes?.enabled === true;
  const matchCommitted = queue.phase === "map-veto";
  const panelClass = [
    "queue-panel",
    searching && "queue-panel--searching",
    queue.phase === "ready-check" && "queue-panel--ready-check"
  ]
    .filter(Boolean)
    .join(" ");

  if (assignment) {
    const serverPassword = assignment.connectUrl.split("/").pop() ?? "";
    const consoleConnectCmd = serverPassword && serverPassword !== assignment.address
      ? `password ${serverPassword}; connect ${assignment.address}`
      : `connect ${assignment.address}`;

    return (
      <section id="queue" className="queue-panel" tabIndex={-1}>
        <div className="assignment">
          <div className="assignment-map">
            <span className="assignment-map-label">Map</span>
            <strong className="assignment-map-name">{assignment.map}</strong>
            <span className="assignment-map-region">{assignment.region}</span>
          </div>
          <div className="assignment-details">
            <div className="assignment-header-row">
              <h3 className="assignment-server">{assignment.serverLabel}</h3>
              <span className="assignment-badge-live">
                {assignment.mode === "deathmatch"
                  ? <><Bot size={13} /> Bots fill open slots</>
                  : <><ShieldCheck size={13} /> 128 Tick Ready</>}
              </span>
            </div>
            <dl className="assignment-dl">
              <div className="assignment-dl-row">
                <dt>Address</dt><dd>{assignment.address}</dd>
              </div>
              <div className="assignment-dl-row">
                <dt>Match ID</dt><dd>{assignment.matchId.slice(0, 8)}</dd>
              </div>
              <div className="assignment-dl-row">
                <dt>Ruleset</dt><dd>{assignment.mode === "deathmatch" ? "FFA / first to 40 / 10 min" : "MR15 / 128 tick"}</dd>
              </div>
              {assignment.mode === "deathmatch" && (
                <div className="assignment-dl-row">
                  <dt>Live population</dt>
                  <dd>{deathmatchHumans} human{deathmatchHumans === 1 ? "" : "s"} · {deathmatchBots} bots</dd>
                </div>
              )}
            </dl>
            <div className="assignment-actions">
              <a className="btn btn--primary" href={assignment.launcherUrl}>
                <Gamepad2 size={16} /> Open launcher <ExternalLink size={13} />
              </a>
              <button
                type="button"
                className="btn btn--secondary assignment-copy-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(consoleConnectCmd);
                  setCopiedConsole(true);
                  setTimeout(() => setCopiedConsole(false), 2000);
                }}
                title="Copy connect IP and password for CS:GO console"
              >
                {copiedConsole ? <Check size={14} /> : <Copy size={14} />}
                <span>{copiedConsole ? "Command copied!" : "Copy console connect"}</span>
              </button>
              <a className="btn btn--secondary" href="steam://rungameid/4465480">
                <ExternalLink size={14} /> Open CS:GO manually
              </a>
              <button className="btn btn--secondary" type="button" onClick={onReset}>
                <RotateCcw size={14} /> Reset demo
              </button>
            </div>
            <div className="assignment-footer-notes">
              <p className="assignment-note">
                The launcher verifies the legacy client before handing this one-match credential to Steam. If the
                handoff fails, open CS:GO manually and paste the copied command into its console.
              </p>
              {onOpenLauncherGuide && (
                <button
                  type="button"
                  className="assignment-help-btn"
                  onClick={onOpenLauncherGuide}
                >
                  <HelpCircle size={13} /> Setup help
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="queue" className={panelClass} tabIndex={-1}>
      <div className="queue-body">
        <div className="mode-select" role="radiogroup" aria-label="Game mode">
          <button
            className={selectedMode === "competitive" ? "is-selected" : ""}
            type="button"
            role="radio"
            aria-checked={selectedMode === "competitive"}
            disabled={queue.phase !== "idle"}
            onClick={() => onModeChange("competitive")}
          >
            <span className="mode-select__icon"><Swords size={18} /></span>
            <span><strong>Competitive</strong><small>Ranked 5v5 · MR15 · map veto</small></span>
          </button>
          <button
            className={selectedMode === "deathmatch" ? "is-selected" : ""}
            type="button"
            role="radio"
            aria-checked={selectedMode === "deathmatch"}
            disabled={queue.phase !== "idle"}
            onClick={() => onModeChange("deathmatch")}
          >
            <span className="mode-select__icon"><Crosshair size={18} /></span>
            <span><strong>Deathmatch</strong><small>Drop-in FFA · bots backfill to 14</small></span>
          </button>
        </div>
        {selectedMode === "deathmatch" && (
          <div className="dm-rules" aria-label="Deathmatch rules">
            <span><Crosshair size={14} /><strong>40</strong> kills to win</span>
            <span><Timer size={14} /><strong>10:00</strong> hard limit</span>
            <span><Radio size={14} />Random eligible map</span>
            <span><ShieldCheck size={14} />Unrated warm-up</span>
            <span className="dm-rules__population"><Bot size={14} />
              {deathmatchCapacity === 0
                ? "Server starts when you queue"
                : deathmatchHumans > 0
                  ? `${deathmatchHumans} humans · ${deathmatchBots} bots live`
                  : `${deathmatchCapacity} human slots ready`}
            </span>
          </div>
        )}
        {queueDisabled && queue.phase === "idle" && (
          <div className="maintenance-notice" role="status">
            <strong>Matchmaking paused</strong>
            <span>{platformMessage ?? "New queue entries are temporarily disabled by platform operations."}</span>
          </div>
        )}
        {/* Search stats — only visible when actively searching */}
        {searching && (
          <div className="queue-facts" aria-live="polite">
            <div className="queue-fact">
              <span className="queue-fact-label">Elapsed</span>
              <span className="queue-fact-value">{queueElapsed}</span>
            </div>
            <div className="queue-fact">
              <span className="queue-fact-label">{selectedMode === "deathmatch" ? "Win target" : "Elo range"}</span>
              <span className="queue-fact-value">{selectedMode === "deathmatch" ? "40 kills" : `±${ratingWindow}`}</span>
            </div>
            <div className="queue-fact">
              <span className="queue-fact-label">{selectedMode === "deathmatch" ? "Mode" : "Queue"}</span>
              <span className="queue-fact-value">{selectedMode === "deathmatch" ? "Free for all" : `${competitiveQueuePlayers} waiting`}</span>
            </div>
            <div className="queue-fact">
              <span className="queue-fact-label">Tick</span>
              <span className="queue-fact-value">128</span>
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onQueueAction();
          }}
        >
          <div className="queue-config-grid">
            <label className="queue-config-field" htmlFor="region-select">
              <span>Region</span>
              <select
                id="region-select"
                name="region"
                className="region-select"
                value={selectedRegions[0]}
                disabled={queue.phase !== "idle" || probePending}
                onChange={(e) => onRegionChange(e.target.value)}
              >
                {availableRegions.map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
            <div className="queue-config-field" aria-label="Selected game mode">
              <span>Game mode</span>
              <strong>{selectedMode === "deathmatch" ? "Deathmatch FFA" : "Competitive 5v5"}</strong>
            </div>
            <div className="queue-config-field" aria-label="Server tick rate">
              <span>Tick rate</span>
              <strong>128 tick</strong>
            </div>
          </div>

          {measurementRequired && (
            <div
              className={`route-measurement${probeHandoffSlow ? " route-measurement--attention" : ""}`}
              aria-live="polite"
            >
              <div className="route-measurement-copy">
                <span className="route-measurement-icon" aria-hidden="true">
                  {probeHandoffSlow
                    ? <CircleAlert size={16} />
                    : probePending
                    ? <LoaderCircle className="spin" size={16} />
                    : measurementFresh
                      ? <CheckCircle2 size={16} />
                      : <Gauge size={16} />}
                </span>
                <div>
                  <strong>{probeHandoffSlow
                    ? "Launcher hasn’t responded"
                    : probePending
                    ? "Measuring route…"
                    : measurementFresh
                      ? `${selectedMeasurement.p95Ms!.toFixed(1)} ms p95`
                      : "Route check required"}</strong>
                  <small>{probeHandoffSlow
                    ? "Run the downloaded launcher once to install b2g://, then open it again."
                    : measurementFresh
                    ? `${selectedMeasurement.successfulSamples}/${selectedMeasurement.requestedSamples} replies · ${selectedMeasurement.packetLossPercent.toFixed(1)}% loss`
                    : "The B2G launcher measures the selected game-server route before queueing."}</small>
                </div>
              </div>
              <div className="route-measurement-actions">
                {probeHandoffSlow && probeLauncherUrl ? (
                  <a
                    className="route-measurement-action"
                    href={probeLauncherUrl}
                    onClick={onRetryLauncher}
                  >
                    <Gamepad2 size={14} /> Open again
                  </a>
                ) : (
                  <button
                    type="button"
                    className="route-measurement-action"
                    disabled={queue.phase !== "idle" || probePending}
                    onClick={onMeasureLatency}
                  >
                    {probePending ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                    {probePending ? "Measuring…" : measurementFresh ? "Refresh" : "Measure"}
                  </button>
                )}
                {onOpenLauncherGuide && (
                  <button
                    type="button"
                    className="route-guide-btn"
                    onClick={onOpenLauncherGuide}
                    title="View launcher setup guide"
                  >
                    <HelpCircle size={14} />
                  </button>
                )}
              </div>
            </div>
          )}

          {selectedMode === "competitive" && <div className="map-pool-header">
            <div>
              <span className="map-pool-title">Map pool</span>
              <span className="map-pool-count">
                {selectedMaps.length} of {MAPS.length}
              </span>
            </div>
            {queue.phase === "idle" && onSelectAllMaps && (
              <div className="map-pool-quick-actions">
                <button
                  type="button"
                  className="map-quick-btn"
                  onClick={() => onSelectAllMaps(true)}
                  title="Select all maps"
                >
                  All
                </button>
                <button
                  type="button"
                  className="map-quick-btn"
                  onClick={() => onSelectAllMaps(false)}
                  title="Clear map selections"
                >
                  Clear
                </button>
              </div>
            )}
          </div>}

          {selectedMode === "competitive" && <div className="map-grid">
            {MAPS.map((map) => {
              const on = selectedMaps.includes(map);
              const plate = MAP_PLATES[map];
              return (
                <button
                  type="button"
                  key={map}
                  className="map-btn"
                  aria-pressed={on}
                  disabled={queue.phase !== "idle"}
                  onClick={() => onToggleMap(map)}
                >
                  <span className={`map-visual ${plate ? "" : "map-visual--fallback"}`}>
                    {plate && <img src={plate} alt="" draggable={false} />}
                    <span className="map-check" aria-hidden="true"><Check size={13} /></span>
                    <strong>{map}</strong>
                  </span>
                </button>
              );
            })}
          </div>}

          {error && (
            <div className="queue-error" role="alert">
              <X size={14} /> {error}
            </div>
          )}

          <button
            type="submit"
            className={`queue-btn ${
              searching || queue.phase === "ready-check"
                ? "queue-btn--cancel"
                : "queue-btn--find"
            }`}
            disabled={
              requestPending
              || (selectedMode === "competitive" && selectedMaps.length === 0)
              || (queueDisabled && queue.phase === "idle")
              || (measurementRequired && !measurementFresh && queue.phase === "idle")
              || matchCommitted
            }
          >
            {searching && <Radio size={16} />}
            {requestPending
              ? selectedMode === "deathmatch" ? "Connecting…" : "Updating…"
              : searching
                ? "Leave Queue"
                : queue.phase === "ready-check"
                  ? "Decline Match"
                  : matchCommitted
                    ? "Match committed"
                  : selectedMode === "deathmatch" ? "Join Deathmatch" : "Find a Match"}
            {!searching && queue.phase !== "ready-check" && !matchCommitted && <ArrowUpRight size={15} />}
          </button>

          {selectedMode === "competitive" && selectedMaps.length === 0 && (
            <p className="queue-disabled-note">
              Select at least one map to search.
            </p>
          )}
          {measurementRequired && !measurementFresh && selectedMaps.length > 0 && (
            <p className="queue-disabled-note">
              Complete the launcher route check before entering matchmaking.
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
