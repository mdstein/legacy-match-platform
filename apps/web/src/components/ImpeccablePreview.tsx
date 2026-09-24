import {
  Activity,
  Check,
  ChevronDown,
  Crosshair,
  Globe2,
  ShieldCheck,
  Swords,
  Trophy,
  Users,
  X
} from "lucide-react";
import "./impeccable-preview.css";

const MAP_PLATES = [
  ["dust2", "Dust2"],
  ["mirage", "Mirage"],
  ["inferno", "Inferno"],
  ["ancient", "Ancient"],
  ["nuke", "Nuke"],
  ["vertigo", "Vertigo"]
] as const;

export function ImpeccablePreview() {
  return (
    <main className="impeccable-frame" aria-label="B2G play surface">
      <header className="impeccable-header" data-region="header-shell">
        <button className="impeccable-brand" data-region="brand-mark" type="button" aria-label="B2G Play">
          <svg viewBox="0 0 130 45" role="img" aria-label="B2G">
            <path d="M5 7h29c8 0 11 4 10 10-.5 4-3 6-7 7 4 1 6 4 5 8-1 5-5 7-12 7H0L5 7Zm10 7-1 7h17c3 0 4-1 4-4 0-2-1-3-4-3H15Zm-2 13-1 6h17c3 0 4-1 4-3s-1-3-4-3H13Z" fill="currentColor" fillRule="evenodd" />
            <path d="M48 15c1-6 5-8 12-8h22c8 0 12 4 11 10-.5 4-3 7-8 10L67 33h21l-1 6H45l1-7 31-11c3-1 5-3 5-5 0-2-2-3-5-3H61c-3 0-5 1-5 4H47l1-2Z" fill="currentColor" />
            <path d="M105 7h25l-1 7h-20c-4 0-6 2-7 6l-2 7c-1 4 1 6 5 6h12l1-5h-11l1-6h21l-3 17h-26c-8 0-11-4-9-12l3-11c1-6 5-9 11-9Z" fill="#b99a63" />
          </svg>
        </button>
        <nav className="impeccable-nav" data-region="primary-navigation" aria-label="Main navigation">
          <button className="is-active" type="button">Play</button>
          <button type="button">Matches</button>
          <button type="button">Ladder</button>
          <button type="button">Settings</button>
        </nav>
        <button className="impeccable-live" data-region="live-control" type="button" aria-haspopup="dialog">
          <span className="impeccable-live-dot" /> Live <ChevronDown aria-hidden="true" />
        </button>
      </header>

      <section className="impeccable-queue-ground" aria-label="Matchmaking queue">
        <div className="impeccable-mode-tabs">
          <button className="impeccable-mode is-active" data-region="competitive-mode" type="button">
            <svg className="impeccable-mode-shield" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 3.5 12 1l8 2.5v7.2c0 5.2-3.1 8.8-8 11.3-4.9-2.5-8-6.1-8-11.3V3.5Z" fill="currentColor" />
              <path d="m8.1 10.7 2.6 2.6 5.4-5.6" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
            </svg>
            Competitive 5v5
          </button>
          <button className="impeccable-mode" data-region="deathmatch-mode" type="button">
            <Crosshair aria-hidden="true" /> Deathmatch FFA
          </button>
        </div>

        <span className="impeccable-field-label impeccable-field-label--region" data-region="region-label">Region</span>
        <span className="impeccable-field-label impeccable-field-label--mode" data-region="game-mode-label">Game mode</span>
        <span className="impeccable-field-label impeccable-field-label--tick" data-region="tick-rate-label">Tick rate</span>

        <button className="impeccable-select impeccable-select--region" data-region="region-select" type="button">
          <Globe2 aria-hidden="true" /><span>NA Central</span><ChevronDown aria-hidden="true" />
        </button>
        <button className="impeccable-select impeccable-select--mode" data-region="game-mode-select" type="button">
          <ShieldCheck aria-hidden="true" /><span>Competitive 5v5</span><ChevronDown aria-hidden="true" />
        </button>
        <button className="impeccable-select impeccable-select--tick" data-region="tick-rate-select" type="button">
          <Activity aria-hidden="true" /><span>128 tick</span><ChevronDown aria-hidden="true" />
        </button>

        <h1 className="impeccable-map-title" data-region="map-pool-title">Map pool</h1>
      </section>

      <section className="impeccable-ledger-ground" data-region="recent-ledger" aria-labelledby="impeccable-recent-title">
        <h2 id="impeccable-recent-title" data-region="recent-section-heading">Recent matches</h2>
        <div className="impeccable-ledger-head" data-region="recent-table-headings">
          <span>Result</span><span>Map</span><span>Score</span><span>K / D / A</span><span>Elo change</span><span>Date</span>
        </div>
        <button className="impeccable-match-row impeccable-match-row--one" data-region="recent-row-one" type="button">
          <strong className="is-win"><Trophy aria-hidden="true" /> Win</strong><span>Mirage</span><b><i>16</i> - 9</b><span>24 / 14 / 5</span><strong className="is-win">+24</strong><time>May 21, 2025 10:42 PM</time><ChevronDown aria-hidden="true" />
        </button>
        <button className="impeccable-match-row impeccable-match-row--two" data-region="recent-row-two" type="button">
          <strong className="is-win"><Trophy aria-hidden="true" /> Win</strong><span>Inferno</span><b><i>16</i> - 12</b><span>20 / 16 / 7</span><strong className="is-win">+21</strong><time>May 21, 2025 9:57 PM</time><ChevronDown aria-hidden="true" />
        </button>
        <button className="impeccable-match-row impeccable-match-row--three" data-region="recent-row-three" type="button">
          <strong className="is-loss"><X aria-hidden="true" /> Loss</strong><span>Dust2</span><b><i className="is-loss">9</i> - 16</b><span>15 / 18 / 4</span><strong className="is-loss">-18</strong><time>May 21, 2025 8:58 PM</time><ChevronDown aria-hidden="true" />
        </button>
      </section>

      <aside className="impeccable-dossier-ground" aria-label="Player dossier">
        <button className="impeccable-avatar" data-region="player-avatar" type="button" aria-label="Open profile">B2G</button>
        <div className="impeccable-identity" data-region="player-identity">
          <strong>B2GPlayer <span /></strong><small>Member since Jun 2023</small>
        </div>
      </aside>

      <footer className="impeccable-footer-ground" data-region="footer-shell">
        <span className="impeccable-copyright" data-region="footer-copyright">© 2025 B2G. All rights reserved.</span>
        <nav className="impeccable-footer-links" data-region="footer-links" aria-label="Footer">
          <a href="#support">Support</a><a href="#rules">Rules</a><a href="#status">Status</a><a href="#terms">Terms</a><a href="#privacy">Privacy</a>
        </nav>
      </footer>

      {MAP_PLATES.map(([id, label]) => (
        <figure
          className={`impeccable-plate impeccable-map impeccable-map--${id}`}
          data-region={`map-${id}`}
          key={id}
        >
          <img src={`/plates/map-${id}.png`} alt={`${label} map environment`} />
        </figure>
      ))}

      <div className="impeccable-map-checks" data-region="map-selection-controls" aria-label="Selected maps">
        {MAP_PLATES.map(([id, label]) => <span className={`impeccable-check impeccable-check--${id}`} key={id} aria-label={`${label} selected`}><Check aria-hidden="true" /></span>)}
      </div>
      <div className="impeccable-map-names" data-region="map-names">
        {MAP_PLATES.map(([id, label]) => <span className={`impeccable-map-name impeccable-map-name--${id}`} key={id}>{label}</span>)}
      </div>
      <span className="impeccable-map-summary" data-region="map-selection-summary">6 / 6 maps selected</span>
      <button className="impeccable-edit-maps" data-region="edit-map-pool" type="button">Edit map pool</button>
      <button className="impeccable-find" data-region="find-match" type="button"><Swords aria-hidden="true" /> Find a match</button>

      <figure className="impeccable-plate impeccable-rank" data-region="rank-emblem">
        <img src="/plates/rank-emblem.png" alt="Distinguished Master Guardian rank emblem" />
      </figure>
      <strong className="impeccable-rank-name" data-region="rank-name">Distinguished Master Guardian</strong>
      <strong className="impeccable-elo" data-region="elo-rating">1,742 Elo</strong>

      <section className="impeccable-party-block" aria-labelledby="impeccable-party-title">
        <h2 id="impeccable-party-title" data-region="party-label">Party</h2>
        <span className="impeccable-party-count" data-region="party-count"><Users aria-hidden="true" /><strong>2</strong> / 5</span>
        <button className="impeccable-invite" data-region="invite-control" type="button">Invite</button>
      </section>
      <section className="impeccable-trust-block" aria-labelledby="impeccable-trust-title">
        <h2 id="impeccable-trust-title" data-region="trust-label">Trust factor</h2>
        <div className="impeccable-trust" data-region="trust-status"><ShieldCheck aria-hidden="true" /><span><strong>Very high</strong><small>You’re in good standing.</small></span></div>
      </section>
      <button className="impeccable-view-profile" data-region="view-profile" type="button">View profile</button>
    </main>
  );
}
