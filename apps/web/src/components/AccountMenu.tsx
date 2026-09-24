import type { PlayerView } from "@aftertick/contracts";
import {
  ChevronDown,
  Gamepad2,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RankIcon } from "./RankIcon.js";

interface AccountMenuProps {
  player: PlayerView;
  onProfile: () => void;
  onSettings: () => void;
  onLauncher: () => void;
  onStanding: () => void;
  onLogout: () => void;
}

export function AccountMenu({
  player,
  onProfile,
  onSettings,
  onLauncher,
  onStanding,
  onLogout
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const select = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        className="user-btn"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="account-menu-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="user-avatar">{player.initials}</span>
        <span className="user-info">
          <strong>{player.displayName}</strong>
          <small>{player.rank.shortName} &middot; {player.rank.rating}</small>
        </span>
        <ChevronDown className="user-chevron" size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="account-menu__panel" id="account-menu-panel" role="dialog" aria-label="Account menu">
          <div className="account-menu__identity">
            <RankIcon rank={player.rank.name} size="sm" />
            <span>
              <strong>{player.displayName}</strong>
              <small>{player.rank.name} · {player.rank.rating.toLocaleString()} Elo</small>
            </span>
          </div>
          <div className="account-menu__items">
            <button type="button" onClick={() => select(onProfile)}>
              <UserRound size={16} /><span><strong>View profile</strong><small>Stats, Elo and match history</small></span>
            </button>
            <button type="button" onClick={() => select(onSettings)}>
              <Settings size={16} /><span><strong>Account settings</strong><small>Identity, privacy and notifications</small></span>
            </button>
            <button type="button" onClick={() => select(onLauncher)}>
              <Gamepad2 size={16} /><span><strong>Launcher setup</strong><small>Install and verify CS:GO</small></span>
            </button>
            <button type="button" onClick={() => select(onStanding)}>
              <ShieldCheck size={16} /><span><strong>Account standing</strong><small>Sanctions and appeals</small></span>
            </button>
          </div>
          <button className="account-menu__logout" type="button" onClick={() => select(onLogout)}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
