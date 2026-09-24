import { Activity, Radio, Server, Wifi, WifiOff } from "lucide-react";

interface ConnectionStatusProps {
  live: boolean;
  onlinePlayers: number;
  activeMatches: number;
  season: string;
  region: string;
}

export function ConnectionStatus({ live, onlinePlayers, activeMatches, season, region }: ConnectionStatusProps) {
  return (
    <details className={`connection-status ${live ? "is-live" : "is-offline"}`}>
      <summary aria-label={`${live ? "Live updates connected" : "Live updates disconnected"}. Open connection details.`}>
        {live ? <Wifi size={12} /> : <WifiOff size={12} />}
        <span>{live ? "Live" : "Offline"}</span>
      </summary>
      <div className="connection-popover">
        <header>
          <span className="connection-popover__pulse" aria-hidden="true" />
          <div><strong>{live ? "Realtime connected" : "Realtime interrupted"}</strong><small>Platform event stream</small></div>
        </header>
        <dl>
          <div><dt><Radio size={12} /> Match alerts</dt><dd>{live ? "Instant" : "May be delayed"}</dd></div>
          <div><dt><Server size={12} /> API</dt><dd>Reachable</dd></div>
          <div><dt><Activity size={12} /> Platform</dt><dd>{onlinePlayers.toLocaleString()} players · {activeMatches} matches</dd></div>
          <div><dt>Route</dt><dd>{region}</dd></div>
          <div><dt>Season</dt><dd>{season}</dd></div>
        </dl>
        <p>{live
          ? "Ready checks, queue movement, veto updates, and server assignments are arriving in real time."
          : "B2G retries automatically. API actions still work, but keep this page open until live updates reconnect."}</p>
      </div>
    </details>
  );
}
