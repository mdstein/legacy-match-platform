import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  LogOut,
  Monitor,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Wrench,
} from "lucide-react";
import {
  call,
  disconnectAccount,
  date,
  display,
  invalidate,
  regionList,
  useAction,
  useRemote,
  type Data,
  type Status,
} from "./api";
import { assets } from "./assets";
import {
  Avatar,
  CopyButton,
  Dialog,
  Empty,
  Feedback,
  Loading,
  PageTitle,
  Pager,
  Spinner,
} from "./components";

export function Setup({
  status,
  player,
  error,
  refresh,
}: {
  status: Status;
  player?: Data;
  error?: string;
  refresh: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [region, setRegion] = useState(regionList[0]!);
  const needsProfile = !!player?.onboardingRequired;
  const loadingProfile = status.paired && !player;
  useEffect(() => {
    setName("");
    setRegion(regionList[0]!);
  }, [player?.id]);
  const i = status.installation;
  const s = status.session;
  const task = async (op: string, args: Data = {}) => {
    const result = await action.run(op, args);
    refresh();
    return result;
  };
  const progress =
    i.total > 0 ? Math.min(100, (i.downloaded / i.total) * 100) : null;
  return (
    <div className="setup-layout">
      <div className="setup-art">
        <img src={assets.hero} alt="" />
        <div>
          <h1>Back to the game.</h1>
          <p>
            Your CS:GO inventory, matches and community.
            <br />
            One place to get ready.
          </p>
        </div>
      </div>
      <div className="setup-tasks">
        <h2>Let’s get you ready</h2>
        <p className="muted">
          Connect your account and install CS:GO. B2G takes care of the game
          integration.
        </p>
        <Feedback
          error={
            action.error || error ||
            s.installError ||
            (!s.pairing && !status.paired ? s.message : "")
          }
          {...(error ? { retry: refresh } : {})}
        />
        <section className="setup-task">
          <div className="setup-task-heading">
            <h3>CS:GO installation</h3>
            <span className={`status-badge ${i.ready ? "completed" : ""}`}>
              {s.preparing
                ? "Finishing setup"
                : i.ready
                  ? "Ready"
                  : s.installing
                    ? "Installing"
                    : "Needed"}
            </span>
          </div>
          {i.ready && !s.installing ? (
            <p className="muted">CS:GO is installed on this PC.</p>
          ) : (
            <>
              <p>
                {s.preparing
                  ? "Preparing B2G’s game files. Keep the launcher open."
                  : s.installing
                    ? !i.steamAvailable
                      ? "Finish installing Steam in the window that opened. B2G will continue automatically."
                      : progress !== null
                        ? `Downloading CS:GO through Steam. ${progress.toFixed(0)}% complete.`
                        : "Confirm the CS:GO download in Steam. B2G will continue automatically."
                    : i.detail}
              </p>
              {s.installing && progress !== null && (
                <>
                  <progress
                    aria-label="CS:GO download progress"
                    max={100}
                    value={progress}
                  />
                  <small>
                    {(i.downloaded / 1e9).toFixed(1)} /{" "}
                    {(i.total / 1e9).toFixed(1)} GB
                  </small>
                </>
              )}
              <div className="actions">
                {!s.installing ? (
                  <button
                    className="primary"
                    disabled={!!action.busy || status.gameOpen}
                    onClick={() => void task("install")}
                  >
                    <Download size={17} />
                    Install CS:GO
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary"
                      onClick={() => void task("open_steam")}
                    >
                      <ExternalLink size={16} />
                      Open Steam
                    </button>
                    <button
                      className="text-button"
                      disabled={s.preparing}
                      onClick={() => void task("stop_install")}
                    >
                      Stop waiting
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </section>
        <section className="setup-task">
          <div className="setup-task-heading">
            <h3>Your B2G account</h3>
            <span
              className={`status-badge ${status.paired && !needsProfile && !loadingProfile ? "completed" : ""}`}
            >
              {s.pairing
                ? "Waiting for Steam"
                : loadingProfile
                  ? error ? "Sync paused" : "Loading profile"
                  : needsProfile
                  ? "Finish profile"
                  : status.paired
                    ? "Connected"
                    : "Needed"}
            </span>
          </div>
          {s.pairing ? (
            <>
              <p>
                Approve the connection in your browser. Steam handles your
                sign-in securely.
              </p>
              {s.pairCode && (
                <div className="pair-code">
                  <span>Match this code</span>
                  <strong>{s.pairCode}</strong>
                </div>
              )}
              <div className="actions">
                {s.pairUrl && (
                  <button
                    className="secondary"
                    onClick={() => void task("open_link", { url: s.pairUrl })}
                  >
                    Reopen sign-in <ArrowUpRight size={16} />
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => void task("cancel_pair")}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : !status.paired ? (
            <>
              <p className="muted">
                Use Steam to sign in or create a B2G account. Your Steam
                password stays with Steam.
              </p>
              <button
                className="primary"
                disabled={!!action.busy}
                onClick={() => void task("pair")}
              >
                Continue with Steam <ArrowUpRight size={16} />
              </button>
            </>
          ) : loadingProfile ? (
            <p className="muted">
              {error
                ? "Your account is connected. Retry to load your B2G profile."
                : "Loading your B2G profile. Your setup will continue here."}
            </p>
          ) : needsProfile ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await task("onboard", {
                  displayName: name.trim(),
                  region,
                });
                if (result) refresh();
              }}
            >
              <label>
                B2G player name
                <input
                  id="setup-name"
                  value={name}
                  maxLength={20}
                  required
                  minLength={3}
                  pattern="[A-Za-z0-9_-]{3,20}"
                  autoComplete="nickname"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <small>3–20 letters, numbers, underscores or hyphens.</small>
              <label>
                Your region
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                >
                  {regionList.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={!!action.busy}>
                {action.busy ? <Spinner /> : <Check size={17} />}Create B2G
                profile
              </button>
            </form>
          ) : (
            <p className="muted">
              Connected as{" "}
              <strong>
                {display(player?.displayName, "your Steam account")}
              </strong>
              . Your items and progress stay with this account.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function settingValues(p: Data) {
  return { ...p.settings, region: p.region };
}
export function Settings({
  status,
  rankId,
  scope,
  active,
  refresh,
}: {
  status: Status;
  rankId?: number | undefined;
  scope: string;
  active: boolean;
  refresh: () => void;
}) {
  const account = useRemote(`${scope}:account`, "account", {}, active && status.paired);
  const [draft, setDraft] = useState<Data | null>(status.paired ? null : {});
  const [saved, setSaved] = useState<Data | null>(status.paired ? null : {});
  const [section, setSection] = useState(status.paired ? "account" : "launcher");
  const action = useAction();
  const [confirm, setConfirm] = useState<"logout" | "uninstall" | null>(null);
  const [diagnostics, setDiagnostics] = useState<Data | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    if (account.data?.settings) {
      const next = settingValues(account.data);
      setSaved(next);
      setDraft((previous) => (previous && dirty ? previous : next));
    }
  }, [account.data]);
  const update = (key: string, v: unknown) =>
    setDraft((d) => ({ ...d, [key]: v }));
  const blocked =
    status.gameOpen ||
    ["starting", "running"].includes(status.session.phase) ||
    status.session.installing ||
    status.session.preparing;
  const save = async () => {
    const result = await action.run(
      "settings",
      { settings: draft },
      "Settings saved.",
    );
    if (result) {
      const next = settingValues(result);
      setSaved(next);
      setDraft(next);
      invalidate();
    }
  };
  const perform = async (op: string, args: Data = {}, notice?: string) => {
    const result = await action.run(op, args, notice);
    refresh();
    return result;
  };
  return (
    <div className="workspace">
      <PageTitle
        title="Settings"
        description="Your account, preferences and launcher tools."
      />
      <div className="workspace-grid">
        <aside className="sidebar" aria-label="Settings sections">
          {[
            ["account", "Account", UserRound],
            ["matchmaking", "Matchmaking", SlidersHorizontal],
            ["privacy", "Privacy & notifications", ShieldCheck],
            ["launcher", "Launcher", Monitor],
          ].filter(([key]) => status.paired || key === "launcher").map(([key, label, Icon]: any) => (
            <button
              key={key}
              className={section === key ? "selected" : ""}
              onClick={() => setSection(key)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </aside>
        <div className="workspace-main settings-main">
          <Feedback
            error={action.error || account.error}
            notice={action.notice}
            retry={account.refresh}
          />
          {(status.paired && !account.data) || !draft ? (
            <Loading label="Loading account preferences" />
          ) : (
            <>
              {section === "account" && account.data && (
                <>
                  <div className="account-identity">
                    <Avatar
                      name={account.data?.displayName}
                      icon={status.profileIcon}
                      rank={rankId}
                      size={64}
                    />
                    <div>
                      <h2>{account.data.displayName}</h2>
                      <span>
                        Steam linked · {display(account.data.steamId)}
                      </span>
                    </div>
                  </div>
                  <Setting
                    title="Profile picture"
                    description="This picture is saved on this PC."
                  >
                    <div className="avatar-options">
                      {["portrait", "rank", "blue", "green", "gold"].map(
                        (icon) => (
                          <button
                            aria-label={`Use ${icon} profile picture`}
                            aria-pressed={status.profileIcon === icon}
                            className={
                              status.profileIcon === icon ? "selected" : ""
                            }
                            key={icon}
                            onClick={() =>
                              void perform("profile_icon", { icon })
                            }
                          >
                            <Avatar
                              name={account.data?.displayName}
                              icon={icon}
                              rank={rankId}
                              size={40}
                            />
                          </button>
                        ),
                      )}
                    </div>
                  </Setting>
                  <Setting
                    title="B2G player ID"
                    description="Your permanent account identifier."
                  >
                    <div className="id-copy">
                      <code>{account.data.id}</code>
                      <CopyButton value={account.data.id} />
                    </div>
                  </Setting>
                  <Setting
                    title="Connected account"
                    description="Your items, match results and progress stay with this account."
                  >
                    <button
                      className="secondary"
                      disabled={blocked || !!action.busy}
                      onClick={() => setConfirm("logout")}
                    >
                      <LogOut size={16} />
                      Sign out
                    </button>
                  </Setting>
                  {blocked && (
                    <p className="muted small">
                      Close CS:GO before switching accounts.
                    </p>
                  )}
                </>
              )}
              {section === "matchmaking" && (
                <>
                  <h2>Matchmaking</h2>
                  <Setting
                    title="Preferred region"
                    description="Used for your in-game matchmaking connection."
                  >
                    <select
                      aria-label="Preferred region"
                      value={draft.region}
                      onChange={(e) => update("region", e.target.value)}
                    >
                      {regionList.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </Setting>
                  <Setting
                    title="Website default mode"
                    description="Your in-game mode is chosen inside CS:GO."
                  >
                    <select
                      aria-label="Website default mode"
                      value={draft.preferredMode}
                      onChange={(e) => update("preferredMode", e.target.value)}
                    >
                      <option value="competitive">Competitive</option>
                      <option value="deathmatch">Deathmatch</option>
                    </select>
                  </Setting>
                  <Toggle
                    title="Party invitations"
                    description="Allow other players to invite you to a party."
                    value={draft.allowPartyInvites}
                    change={(v) => update("allowPartyInvites", v)}
                  />
                </>
              )}
              {section === "privacy" && (
                <>
                  <h2>Privacy & notifications</h2>
                  <Setting
                    title="Profile visibility"
                    description="Choose who can see your linked account and match statistics."
                  >
                    <select
                      aria-label="Profile visibility"
                      value={draft.profileVisibility}
                      onChange={(e) =>
                        update("profileVisibility", e.target.value)
                      }
                    >
                      <option value="public">Public</option>
                      <option value="private">Private</option>
                    </select>
                  </Setting>
                  <Toggle
                    title="Match notifications"
                    description="Receive notifications about your matches."
                    value={draft.matchNotifications}
                    change={(v) => update("matchNotifications", v)}
                  />
                  <Toggle
                    title="Product updates"
                    description="Receive B2G update notifications."
                    value={draft.productUpdates}
                    change={(v) => update("productUpdates", v)}
                  />
                </>
              )}
              {section === "launcher" && (
                <>
                  <h2>Launcher preferences</h2>
                  {status.paired && <Toggle
                    title="Reduce motion"
                    description="Keep transitions and loading indicators still."
                    value={draft.reducedMotion}
                    change={(v) => {
                      update("reducedMotion", v);
                      document.documentElement.dataset.reducedMotion =
                        String(v);
                    }}
                  />}
                  <Toggle
                    title="Debug console"
                    description="Show diagnostic output for this session. Logs are saved while hidden."
                    value={status.debugConsole}
                    change={(v) =>
                      void perform("debug_console", { visible: v })
                    }
                  />
                  <Setting
                    title="Diagnostics"
                    description="Inspect your game installation and launcher log."
                  >
                    <div className="actions">
                      <button
                        className="secondary"
                        onClick={() => void perform("open_log")}
                      >
                        Open log
                      </button>
                      <button
                        className="secondary"
                        disabled={!!action.busy}
                        onClick={async () => {
                          const result = await perform("diagnostics");
                          if (result) setDiagnostics(result);
                        }}
                      >
                        {action.busy === "diagnostics" ? <Spinner /> : null}Run
                        diagnostics
                      </button>
                    </div>
                  </Setting>
                  <Setting
                    title="Repair B2G game files"
                    description="Verify and repair the B2G integration. Your Steam game, settings and demos are kept."
                  >
                    <button
                      className="secondary"
                      disabled={blocked || !!action.busy}
                      onClick={() =>
                        void perform("repair", {}, "B2G game files repaired.")
                      }
                    >
                      <Wrench size={16} />
                      {action.busy === "repair" ? "Repairing" : "Repair"}
                    </button>
                  </Setting>
                  <Setting
                    title="Remove B2G"
                    description="Remove the B2G launcher and game integration. Keep Steam CS:GO, settings and demos."
                  >
                    <button
                      className="danger-button"
                      disabled={blocked || !!action.busy}
                      onClick={() => setConfirm("uninstall")}
                    >
                      Uninstall B2G
                    </button>
                  </Setting>
                  {blocked && (
                    <p className="muted small">
                      Close CS:GO before repairing or removing B2G.
                    </p>
                  )}
                </>
              )}
              {dirty && (
                <div className="save-bar">
                  <span>You have unsaved changes.</span>
                  <button
                    className="secondary"
                    disabled={!!action.busy}
                    onClick={() => {
                      setDraft(saved);
                      document.documentElement.dataset.reducedMotion = String(
                        saved?.reducedMotion,
                      );
                    }}
                  >
                    Discard changes
                  </button>
                  <button
                    className="primary"
                    disabled={!!action.busy}
                    onClick={() => void save()}
                  >
                    {action.busy === "settings" ? (
                      <Spinner />
                    ) : (
                      <Check size={16} />
                    )}
                    Save settings
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {confirm && (
        <Dialog
          title={confirm === "logout" ? "Sign out of B2G?" : "Uninstall B2G?"}
          onClose={() => setConfirm(null)}
        >
          <p>
            {confirm === "logout"
              ? "Your items and progress remain on this B2G account. You can connect another Steam account afterwards."
              : "This removes the B2G launcher and its integration from CS:GO. Steam CS:GO, settings and demos are preserved."}
          </p>
          <Feedback error={action.error} />
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={!!action.busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={!!action.busy || blocked}
              onClick={async () => {
                const result = await action.run(confirm);
                if (result !== undefined) {
                  setConfirm(null);
                  if (confirm === "uninstall") void getCurrentWindow().close();
                  else {
                    disconnectAccount();
                  }
                }
              }}
            >
              {action.busy ? <Spinner /> : null}
              {confirm === "logout" ? "Sign out" : "Uninstall B2G"}
            </button>
          </div>
        </Dialog>
      )}
      {diagnostics && (
        <Dialog
          title="Game diagnostics"
          wide
          onClose={() => setDiagnostics(null)}
        >
          <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
        </Dialog>
      )}
    </div>
  );
}
function Setting({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
function Toggle({
  title,
  description,
  value,
  change,
}: {
  title: string;
  description: string;
  value: boolean;
  change: (v: boolean) => void;
}) {
  return (
    <Setting title={title} description={description}>
      <label className="switch-control">
        <input
          role="switch"
          type="checkbox"
          aria-label={title}
          checked={!!value}
          onChange={(e) => change(e.target.checked)}
        />
        <span>{value ? "On" : "Off"}</span>
      </label>
    </Setting>
  );
}

export function MatchHistory({
  scope,
  active,
}: {
  scope: string;
  active: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const page = useRemote(
    `${scope}:matches:${offset}`,
    "matches",
    { offset },
    active,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useRemote(
    `${scope}:match:${selected}`,
    "match",
    { id: selected },
    !!selected,
  );
  const action = useAction();
  const [downloaded, setDownloaded] = useState(new Set<string>());
  const entries = page.data?.entries || [];
  return (
    <div className="workspace">
      <PageTitle
        title="Match history"
        description={
          page.data
            ? `${page.data.total} completed matches`
            : "Your completed Competitive and Deathmatch games."
        }
      />
      <Feedback error={page.error} retry={page.refresh} />
      {!page.data ? (
        <Loading label="Loading your matches" />
      ) : !entries.length ? (
        <Empty title="Your first match is waiting">
          Completed matches and demo downloads will appear here after you play.
        </Empty>
      ) : (
        <>
          <MatchTable
            entries={entries}
            onSelect={(entry) => setSelected(entry.matchId || entry.id)}
          />
          <Pager
            offset={offset}
            total={page.data.total}
            limit={12}
            onChange={setOffset}
          />
        </>
      )}
      {selected && (
        <Dialog
          title="Match details"
          wide
          onClose={() => {
            setSelected(null);
            action.setError("");
            action.setNotice("");
          }}
        >
          <Feedback
            error={detail.error || action.error}
            notice={action.notice}
            retry={detail.refresh}
          />
          {!detail.data ? (
            <Loading label="Loading match details" />
          ) : (
            <>
              <MatchDetails data={detail.data} />
              <div className="dialog-actions">
                {detail.data.demo?.available ? (
                  <button
                    className="primary"
                    disabled={!!action.busy}
                    onClick={async () => {
                      if (downloaded.has(selected)) {
                        await action.run("open_demos");
                      } else {
                        const result = await action.run(
                          "demo",
                          { id: selected },
                          "Demo downloaded and verified.",
                        );
                        if (result)
                          setDownloaded(new Set([...downloaded, selected]));
                      }
                    }}
                  >
                    {action.busy ? (
                      <Spinner />
                    ) : downloaded.has(selected) ? (
                      <FolderOpen size={17} />
                    ) : (
                      <Download size={17} />
                    )}{" "}
                    {downloaded.has(selected)
                      ? "Open demo folder"
                      : action.busy
                        ? "Downloading & verifying"
                        : "Download demo"}
                  </button>
                ) : (
                  <span className="muted">
                    No demo is available for this match.
                  </span>
                )}
              </div>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
export function MatchTable({
  entries,
  onSelect,
}: {
  entries: Data[];
  onSelect?: (m: Data) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="match-table">
        <thead>
          <tr>
            <th>Map / mode</th>
            <th>Played</th>
            <th>Result</th>
            <th>K / D</th>
            <th>ADR</th>
            <th>ELO</th>
            {onSelect && (
              <th>
                <span className="sr-only">Details</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={entry.matchId || entry.id || i}>
              <td>
                <strong>{display(entry.map)}</strong>
                <small>
                  {entry.mode === "deathmatch" ? "Deathmatch" : "Competitive"}
                </small>
              </td>
              <td>{date(entry.playedAt || entry.completedAt)}</td>
              <td>
                <span className={`result ${entry.outcome}`}>
                  {display(entry.outcome)}
                </span>
                <span>{display(entry.score || entry.teamScore, "")}</span>
              </td>
              <td className="numeric">
                {display(entry.kills, 0)} / {display(entry.deaths, 0)}
              </td>
              <td className="numeric">{Number(entry.adr || 0).toFixed(1)}</td>
              <td className="numeric">
                {entry.mode === "deathmatch"
                  ? "Unrated"
                  : `${Number(entry.ratingDelta ?? entry.eloDelta ?? 0) > 0 ? "+" : ""}${display(entry.ratingDelta ?? entry.eloDelta, 0)}`}
              </td>
              {onSelect && (
                <td>
                  <button
                    className="text-button"
                    aria-label={`View match on ${entry.map}`}
                    onClick={() => onSelect(entry)}
                  >
                    Details <ArrowUpRight size={14} />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function MatchDetails({ data }: { data: Data }) {
  const m = data.match || data;
  const people = data.teams
    ? [
        ...(data.teams.alpha || []),
        ...(data.teams.bravo || []),
        ...(data.teams.ffa || []),
      ]
    : data.players || data.participants || [];
  return (
    <>
      <div className="match-summary">
        <h3>{display(m.map, "Match")}</h3>
        <span>
          {m.mode === "deathmatch" ? "Deathmatch" : "Competitive"} ·{" "}
          {date(m.endedAt || m.completedAt || m.playedAt)}
        </span>
      </div>
      {people.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Kills</th>
                <th>Deaths</th>
                <th>Assists</th>
                <th>ADR</th>
                <th title="Kill, assist, survive or traded rounds">KAST</th>
                <th>ELO change</th>
                <th>Openings</th>
                <th>Trades</th>
                <th>Clutches</th>
                <th>Flash assists</th>
                <th>Utility damage</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p: Data, i: number) => (
                <tr key={p.playerId || i}>
                  <td>{display(p.displayName || p.name)}</td>
                  <td>{display(p.kills, 0)}</td>
                  <td>{display(p.deaths, 0)}</td>
                  <td>{display(p.assists, 0)}</td>
                  <td>{display(p.adr, 0)}</td>
                  <td>{display(p.kast)}</td>
                  <td>{display(p.ratingDelta)}</td>
                  <td>
                    {display(p.openingKills, 0)} / {display(p.openingDeaths, 0)}
                  </td>
                  <td>{display(p.trades, 0)}</td>
                  <td>{display(p.clutches, 0)}</td>
                  <td>{display(p.flashAssists, 0)}</td>
                  <td>{display(p.utilityDamage, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <dl className="detail-grid">
          {Object.entries(m)
            .filter(
              ([key, value]) =>
                !["id", "demo"].includes(key) &&
                ["string", "number"].includes(typeof value),
            )
            .map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                <dd>{display(value)}</dd>
              </div>
            ))}
        </dl>
      )}
    </>
  );
}
