import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUpRight,
  Check,
  CircleHelp,
  Download,
  Gamepad2,
  History,
  LogIn,
  Maximize2,
  Minus,
  Play,
  RefreshCw,
  Settings as SettingsIcon,
  Users,
  X,
  ArrowLeftRight,
  ShieldCheck,
  Package,
} from "lucide-react";
import {
  call,
  disconnectAccount,
  display,
  invalidate,
  useAction,
  useRemote,
  type Data,
  type Status,
} from "./api";
import { assets, rankImage } from "./assets";
import {
  Avatar,
  Dialog,
  Empty,
  Feedback,
  Loading,
  Spinner,
} from "./components";
import { Trading } from "./trading";
import { Friends } from "./friends";
import { Inventory } from "./inventory";
import { Settings, MatchHistory, Setup } from "./pages";
import "./styles.css";
import bundledRelease from "../../../packages/contracts/src/release.json";
type Tab = "play" | "inventory" | "trading" | "history" | "friends" | "settings";
const tabs = [
  ["play", "Play", Gamepad2],
  ["inventory", "Inventory", Package],
  ["trading", "Trading", ArrowLeftRight],
  ["history", "Match history", History],
  ["friends", "Friends", Users],
  ["settings", "Settings", SettingsIcon],
] as const;
function App() {
  const [tab, setTab] = useState<Tab>("play");
  const [visited, setVisited] = useState(new Set<Tab>(["play"]));
  const status = useRemote<Status>("status", "status", {}, true, 1500);
  const s = status.data;
  const bootstrap = useRemote<Data>(
    s?.paired ? "bootstrap:paired" : "bootstrap:disconnected",
    "bootstrap",
    {},
    !!s?.paired,
    30_000,
  );
  const b = s?.paired ? bootstrap.data : undefined;
  const player = b?.player;
  const scope = String(player?.id || "signed-out");
  const [dialog, setDialog] = useState<"help" | "notes" | "close" | null>(null);
  const action = useAction();
  const reduced = !!player?.settings?.reducedMotion;
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reduced);
  }, [reduced]);
  useEffect(() => {
    void document.fonts.ready
      .then(() => getCurrentWindow().show())
      .catch(() => {});
    const pending = listen("close-blocked", () => setDialog("close")).catch(
      () => () => {},
    );
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    if (s && !s.paired) {
      disconnectAccount();
    }
  }, [s?.paired]);
  const navigate = (next: Tab) => {
    setVisited((previous) => new Set([...previous, next]));
    setTab(next);
  };
  useEffect(() => {
    document
      .querySelector<HTMLElement>(`[data-page="${tab}"] h1`)
      ?.focus({ preventScroll: true });
  }, [tab]);
  const busy = !!action.busy || s?.session.phase === "starting";
  const running =
    s?.session.phase === "running" ||
    (s?.session.phase !== "starting" && s?.gameOpen);
  const setup =
    !!s &&
    (!s.paired ||
      !s.installation.ready ||
      !b ||
      !!player?.onboardingRequired ||
      s.session.pairing ||
      s.session.installing);
  const launch = async () => {
    if (!s) return;
    if (!s.installation.ready) {
      navigate("play");
      await action.run("install");
    } else if (!s.paired) {
      navigate("play");
      await action.run("pair");
    } else if (player?.onboardingRequired) {
      navigate("play");
      document.querySelector<HTMLInputElement>("#setup-name")?.focus();
      return;
    } else await action.run("play");
    await status.refresh();
  };
  const label = !s
    ? "Checking"
    : s.session.preparing
      ? "Finishing setup"
      : s.session.installing
        ? "Installing"
        : s.session.pairing
          ? "Connecting"
          : running
            ? "In game"
            : busy
              ? "Starting"
              : !s.installation.ready
                ? "Install CS:GO"
                : !s.paired
                  ? "Connect Steam"
                  : !b
                    ? "Loading account"
                    : player?.onboardingRequired
                    ? "Finish setup"
                    : "Play";
  const release = b?.launcher;
  const notes =
    s?.version && release?.content?.history?.[0]?.version === s.version
      ? release.content.history
      : bundledRelease.history;
  const sessionError = s?.session.phase === "failed" ? s.session.message : "";
  const disabled =
    !s ||
    busy ||
    running ||
    s.session.pairing ||
    s.session.installing ||
    s.session.preparing ||
    (!!s.paired && !b);
  const refresh = () => {
    invalidate();
  };
  const close = () =>
    void getCurrentWindow()
      .close()
      .catch(() => {});
  return (
    <div className="app-shell">
      <header className="topbar">
        <div
          className="brand"
          data-tauri-drag-region
          onMouseDown={(e) => {
            if (e.button === 0) void getCurrentWindow().startDragging();
          }}
        >
          <img src={assets.logo} alt="B2G" />
          <span>FOUNDERS PLAYTEST</span>
        </div>
        <nav aria-label="Launcher">
          <div className="tabs">
            {tabs.map(([key, label, Icon]) => (
              <button
                key={key}
                className={tab === key ? "tab active" : "tab"}
                aria-current={tab === key ? "page" : undefined}
                onClick={() => navigate(key)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="top-actions">
          <button
            className="icon-button"
            onClick={refresh}
            aria-label="Refresh current data"
            title="Refresh"
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="account-button"
            onClick={() => navigate("settings")}
          >
            <Avatar
              name={player?.displayName}
              icon={s?.profileIcon}
              rank={b?.gameProfile?.competitiveRankId}
              size={26}
            />
            <span>Account</span>
          </button>
        </div>
        <div className="window-actions">
          <button
            aria-label="Minimize"
            onClick={() => void getCurrentWindow().minimize()}
          >
            <Minus size={17} />
          </button>
          <button
            aria-label="Maximize or restore"
            onClick={() => void getCurrentWindow().toggleMaximize()}
          >
            <Maximize2 size={15} />
          </button>
          <button
            className="window-close"
            aria-label="Close launcher"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <main>
        {tabs.map(
          ([key]) =>
            visited.has(key) && (
              <section
                key={key}
                data-page={key}
                className="page"
                hidden={tab !== key}
              >
                {key === "play" ? (
                  setup ? (
                    <Setup
                      status={s!}
                      player={player}
                      error={status.error || (s?.paired ? bootstrap.error : "")}
                      refresh={refresh}
                    />
                  ) : !s || (s.paired && !b) ? (
                    <>
                      <Loading label="Loading your launcher" />
                      <Feedback
                        error={status.error || bootstrap.error}
                        retry={refresh}
                      />
                    </>
                  ) : (
                    <Home
                      b={b || {}}
                      status={s}
                      onNotes={() => setDialog("notes")}
                      onAccount={() => navigate("settings")}
                    />
                  )
                ) : !s || (!s.paired && key !== "settings") ? (
                  <Empty title="Connect your B2G account">
                    Use Connect Steam below to access your{" "}
                    {key === "history" ? "match history" : key}.
                  </Empty>
                ) : key === "inventory" ? (
                  <Inventory key={scope} scope={scope} active={tab === key} />
                ) : key === "trading" ? (
                  <Trading key={scope} scope={scope} active={tab === key} />
                ) : key === "friends" ? (
                  <Friends
                    key={scope}
                    scope={scope}
                    active={tab === key}
                    profileIcon={s.profileIcon}
                    rankId={b?.gameProfile?.competitiveRankId}
                  />
                ) : key === "history" ? (
                  <MatchHistory
                    key={scope}
                    scope={scope}
                    active={tab === key}
                  />
                ) : (
                  <Settings
                    key={scope}
                    status={s}
                    rankId={b?.gameProfile?.competitiveRankId}
                    scope={scope}
                    active={tab === key}
                    refresh={refresh}
                  />
                )}
              </section>
            ),
        )}
      </main>
      <footer className="playbar">
        <button
          className="play-button"
          disabled={disabled}
          onClick={() => void launch()}
        >
          {busy || s?.session.pairing || s?.session.installing ? (
            <Spinner />
          ) : running ? (
            <Check size={23} />
          ) : !s?.installation.ready ? (
            <Download size={23} />
          ) : !s?.paired ? (
            <LogIn size={23} />
          ) : (
            <Play size={23} fill="currentColor" />
          )}
          <span>{label}</span>
        </button>
        <div className="footer-stat">
          <span>Server region</span>
          <strong>{display(player?.region, "Select during setup")}</strong>
        </div>
        <div className="footer-stat live-stat">
          <span>Players online</span>
          <strong>
            <i className="live-dot" />
            {display(b?.platform?.onlinePlayers, "—")}
          </strong>
        </div>
        <div className="footer-status">
          <span className={sessionError || action.error ? "error-text" : ""}>
            {sessionError
              ? "Launch needs attention"
              : running
                ? "CS:GO is running"
                : s?.session.phase === "starting"
                  ? "Starting CS:GO"
                  : s?.session.installing
                    ? "Steam is installing CS:GO"
                    : s?.paired
                      ? bootstrap.error
                        ? "Connection interrupted"
                        : "Ready when you are"
                      : "Welcome to B2G"}
          </span>
          <small>
            {sessionError || action.error ? (
              <button className="text-button" onClick={() => setDialog("help")}>
                Open Launch Help <CircleHelp size={14} />
              </button>
            ) : running ? (
              "Choose your match inside the game."
            ) : busy ? (
              "Preparing the game and connecting your inventory."
            ) : bootstrap.error ? (
              "Account sync paused. Refresh to reconnect."
            ) : (
              "Your inventory and matchmaking stay connected here."
            )}
          </small>
        </div>
        <div className="version">
          <span>LAUNCHER {s?.version || ""}</span>
          <button className="text-button" onClick={() => setDialog("notes")}>
            Release notes <ArrowUpRight size={13} />
          </button>
        </div>
      </footer>
      {dialog && (
        <Dialog
          title={
            dialog === "close"
              ? "B2G is still in use"
              : dialog === "help"
                ? "Launch Help"
                : "Release notes"
          }
          onClose={() => setDialog(null)}
        >
          {dialog === "close" ? (
            <>
              <p>
                Keep B2G open while CS:GO is starting or running so your
                inventory and matchmaking stay connected. Also let any file
                changes or account actions finish before closing. You can
                minimize B2G.
              </p>
              <button
                className="primary"
                onClick={() => {
                  setDialog(null);
                  void getCurrentWindow().minimize();
                }}
              >
                Minimize launcher
              </button>
            </>
          ) : dialog === "help" ? (
            <>
              <p className="pre-wrap">
                {sessionError ||
                  action.error ||
                  "No launch error is currently reported."}
              </p>
              <p>Resolve the issue, then press Play to try again.</p>
              <button
                className="secondary"
                onClick={() => void call("open_log")}
              >
                Open diagnostic log
              </button>
            </>
          ) : (
            <ReleaseNotes notes={notes} />
          )}
        </Dialog>
      )}
    </div>
  );
}
function ReleaseNotes({ notes }: { notes: Data[] }) {
  return notes.length ? (
    <div className="release-list">
      {notes.map((note) => (
        <article key={note.version}>
          <div className="release-heading">
            <strong>v{note.version}</strong>
            <time>{note.date}</time>
          </div>
          <ul>
            {note.changes?.map((change: Data, i: number) => (
              <li key={i}>
                <span className={`change-kind ${change.kind}`}>
                  {change.kind}
                </span>
                <span>{change.text}</span>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  ) : (
    <p>Release information will appear when your account connects.</p>
  );
}
function Home({
  b,
  status,
  onNotes,
  onAccount,
}: {
  b: Data;
  status: Status;
  onNotes: () => void;
  onAccount: () => void;
}) {
  const p = b.player || {};
  const game = b.gameProfile || {};
  const content = b.launcher?.content || bundledRelease;
  const update =
    typeof content.releaseVersion === "string" &&
    /^\d+\.\d+\.\d+$/.test(content.releaseVersion) &&
    content.releaseVersion.localeCompare(status.version, undefined, {
      numeric: true,
    }) > 0;
  const rank = b.rank || p.rank || {};
  return (
    <div className="home-grid">
      <section className="profile-panel">
        <div className="identity">
          <Avatar
            name={p.displayName}
            icon={status.profileIcon}
            rank={game.competitiveRankId}
            size={56}
          />
          <div>
            <h1>{display(p.displayName, "B2G player")}</h1>
            <span className="online">
              <i className="live-dot" />
              Connected
            </span>
          </div>
        </div>
        <div className="profile-rank">
          {rankImage(game.competitiveRankId) && (
            <img
              src={rankImage(game.competitiveRankId)}
              alt="Competitive rank"
            />
          )}
          <h2>{display(rank.name, "Competitive")}</h2>
          <span>
            {display(rank.rating ?? p.rating, "—")} ELO ·{" "}
            {display(game.competitiveWins, 0)} wins
          </span>
        </div>
        <div className="level-row">
          <strong>Level {display(game.playerLevel, 1)}</strong>
          <span>
            {game.playerLevel === 40
              ? "Service medal ready"
              : `${display(game.playerXp, 0)} / 1,000 XP`}
          </span>
        </div>
        <progress
          aria-label="Experience toward next level"
          max={1000}
          value={game.playerLevel === 40 ? 1000 : game.playerXp || 0}
        />
        <p className="muted small">
          {game.playerLevel === 40
            ? "Redeem your service medal in game."
            : "Play matches to earn XP and level rewards."}
        </p>
        <div className="access-row">
          <ShieldCheck size={20} />
          <div>
            <strong>Founders playtest</strong>
            <span>Account connected</span>
          </div>
        </div>
        <button className="secondary full" onClick={onAccount}>
          Account settings
        </button>
      </section>
      <section className="news-column">
        <div className="section-heading">
          <h2>Latest from B2G</h2>
          <span>CLIENT NEWS</span>
        </div>
        <article className="news-hero">
          <img src={assets.hero} alt="" />
          <div className="news-copy">
            <h2>{display(content.news?.title, "Back to the game.")}</h2>
            <p>
              {display(
                content.news?.summary,
                "Classic CS:GO, your inventory, and community matchmaking in one place.",
              )}
            </p>
            <button className="text-button" onClick={onNotes}>
              Read the latest <ArrowUpRight size={16} />
            </button>
          </div>
        </article>
        <div className="news-secondary">
          <img src={assets.map} alt="Dust II map artwork" />
          <div>
            <h3>Your next match starts here</h3>
            <p>Choose Competitive or Deathmatch inside CS:GO.</p>
          </div>
        </div>
      </section>
      <section className="updates-panel">
        <div className="section-heading">
          <h2>What’s new</h2>
          <span>v{status.version}</span>
        </div>
        <div className="updates-scroll">
          <ReleaseNotes
            notes={(content.history?.[0]?.version === status.version
              ? content.history
              : bundledRelease.history
            ).slice(0, 3)}
          />
        </div>
        <button className="secondary full" onClick={onNotes}>
          All release notes <ArrowUpRight size={15} />
        </button>
        {update && (
          <button
            className="primary full"
            onClick={() =>
              void call("open_link", {
                url: "https://play.back2go.net/download",
              })
            }
          >
            Download v{content.releaseVersion}
            <Download size={16} />
          </button>
        )}
      </section>
    </div>
  );
}
class LauncherBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    void getCurrentWindow()
      .show()
      .catch(() => {});
  }
  render() {
    return this.state.failed ? (
      <div className="empty">
        <h1>The interface needs to reload</h1>
        <p>Your game session stays connected while the interface reloads.</p>
        <button className="primary" onClick={() => location.reload()}>
          Reload interface
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <LauncherBoundary>
    <App />
  </LauncherBoundary>,
);
