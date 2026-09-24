import { B2G_RELEASE, LAUNCHER_DOWNLOAD_FILENAME, LAUNCHER_DOWNLOAD_URL, type PlayerView, type QueueState } from "@aftertick/contracts";
import { Download, ExternalLink, Gamepad2, ShieldCheck } from "lucide-react";
import { RankIcon } from "./RankIcon.js";

interface LauncherHomeProps {
  player: PlayerView;
  queue: QueueState;
  platform: {
    onlinePlayers: number;
    activeMatches: number;
    season: string;
  };
  onOpenGuide: () => void;
  onOpenMatches: () => void;
}

function queueLabel(queue: QueueState): string {
  switch (queue.phase) {
    case "searching": return "Searching in CS:GO";
    case "ready-check": return "Match found — accept in CS:GO";
    case "map-veto": return "Match is being prepared";
    case "assigned": return "Server assigned";
    default: return "Ready to launch";
  }
}

export function LauncherHome({
  player,
  queue,
  platform,
  onOpenGuide,
  onOpenMatches
}: LauncherHomeProps) {
  return (
    <section className="launcher-home" aria-labelledby="launcher-home-title">
      <div className="launcher-home__lead">
        <Gamepad2 className="launcher-home__mark" size={30} aria-hidden="true" />
        <h1 id="launcher-home-title">Your next match starts inside CS:GO.</h1>
        <p>
          Open the B2G launcher, press <strong>GO</strong>, then use Official Matchmaking
          in Panorama. Deathmatch, Competitive, parties, maps, queue status, and the
          original ready prompt now stay in the game client.
        </p>
        <div className="launcher-home__actions">
          <a
            className="btn btn--primary launcher-home__download"
            href={LAUNCHER_DOWNLOAD_URL}
            download={LAUNCHER_DOWNLOAD_FILENAME}
          >
            <Download size={16} aria-hidden="true" /> Download launcher {B2G_RELEASE.launcherVersion}
          </a>
          <button className="btn btn--secondary" type="button" onClick={onOpenGuide}>
            Setup and recovery
          </button>
        </div>
        <p className="launcher-home__installed">
          Already installed? Open <strong>B2G Launcher</strong> from the Windows Start menu.
          Do not start this CS:GO session directly from Steam.
        </p>
      </div>

      <aside className="launcher-home__standing" aria-label={`${player.displayName} B2G standing`}>
        <div className="launcher-home__identity">
          <RankIcon rank={player.rank.name} size="md" />
          <div>
            <strong>{player.displayName}</strong>
            <span>{player.rank.name}</span>
          </div>
        </div>
        <dl>
          <div><dt>Rating</dt><dd>{player.rank.rating.toLocaleString()} Elo</dd></div>
          <div><dt>Client state</dt><dd>{queueLabel(queue)}</dd></div>
          <div><dt>Platform</dt><dd>{platform.onlinePlayers.toLocaleString()} online</dd></div>
          <div><dt>Live matches</dt><dd>{platform.activeMatches}</dd></div>
          <div><dt>Season</dt><dd>{platform.season}</dd></div>
        </dl>
      </aside>

      <ol className="launcher-home__flow" aria-label="Launcher-first matchmaking flow">
        <li><span>1</span><strong>Connect once</strong><p>Pair the launcher to this Steam account without sharing your password.</p></li>
        <li><span>2</span><strong>Press GO</strong><p>B2G loads your verified inventory and profile before Panorama opens.</p></li>
        <li><span>3</span><strong>Queue in game</strong><p>Accept Competitive in CS:GO&apos;s native prompt. Deathmatch connects automatically.</p></li>
      </ol>

      <div className="launcher-home__secondary">
        <div>
          <ShieldCheck size={18} aria-hidden="true" />
          <p><strong>Website queuing has moved into the client.</strong> This site remains available for account settings, match evidence, support, and operations.</p>
        </div>
        <button type="button" onClick={onOpenMatches}>
          Review match history <ExternalLink size={14} />
        </button>
      </div>
    </section>
  );
}
