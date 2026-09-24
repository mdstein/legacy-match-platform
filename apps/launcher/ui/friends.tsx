import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Search,
  UserPlus,
  Users,
} from "lucide-react";
import {
  call,
  date,
  display,
  errorText,
  useAction,
  useRemote,
  type Data,
} from "./api";
import { rankImage } from "./assets";
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
import { MatchTable } from "./pages";
export function Friends({
  scope,
  active,
  profileIcon,
  rankId,
}: {
  scope: string;
  active: boolean;
  profileIcon: string;
  rankId?: number | undefined;
}) {
  const [folder, setFolder] = useState("friends");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const [mode, setMode] = useState("competitive");
  const [matchOffset, setMatchOffset] = useState(0);
  const list = useRemote(
    `${scope}:friends:${folder}:${search}:${offset}`,
    "friends",
    { folder, query: search, offset },
    active,
    5000,
  );
  const profile = useRemote(
    `${scope}:profile:${target}:${mode}:${matchOffset}`,
    "profile",
    { id: target, mode, offset: matchOffset },
    active && !!target,
    5000,
  );
  const [confirm, setConfirm] = useState(false);
  const action = useAction();
  const [pending, setPending] = useState<Data | null>(null);
  const who = profile.data?.player;
  const view = (id: string) => {
    setTarget(id);
    setMatchOffset(0);
    setMode("competitive");
    setConfirm(false);
    action.setError("");
    action.setNotice("");
  };
  const mutate = async (kind: string) => {
    if (!who || action.busy) return;
    const request = pending || {
      action: kind,
      playerId: who.playerId,
      requestId: kind === "add" ? crypto.randomUUID() : who.requestId,
    };
    setPending(request);
    const result = await action.run(
      "friend_action",
      request,
      "Friend list updated.",
    );
    if (result !== undefined) {
      setPending(null);
      setConfirm(false);
      if (result?.rejected) {
        action.setNotice("");
        action.setError(result.message);
      }
      await Promise.all([list.refresh(), profile.refresh()]);
    }
  };
  const relationship = who?.relationship;
  const label =
    relationship === "none"
      ? "Add friend"
      : relationship === "incoming"
        ? "Accept request"
        : relationship === "outgoing"
          ? "Cancel request"
          : relationship === "friends"
            ? "Remove friend"
            : null;
  return (
    <div className="workspace">
      <PageTitle
        title="Friends"
        description="Find your people. Keep your next match close."
      >
        <button
          className="primary"
          onClick={() => {
            setFolder("search");
            setTarget(null);
            setOffset(0);
            setSearch("");
            setQuery("");
          }}
        >
          <UserPlus size={17} />
          Find a player
        </button>
      </PageTitle>
      <div className="workspace-grid">
        <aside className="sidebar" aria-label="Friends sections">
          {[
            ["friends", "Friends"],
            ["incoming", "Requests"],
            ["outgoing", "Sent requests"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={!target && folder === key ? "selected" : ""}
              onClick={() => {
                setFolder(key!);
                setTarget(null);
                setOffset(0);
                setSearch("");
              }}
            >
              <Users size={17} />
              <span>{label}</span>
              {key === "incoming" && list.data?.incomingCount > 0 && (
                <b className="count">{list.data?.incomingCount}</b>
              )}
            </button>
          ))}
          <button
            className={target === "me" ? "selected" : ""}
            onClick={() => view("me")}
          >
            <Avatar name="" icon={profileIcon} rank={rankId} size={18} />
            <span>My profile</span>
          </button>
        </aside>
        <div className="workspace-main">
          <Feedback
            error={action.error || list.error || profile.error}
            notice={action.notice}
            retry={() => {
              void list.refresh();
              void profile.refresh();
            }}
          />
          {pending && action.error && (
            <div className="recovery">
              <p>
                The previous friend action may have reached B2G. Retry the same
                request to recover its result.
              </p>
              <button
                className="secondary"
                disabled={!!action.busy}
                onClick={() => void mutate(pending.action)}
              >
                Retry pending action
              </button>
            </div>
          )}
          {target ? (
            <>
              <button className="back-button" onClick={() => setTarget(null)}>
                <ArrowLeft size={16} />
                Back to friends
              </button>
              {!profile.data ? (
                <Loading label="Loading player profile" />
              ) : (
                <>
                  <div className="player-profile-head">
                    <Avatar
                      name={who?.displayName}
                      icon={
                        who?.relationship === "self" ? profileIcon : undefined
                      }
                      rank={rankId}
                      size={72}
                    />
                    <div>
                      <h2>{display(who?.displayName, "B2G player")}</h2>
                      <span className={who?.online ? "online" : "muted"}>
                        {who?.online
                          ? "Online in B2G"
                          : who?.private
                            ? "Private profile"
                            : "Offline"}
                      </span>
                    </div>
                    {label && (
                      <div className="actions">
                        <button
                          className={
                            ["none", "incoming"].includes(relationship)
                              ? "primary"
                              : "secondary"
                          }
                          disabled={!!action.busy || !!pending}
                          onClick={() =>
                            relationship === "friends"
                              ? setConfirm(true)
                              : void mutate(
                                  relationship === "none"
                                    ? "add"
                                    : relationship === "incoming"
                                      ? "accept"
                                      : "cancel",
                                )
                          }
                        >
                          {action.busy ? (
                            <Spinner />
                          ) : relationship === "none" ? (
                            <UserPlus size={17} />
                          ) : null}
                          {label}
                        </button>
                        {relationship === "incoming" && (
                          <button
                            className="secondary"
                            disabled={!!action.busy || !!pending}
                            onClick={() => void mutate("decline")}
                          >
                            Decline
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {who?.private ? (
                    <Empty title="This profile is private">
                      You can still manage your friendship with this player.
                    </Empty>
                  ) : (
                    <>
                      <div className="profile-meta">
                        <span>
                          {display(profile.data.region)} · Member since{" "}
                          {date(profile.data.memberSince)} · Level{" "}
                          {display(profile.data.level)}
                        </span>
                        <CopyButton
                          value={who?.playerId || ""}
                          label="Copy player ID"
                        />
                      </div>
                      <div className="profile-overview">
                        <div className="profile-rating">
                          {rankImage(profile.data.rankId) && (
                            <img
                              src={rankImage(profile.data.rankId)}
                              alt="Competitive rank"
                            />
                          )}
                          <div>
                            <strong>
                              {display(profile.data.rank?.rating, 0)}{" "}
                              <span>ELO</span>
                            </strong>
                            <p>
                              {display(profile.data.rank?.name, "Unranked")}
                            </p>
                          </div>
                        </div>
                        {profile.data.steamProfileUrl ? (
                          <button
                            className="secondary linked-account"
                            onClick={() =>
                              void action.run("open_link", {
                                url: profile.data!.steamProfileUrl,
                              })
                            }
                          >
                            <Check size={17} />
                            Steam linked <ExternalLink size={15} />
                          </button>
                        ) : (
                          <span className="muted">Steam not linked</span>
                        )}
                      </div>
                      <div className="segmented" aria-label="Profile game mode">
                        {["competitive", "deathmatch"].map((m) => (
                          <button
                            key={m}
                            aria-pressed={mode === m}
                            className={mode === m ? "selected" : ""}
                            onClick={() => {
                              setMode(m);
                              setMatchOffset(0);
                            }}
                          >
                            {m === "competitive" ? "Competitive" : "Deathmatch"}
                          </button>
                        ))}
                      </div>
                      <div className="profile-stats">
                        {[
                          [
                            "Games played",
                            profile.data.stats?.gamesPlayed ?? 0,
                          ],
                          [
                            "Win rate",
                            profile.data.stats?.gamesPlayed
                              ? `${profile.data.stats.winRate}%`
                              : "—",
                          ],
                          [
                            "K / D",
                            profile.data.stats?.gamesPlayed
                              ? Number(profile.data.stats.kdRatio).toFixed(2)
                              : "—",
                          ],
                          [
                            "Average damage / round",
                            profile.data.stats?.gamesPlayed
                              ? Number(profile.data.stats.averageAdr).toFixed(1)
                              : "—",
                          ],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <span>{label}</span>
                            <strong>{value}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="subheading">
                        <h3>Recent matches</h3>
                        <span>
                          {profile.data.stats?.wins ?? 0} wins ·{" "}
                          {profile.data.stats?.losses ?? 0} losses ·{" "}
                          {profile.data.stats?.draws ?? 0} draws
                        </span>
                      </div>
                      {profile.data.recentMatches?.length ? (
                        <>
                          <MatchTable entries={profile.data.recentMatches} />
                          <Pager
                            offset={matchOffset}
                            total={profile.data.matchTotal || 0}
                            limit={5}
                            onChange={setMatchOffset}
                          />
                        </>
                      ) : (
                        <Empty title="No matches in this mode yet">
                          Completed matches and statistics will appear here.
                        </Empty>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <div className="subheading">
                <h2>
                  {folder === "search"
                    ? "Find a player"
                    : folder === "incoming"
                      ? "Friend requests"
                      : folder === "outgoing"
                        ? "Sent requests"
                        : `Your friends${list.data ? ` · ${list.data.friendCount}` : ""}`}
                </h2>
              </div>
              {folder === "search" && (
                <form
                  className="search-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setSearch(query.trim());
                    setOffset(0);
                  }}
                >
                  <label className="search-field">
                    <Search size={18} />
                    <input
                      autoFocus
                      aria-label="Find a player"
                      value={query}
                      maxLength={100}
                      placeholder="Name, B2G player ID or trade code"
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={query.trim().length < 2}
                  >
                    Search
                  </button>
                </form>
              )}
              {!list.data ? (
                <Loading label="Loading friends" />
              ) : folder === "search" && !search ? (
                <Empty title="Find someone to play with">
                  Search for a B2G player by name or ask them for their player
                  ID.
                </Empty>
              ) : list.data.entries?.length ? (
                <>
                  <div className="player-results">
                    {list.data.entries.map((p: Data) => (
                      <button
                        className="player-row"
                        key={p.playerId}
                        onClick={() => view(p.playerId)}
                      >
                        <Avatar name={p.displayName} />
                        <div>
                          <strong>{p.displayName}</strong>
                          <span>
                            {p.relationship === "incoming"
                              ? "Wants to be your friend"
                              : p.relationship === "outgoing"
                                ? "Request sent"
                                : p.online
                                  ? "Online in B2G"
                                  : "Offline"}
                          </span>
                        </div>
                        <span className="row-action">
                          View profile <ArrowRight size={16} />
                        </span>
                      </button>
                    ))}
                  </div>
                  <Pager
                    offset={offset}
                    total={list.data.total}
                    limit={8}
                    onChange={setOffset}
                  />
                </>
              ) : (
                <Empty
                  title={
                    folder === "incoming"
                      ? "No requests waiting"
                      : folder === "outgoing"
                        ? "No sent requests"
                        : folder === "search"
                          ? "No players found"
                          : "Your friends will appear here"
                  }
                >
                  {folder === "friends"
                    ? "Find a player and send your first friend request."
                    : folder === "search"
                      ? "Try a different name or player ID."
                      : "New requests will appear here automatically."}
                </Empty>
              )}
            </>
          )}
        </div>
      </div>
      {confirm && (
        <Dialog
          title={`Remove ${display(who?.displayName)} from friends?`}
          onClose={() => setConfirm(false)}
        >
          <p>You can send another friend request later.</p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setConfirm(false)}>
              Keep friend
            </button>
            <button
              className="danger-button"
              disabled={!!action.busy}
              onClick={() => void mutate("remove")}
            >
              Remove friend
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
