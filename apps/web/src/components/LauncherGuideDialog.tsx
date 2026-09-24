import {
  Download,
  Gamepad2,
  Laptop,
  Radio,
  ShieldCheck,
  Terminal
} from "lucide-react";
import { B2G_RELEASE, LAUNCHER_DOWNLOAD_FILENAME, LAUNCHER_DOWNLOAD_URL } from "@aftertick/contracts";
import { useEffect, useRef, useState } from "react";
import { DetailDialog } from "./DetailDialog.js";

export { LAUNCHER_DOWNLOAD_URL } from "@aftertick/contracts";

interface LauncherGuideDialogProps {
  onClose: () => void;
  onMeasureLatency?: () => void;
  latencyRequired?: boolean;
}

export function LauncherGuideDialog({
  onClose,
  onMeasureLatency,
  latencyRequired = false
}: LauncherGuideDialogProps) {
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyRequest = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    copyRequest.current += 1;
    clearTimeout(copyTimer.current);
  }, []);

  const copyToClipboard = async (text: string, id: string) => {
    const request = ++copyRequest.current;
    clearTimeout(copyTimer.current);
    setCopiedCmd(null);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      if (request !== copyRequest.current) return;
      setCopiedCmd(id);
      copyTimer.current = setTimeout(() => setCopiedCmd(null), 2000);
    } catch {
      if (request === copyRequest.current) {
        setCopyError("Could not copy the command. Select the command text and copy it manually.");
      }
    }
  };

  return (
    <DetailDialog
      title="Launcher & Setup"
      onClose={onClose}
      wide
    >
      <div className="launcher-guide">
        {/* Intro banner */}
        <section className="launcher-hero">
          <div className="launcher-hero-icon" aria-hidden="true">
            <Gamepad2 size={24} />
          </div>
          <div>
            <h3>Set up once, then play from CS:GO</h3>
            <p>
              The Windows launcher connects your B2G account, checks your game installation,
              and loads your profile and compatible inventory. Keep it open while playing
              so matchmaking and inventory updates stay connected.
            </p>
          </div>
        </section>

        {/* 3 Step Setup Card Grid */}
        <div className="launcher-steps-grid">
          <article className="launcher-step-card">
            <div className="launcher-step-badge">1</div>
            <h4>Standalone CS:GO</h4>
            <p>B2G prefers Valve&apos;s standalone legacy release:</p>
            <ol className="launcher-step-list">
              <li>
                Install <a href="https://store.steampowered.com/app/4465480/CounterStrikeGlobal_Offensive/" target="_blank" rel="noreferrer"><strong>Counter-Strike: Global Offensive</strong></a>
              </li>
              <li>Confirm Steam shows it as a separate game</li>
              <li>Wait until its <strong>Play</strong> button is available</li>
              <li>App 730&apos;s <strong>csgo_legacy</strong> beta remains supported as a fallback</li>
            </ol>
          </article>

          <article className="launcher-step-card">
            <div className="launcher-step-badge">2</div>
            <h4>Install Launcher</h4>
            <p>Close CS:GO and any older B2G launcher, then download and run the Windows playtest launcher:</p>
            <div className="launcher-download-box">
              <a
                className="btn btn--primary launcher-dl-btn"
                href={LAUNCHER_DOWNLOAD_URL}
                download={LAUNCHER_DOWNLOAD_FILENAME}
              >
                <Download size={15} aria-hidden="true" /> Download {B2G_RELEASE.launcherVersion}
              </a>
              <small>Windows may show Unknown publisher: choose More info, then Run anyway. No admin required. Fully exit FACEIT before joining a B2G match.</small>
            </div>
          </article>

          <article className="launcher-step-card">
            <div className="launcher-step-badge">3</div>
            <h4>Connect Account & Play</h4>
            <ol className="launcher-step-list">
              <li>Choose <strong>Connect Account</strong> in the launcher and approve its code on this website.</li>
              <li>Press <strong>GO</strong>. B2G checks your inventory and connection as it starts CS:GO.</li>
              <li>Choose <strong>Official Matchmaking</strong> in CS:GO. Competitive needs ten players to accept; Deathmatch connects automatically.</li>
            </ol>
            <p>Keep your Steam inventory public so B2G can verify compatible owned items.</p>
            {latencyRequired && <p role="status">A fresh route check is needed before you can queue.</p>}
            {onMeasureLatency && (
              <button
                type="button"
                className="btn btn--secondary launcher-probe-trigger"
                onClick={() => {
                  onMeasureLatency();
                  onClose();
                }}
              >
                <Radio size={14} /> Start Route Latency Check
              </button>
            )}
          </article>
        </div>

        {/* Feature & Security Highlights */}
        <div className="launcher-features-row">
          <div className="launcher-feature">
            <ShieldCheck size={16} />
            <div>
              <strong>Recoverable Native Compatibility</strong>
              <span>Installs the pinned local-GC wrapper only after preserving the Valve executable, then launches App 4465480 through Steam.</span>
            </div>
          </div>
          <div className="launcher-feature">
            <Radio size={16} />
            <div>
              <strong>Measured Server Routes</strong>
              <span>The launcher measures server latency and packet loss before matchmaking. If a route is unavailable, retry the check before queuing.</span>
            </div>
          </div>
          <div className="launcher-feature">
            <Laptop size={16} />
            <div>
              <strong>Repairable & Reversible</strong>
              <span>Verifies embedded hashes, repairs managed files, collects console/GC log paths, and restores the exact Valve backup on uninstall.</span>
            </div>
          </div>
          <div className="launcher-feature">
            <ShieldCheck size={16} />
            <div>
              <strong>Your Steam Inventory</strong>
              <span>Mirrors exact, legacy-compatible attributes from a fresh public Steam inventory snapshot. The game server independently rejects unowned or altered items.</span>
            </div>
          </div>
        </div>

        {/* CLI Reference Drawer */}
        <details className="launcher-cli-accordion">
          <summary>
            <Terminal size={14} /> View Launcher CLI Commands & Options
          </summary>
          <div className="launcher-cli-content">
            <p>Advanced troubleshooting only. Open Command Prompt in <code>%LOCALAPPDATA%\B2G\bin</code> to run these commands. Matchmaking itself stays in CS:GO.</p>
            <p role="status" aria-live="polite">{copyError ?? (copiedCmd ? "Command copied." : "")}</p>
            <div className="launcher-cli-item">
              <div className="launcher-cli-header">
                <code>b2g-launcher doctor [--json]</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard("b2g-launcher doctor", "cli1")}
                  aria-label="Copy doctor command"
                >
                  {copiedCmd === "cli1" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p>Prefers standalone App 4465480, falls back to App 730&apos;s <code>csgo_legacy</code> branch, and verifies the legacy executable and build metadata.</p>
            </div>

            <div className="launcher-cli-item">
              <div className="launcher-cli-header">
                <code>b2g-launcher probe --server SERVER_HOST:PORT</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard("b2g-launcher probe --server SERVER_HOST:PORT", "cli2")}
                  aria-label="Copy probe command"
                >
                  {copiedCmd === "cli2" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p>Replace SERVER_HOST:PORT with the game-server address supplied by the playtest operator to measure latency and packet loss.</p>
            </div>

            <div className="launcher-cli-item">
              <div className="launcher-cli-header">
                <code>b2g-launcher install-protocol</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard("b2g-launcher install-protocol", "cli3")}
                  aria-label="Copy protocol command"
                >
                  {copiedCmd === "cli3" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p>Registers the <code>b2g://</code> deep link handler under the current Windows user registry (HKCU).</p>
            </div>

            <div className="launcher-cli-item">
              <div className="launcher-cli-header">
                <code>b2g-launcher inventory-sync</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard("b2g-launcher inventory-sync", "cli4")}
                  aria-label="Copy inventory command"
                >
                  {copiedCmd === "cli4" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p>Backs up legacy <code>steam.inf</code>, synchronizes its client build metadata, and restores access to compatible cosmetics owned by the signed-in Steam account.</p>
            </div>

            <div className="launcher-cli-item">
              <div className="launcher-cli-header">
                <code>b2g-launcher game-repair</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard("b2g-launcher game-repair", "cli5")}
                  aria-label="Copy repair command"
                >
                  {copiedCmd === "cli5" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p>Reapplies only pinned B2G compatibility files, preserving any pre-existing files before replacement.</p>
            </div>

            <div className="launcher-cli-item">
              <div className="launcher-cli-header">
                <code>b2g-launcher diagnostics --json</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard("b2g-launcher diagnostics --json", "cli6")}
                  aria-label="Copy diagnostics command"
                >
                  {copiedCmd === "cli6" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p>Reports installed-file versions, backup state, and log locations. Share the diagnostic report with your playtest operator; keep account credentials and inventory manifests private.</p>
            </div>

            <div className="launcher-cli-item">
              <div className="launcher-cli-header">
                <code>b2g-launcher game-uninstall</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard("b2g-launcher game-uninstall", "cli7")}
                  aria-label="Copy uninstall command"
                >
                  {copiedCmd === "cli7" ? "Copied!" : "Copy"}
                </button>
              </div>
              <p>Removes recognized B2G files and restores the verified Valve launcher backup without touching unknown files.</p>
            </div>
          </div>
        </details>
      </div>
    </DetailDialog>
  );
}
