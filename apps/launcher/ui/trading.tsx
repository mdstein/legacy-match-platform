import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  Check,
  ChevronRight,
  Inbox,
  Info,
  Plus,
  Search,
  Send,
  Package,
  LockKeyhole,
  X,
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
import {
  Avatar,
  CopyButton,
  Dialog,
  Empty,
  Feedback,
  Loading,
  PageTitle,
  Spinner,
} from "./components";

type Item = Data & {
  assetId: string;
  ownerId: string;
  displayName: string;
  fingerprint: string;
  tradable: boolean;
  rarity: number;
};
type Draft = {
  partner: Data;
  selected: Record<string, Item>;
  message: string;
  review: boolean;
  gift: boolean;
  counter?: { id: string; revision: number };
};
const rarity = [
  "#a7a7a7",
  "#b0c3d9",
  "#5e98d9",
  "#4b69ff",
  "#8847ff",
  "#d32ce6",
  "#eb4b4b",
  "#e4ae39",
];
const condition = (i: Item) =>
  i.paintWear == null
    ? i.itemKind === "case"
      ? "Unopened container"
      : "Collectible"
    : i.paintWear < 0.07
      ? "Factory New"
      : i.paintWear < 0.15
        ? "Minimal Wear"
        : i.paintWear < 0.38
          ? "Field-Tested"
          : i.paintWear < 0.45
            ? "Well-Worn"
            : "Battle-Scarred";
function ItemTile({
  item,
  selected,
  onSelect,
  onInspect,
}: {
  item: Item;
  selected?: boolean;
  onSelect?: (i: Item) => void;
  onInspect: (i: Item) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className={`item-tile ${selected ? "selected" : ""} ${!item.tradable ? "bound" : ""}`}
      style={
        { "--rarity": rarity[item.rarity] || rarity[0] } as React.CSSProperties
      }
    >
      <button
        className="item-main"
        onClick={() => (onSelect ? onSelect(item) : onInspect(item))}
        disabled={!!onSelect && !item.tradable}
        aria-pressed={onSelect ? !!selected : undefined}
        aria-label={`${selected ? "Remove" : "Select"} ${item.displayName}${!item.tradable ? " — account-bound" : ""}`}
      >
        <div className="item-art">
          {item.imageUrl && !failed ? (
            <img
              src={
                item.imageUrl.startsWith("/trading-items/")
                  ? `https://play.back2go.net${item.imageUrl}`
                  : item.imageUrl
              }
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
            />
          ) : (
            <Package size={30} aria-hidden="true" />
          )}
          {selected && (
            <span className="selection-mark">
              <Check size={14} />
            </span>
          )}
        </div>
        <strong>
          {item.statTrak && <span className="stattrak">StatTrak™ </span>}
          {item.displayName}
        </strong>
        <span className="item-condition">
          {!item.tradable ? (
            <>
              <LockKeyhole size={11} />
              Account-bound
            </>
          ) : (
            condition(item)
          )}
        </span>
      </button>
      <button
        className="item-info"
        aria-label={`Details for ${item.displayName}`}
        title="Item details"
        onClick={() => onInspect(item)}
      >
        <Info size={15} />
      </button>
    </div>
  );
}
function ItemDetails({ item, onClose }: { item: Item; onClose: () => void }) {
  return (
    <Dialog title={item.displayName} onClose={onClose}>
      <p>{condition(item)}</p>
      <dl className="detail-grid">
        {[
          ["Wear", item.paintWear],
          ["Pattern", item.paintSeed],
          ["Finish", item.paintIndex],
          ["Name tag", item.customName],
          ["Item ID", item.assetId],
        ]
          .filter(([, v]) => v != null)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{display(v)}</dd>
            </div>
          ))}
      </dl>
      {item.statTrak && (
        <p className="notice">
          StatTrak: {item.statTrakCount || 0} kills. The counter resets to 0 for
          its new owner.
        </p>
      )}
      {item.restriction && <p>{item.restriction}</p>}
      {item.stickers?.length > 0 && (
        <>
          <h3>Stickers</h3>
          <ul>
            {item.stickers.map((s: Data) => (
              <li key={s.slot}>
                Slot {s.slot + 1}: #{s.stickerId} · wear {display(s.wear, 0)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

export function Trading({ scope, active }: { scope: string; active: boolean }) {
  const overview = useRemote(
    `${scope}:trade:overview`,
    "trade_overview",
    {},
    active,
    5000,
  );
  const me = overview.data?.player?.playerId || scope;
  const [folder, setFolder] = useState("incoming");
  const [cursor, setCursor] = useState<string | null>(null);
  const offers = useRemote(
    `${scope}:offers:${folder}:${cursor}`,
    "trade_offers",
    { folder, cursor },
    active && !!overview.data,
    5000,
  );
  const pending = useRemote(
    `${scope}:trade:pending`,
    "trade_pending",
    { playerId: me },
    active && !!overview.data,
    5000,
  );
  const [mode, setMode] = useState<"offers" | "find" | "draft" | "offer">(
    "offers",
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [offerId, setOfferId] = useState("");
  const offer = useRemote(
    `${scope}:offer:${offerId}`,
    "trade_offer",
    { id: offerId },
    active && mode === "offer" && !!offerId,
    5000,
  );
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const players = useRemote<Data[]>(
    `${scope}:trade:players:${submitted}`,
    "trade_players",
    { query: submitted },
    active && mode === "find" && submitted.length >= 2,
  );
  const [inspect, setInspect] = useState<Item | null>(null);
  const [gift, setGift] = useState(false);
  const [history, setHistory] = useState<Data | null>(null);
  const action = useAction();
  const recoveryUnchecked = pending.data === undefined || !!pending.error;
  useEffect(() => {
    if (
      active &&
      offers.data &&
      overview.data?.latestEventId &&
      overview.data?.unreadCount > 0
    )
      void call("trade_seen", { eventId: overview.data.latestEventId }).catch(
        () => {},
      );
  }, [active, offers.data, overview.data?.latestEventId]);
  useEffect(() => {
    setGift(false);
  }, [
    offer.data?.id,
    offer.data?.revision,
    JSON.stringify(offer.data?.changedAssetIds),
  ]);
  const firstRevision = useRef<string>("");
  useEffect(() => {
    if (mode === "offer" && offer.data) {
      const version = `${offer.data.id}:${offer.data.revision}`;
      if (firstRevision.current && firstRevision.current !== version)
        action.setNotice(
          "This offer changed. Review the current items before accepting.",
        );
      firstRevision.current = version;
    }
  }, [offer.data?.id, offer.data?.revision, mode]);
  const refresh = async () => {
    await Promise.all([
      overview.refresh(),
      offers.refresh(),
      pending.refresh(),
      offer.refresh(),
    ]);
  };
  const mutate = async (mutation?: Data) => {
    const result = await action.run<Data>("trade_mutate", {
      playerId: me,
      ...(mutation ? { mutation } : { recover: true }),
    });
    await refresh();
    if (result) {
      setOfferId(result.id);
      setMode("offer");
      setDraft(null);
      setGift(false);
      action.setNotice(
        result.status === "completed"
          ? "Trade completed. Your items have been exchanged."
          : result.status === "pending"
            ? "Offer sent. You can follow its status here."
            : `Offer ${result.status}.`,
      );
    }
  };
  const choose = (partner: Data) => {
    setDraft({
      partner,
      selected: {},
      message: "",
      review: false,
      gift: false,
    });
    setMode("draft");
  };
  const newOffer = () => {
    if (draft) {
      setMode("draft");
    } else {
      setMode("find");
      setSubmitted("");
      setQuery("");
    }
    action.setError("");
    action.setNotice("");
  };
  const setSelected = (item: Item) =>
    setDraft((previous) => {
      if (!previous) return previous;
      const selected = { ...previous.selected };
      if (selected[item.assetId]) delete selected[item.assetId];
      else if (
        item.tradable &&
        Object.values(selected).filter((i) => i.ownerId === item.ownerId)
          .length < 50
      )
        selected[item.assetId] = item;
      else {
        action.setError(
          item.restriction || "You can offer up to 50 items per side.",
        );
        return previous;
      }
      return { ...previous, selected, review: false, gift: false };
    });
  const send = () => {
    if (!draft?.review) return;
    const items = Object.values(draft.selected);
    const give = items.filter((i) => i.ownerId === me);
    const receive = items.filter((i) => i.ownerId === draft.partner.playerId);
    const terms = {
      giveAssetIds: give.map((i) => i.assetId),
      receiveAssetIds: receive.map((i) => i.assetId),
      itemFingerprints: Object.fromEntries(
        items.map((i) => [i.assetId, i.fingerprint]),
      ),
      message: draft.message,
      confirmGift: draft.gift,
    };
    void mutate(
      draft.counter
        ? {
            action: "counter",
            offer_id: draft.counter.id,
            revision: draft.counter.revision,
            terms,
          }
        : { action: "send", recipient_id: draft.partner.playerId, terms },
    );
  };
  const o = offer.data;
  const partner = o?.participants?.find((p: Data) => p.playerId !== me);
  const own = o?.senderId === me;
  const complete = o && (!o.itemCount || o.itemCount === o.items?.length);
  const changed = !!o?.changedAssetIds?.length;
  const offeredItems = (o?.items || []) as Item[];
  const isGift =
    offeredItems.length > 0 &&
    offeredItems.every((i) => i.ownerId === offeredItems[0]!.ownerId);
  const canAccept =
    o?.status === "pending" &&
    !own &&
    complete &&
    !changed &&
    offeredItems.length > 0 &&
    (!isGift || gift);
  const selected = draft ? Object.values(draft.selected) : [];
  const draftGift =
    selected.length > 0 &&
    (selected.every((i) => i.ownerId === me) ||
      selected.every((i) => i.ownerId !== me));
  return (
    <div className={`workspace trading-workspace trade-${mode}`}>
      <PageTitle
        title={
          mode === "draft" && draft
            ? draft.review
              ? "Review your trade"
              : `Trade with ${draft.partner.displayName}`
            : "Trading"
        }
        description="Exchange B2G items with other players."
      >
        {mode !== "draft" && (
          <button
            className="primary"
            onClick={newOffer}
            disabled={!overview.data?.enabled || !!action.busy}
          >
            <Plus size={17} />
            {draft ? "Continue draft" : "New trade"}
          </button>
        )}
      </PageTitle>
      <div className="workspace-grid">
        <aside className="sidebar" aria-label="Trade folders">
          {[
            ["incoming", "Received", Inbox],
            ["outgoing", "Sent", Send],
            ["history", "History", ArrowLeftRight],
          ].map(([key, label, Icon]: any) => (
            <button
              key={key}
              className={mode === "offers" && folder === key ? "selected" : ""}
              onClick={() => {
                setFolder(key);
                setCursor(null);
                setMode("offers");
                action.setNotice("");
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
              {key === "incoming" && overview.data?.incomingCount > 0 && (
                <b className="count">{overview.data?.incomingCount}</b>
              )}
            </button>
          ))}
          {overview.data && (
            <div className="trade-identity">
              <span>Your trade code</span>
              <code>{overview.data.player.tradeCode}</code>
              <CopyButton
                value={overview.data.player.tradeCode}
                label="Copy code"
              />
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={overview.data.player.allowOffers}
                  disabled={!!action.busy}
                  onChange={async (e) => {
                    await action.run("trade_preferences", {
                      allow: e.target.checked,
                    });
                    await overview.refresh();
                  }}
                />
                <span>Receive trade offers</span>
              </label>
            </div>
          )}
        </aside>
        <div className="workspace-main">
          <Feedback
            error={action.error || overview.error || pending.error}
            notice={action.notice}
          />
          {pending.data && (
            <div className="recovery">
              <strong>A trade is waiting for confirmation</strong>
              <p>
                The previous request may have reached B2G. Recover its result
                before creating another trade.
              </p>
              <button
                className="primary"
                disabled={!!action.busy}
                onClick={() => void mutate()}
              >
                {action.busy ? <Spinner /> : null}Recover trade
              </button>
            </div>
          )}
          {!overview.data ? (
            <Loading label="Loading your trades" />
          ) : !overview.data.enabled ? (
            <Empty title="Trading is temporarily paused">
              Your items and existing offers are safe. Check back shortly.
            </Empty>
          ) : (
            <>
              {mode === "offers" && (
                <>
                  <div className="subheading">
                    <h2>
                      {folder === "incoming"
                        ? "Received offers"
                        : folder === "outgoing"
                          ? "Sent offers"
                          : "Trade history"}
                    </h2>
                    <span>Updates automatically</span>
                  </div>
                  <Feedback error={offers.error} retry={offers.refresh} />
                  {!offers.data ? (
                    <Loading label="Loading offers" />
                  ) : offers.data.offers?.length ? (
                    <div className="offer-list">
                      {offers.data.offers.map((entry: Data) => {
                        const other = entry.participants?.find(
                          (p: Data) => p.playerId !== me,
                        );
                        return (
                          <button
                            className="offer-row"
                            key={entry.id}
                            onClick={() => {
                              setOfferId(entry.id);
                              setMode("offer");
                              firstRevision.current = "";
                              setGift(false);
                              action.setNotice("");
                            }}
                          >
                            <Avatar name={other?.displayName} />
                            <div className="offer-who">
                              <strong>
                                {display(other?.displayName, "B2G player")}
                              </strong>
                              <span>
                                {entry.senderId === me
                                  ? "You sent an offer"
                                  : "Sent you an offer"}{" "}
                                · {entry.itemCount ?? entry.items?.length ?? 0}{" "}
                                items
                              </span>
                            </div>
                            <div className="offer-date">
                              <span className={`status-badge ${entry.status}`}>
                                {entry.status}
                              </span>
                              <small>{date(entry.updatedAt)}</small>
                            </div>
                            <ChevronRight size={18} />
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <Empty
                      title={
                        folder === "incoming"
                          ? "No offers waiting"
                          : folder === "outgoing"
                            ? "No sent offers"
                            : "Your trade history will appear here"
                      }
                      action={
                        folder !== "history" ? (
                          <button className="secondary" onClick={newOffer}>
                            Start a trade <ArrowRight size={16} />
                          </button>
                        ) : undefined
                      }
                    >
                      {folder === "incoming"
                        ? "Share your trade code or start an offer with another B2G player."
                        : "Completed, cancelled and expired trades stay in your history."}
                    </Empty>
                  )}
                  <div className="pager">
                    {cursor && (
                      <button
                        className="secondary"
                        onClick={() => setCursor(null)}
                      >
                        Latest offers
                      </button>
                    )}
                    {offers.data?.nextCursor && (
                      <button
                        className="secondary"
                        onClick={() => setCursor(offers.data!.nextCursor)}
                      >
                        Older offers <ArrowRight size={15} />
                      </button>
                    )}
                  </div>
                </>
              )}
              {mode === "find" && (
                <>
                  <FlowHeader
                    step={1}
                    title="Who would you like to trade with?"
                    back={() => setMode("offers")}
                  />
                  <p className="muted">
                    Search for a player name or paste their trade code.
                  </p>
                  <form
                    className="search-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setSubmitted(query.trim());
                    }}
                  >
                    <label className="search-field">
                      <Search size={18} />
                      <input
                        autoFocus
                        aria-label="Player name or trade code"
                        placeholder="Player name or trade code"
                        value={query}
                        maxLength={80}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={query.trim().length < 2 || players.loading}
                    >
                      Find player
                    </button>
                  </form>
                  <Feedback error={players.error} retry={players.refresh} />
                  {players.loading ? (
                    <Loading label="Finding players" />
                  ) : submitted && players.data?.length ? (
                    <div className="player-results">
                      {players.data.map((p) => (
                        <button
                          className="player-row"
                          key={p.playerId}
                          disabled={p.playerId === me || !p.allowOffers}
                          onClick={() => choose(p)}
                        >
                          <Avatar name={p.displayName} />
                          <div>
                            <strong>{p.displayName}</strong>
                            <span>
                              {p.allowOffers
                                ? p.tradeCode
                                : "Not accepting offers"}
                            </span>
                          </div>
                          <span className="row-action">
                            Trade <ArrowRight size={16} />
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : submitted ? (
                    <Empty title="No players found">
                      Check the name or ask the player for their trade code.
                    </Empty>
                  ) : null}
                </>
              )}
              {mode === "draft" && draft && (
                <div className="trade-flow">
                  <div className="trade-flow-body">
                    <FlowHeader
                      step={draft.review ? 3 : 2}
                      title=""
                      back={() =>
                        draft.review
                          ? setDraft({ ...draft, review: false, gift: false })
                          : setMode("offers")
                      }
                    />
                    <div className="trade-partner">
                      <Avatar name={draft.partner.displayName} size={32} />
                      <strong>{draft.partner.displayName}</strong>
                      <code>{draft.partner.tradeCode}</code>
                      {!draft.review && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setDraft(null);
                            setMode("find");
                          }}
                        >
                          Change player
                        </button>
                      )}
                    </div>
                    {draft.review ? (
                      <Exchange
                        items={selected}
                        me={me}
                        partner={draft.partner.displayName}
                        inspect={setInspect}
                      />
                    ) : (
                      <div className="inventory-columns">
                        {[me, draft.partner.playerId].map((owner, index) => (
                          <Inventory
                            key={owner}
                            scope={scope}
                            owner={owner}
                            title={
                              index === 0
                                ? "Your inventory"
                                : `${draft.partner.displayName}’s inventory`
                            }
                            selected={draft.selected}
                            select={setSelected}
                            inspect={setInspect}
                          />
                        ))}
                      </div>
                    )}
                    {!draft.review && (
                      <div className="selected-summary">
                        <strong>
                          {selected.filter((i) => i.ownerId === me).length}{" "}
                          items you give
                        </strong>
                        <ArrowLeftRight size={19} />
                        <strong>
                          {selected.filter((i) => i.ownerId !== me).length}{" "}
                          items you receive
                        </strong>
                        <span>50 maximum per side</span>
                      </div>
                    )}
                    <label className="message-field">
                      Message <span>Optional</span>
                      <textarea
                        maxLength={500}
                        rows={2}
                        value={draft.message}
                        readOnly={draft.review}
                        placeholder="Add a note to your offer"
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            message: e.target.value,
                            review: false,
                            gift: false,
                          })
                        }
                      />
                    </label>
                    {draft.review && (
                      <>
                        <TradeConsequences items={selected} />
                        {draftGift && (
                          <label className="gift-confirm">
                            <input
                              type="checkbox"
                              checked={draft.gift}
                              onChange={(e) =>
                                setDraft({ ...draft, gift: e.target.checked })
                              }
                            />
                            I understand this is a gift: one side gives no
                            items.
                          </label>
                        )}
                      </>
                    )}
                  </div>
                  <div className="commit-row">
                    <button
                      className="secondary"
                      disabled={!!action.busy}
                      onClick={() => {
                        setDraft(null);
                        setMode("offers");
                      }}
                    >
                      Discard draft
                    </button>
                    <div>
                      <span>
                        {draft.review
                          ? "Items move only when the other player accepts."
                          : "You can review everything before sending."}
                      </span>
                      <button
                        className="primary"
                        disabled={
                          !!action.busy ||
                          !!pending.data ||
                          recoveryUnchecked ||
                          selected.length === 0 ||
                          (draft.review && draftGift && !draft.gift)
                        }
                        onClick={() =>
                          draft.review
                            ? send()
                            : setDraft({ ...draft, review: true, gift: false })
                        }
                      >
                        {action.busy ? (
                          <Spinner />
                        ) : draft.review ? (
                          <Send size={17} />
                        ) : null}
                        {draft.review ? "Send offer" : "Review trade"}
                        {!draft.review && <ArrowRight size={17} />}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {mode === "offer" && (
                <>
                  <FlowHeader
                    title={
                      o
                        ? `Trade with ${display(partner?.displayName, "B2G player")}`
                        : "Trade offer"
                    }
                    back={() => setMode("offers")}
                  />
                  <Feedback error={offer.error} retry={offer.refresh} />
                  {!o ? (
                    <Loading label="Loading exact trade items" />
                  ) : (
                    <>
                      <div className="offer-meta">
                        <span className={`status-badge ${o.status}`}>
                          {o.status}
                        </span>
                        <span>Revision {o.revision}</span>
                        <span>
                          {o.status === "pending"
                            ? `Expires ${date(o.expiresAt)}`
                            : `Updated ${date(o.updatedAt)}`}
                        </span>
                        <button
                          className="text-button"
                          onClick={async () => {
                            const data = await action.run("trade_events", {
                              id: o.id,
                              after: "0",
                            });
                            if (data) setHistory(data);
                          }}
                        >
                          View activity
                        </button>
                      </div>
                      {changed && (
                        <Feedback error="Items in this offer have changed. It cannot be accepted. Send a new offer or counter with the current items." />
                      )}
                      {!complete ? (
                        <Feedback
                          error="The exact items have not finished loading. Refresh before taking action."
                          retry={offer.refresh}
                        />
                      ) : (
                        <Exchange
                          items={offeredItems}
                          me={me}
                          partner={display(
                            partner?.displayName,
                            "Other player",
                          )}
                          inspect={setInspect}
                        />
                      )}
                      {o.message && (
                        <blockquote className="trade-message">
                          {o.message}
                        </blockquote>
                      )}
                      {o.statusReason && (
                        <p className="notice">{o.statusReason}</p>
                      )}
                      {o.status === "pending" && (
                        <>
                          <TradeConsequences items={offeredItems} />
                          {!own && isGift && (
                            <label className="gift-confirm">
                              <input
                                type="checkbox"
                                checked={gift}
                                onChange={(e) => setGift(e.target.checked)}
                              />
                              I understand this is a gift: one side gives no
                              items.
                            </label>
                          )}
                          <div className="commit-row">
                            <button
                              className="secondary"
                              disabled={
                                !!action.busy ||
                                !!pending.data ||
                                recoveryUnchecked
                              }
                              onClick={() =>
                                void mutate({
                                  action: "respond",
                                  offer_id: o.id,
                                  revision: o.revision,
                                  response: own ? "cancel" : "decline",
                                  confirm_gift: false,
                                })
                              }
                            >
                              {own ? "Cancel offer" : "Decline"}
                            </button>
                            {!own && (
                              <div>
                                <button
                                  className="secondary"
                                  disabled={
                                    !!action.busy ||
                                    !complete ||
                                    !!pending.data ||
                                    recoveryUnchecked
                                  }
                                  onClick={() => {
                                    setDraft({
                                      partner,
                                      selected: Object.fromEntries(
                                        offeredItems
                                          .filter((i) => i.tradable)
                                          .map((i) => [i.assetId, i]),
                                      ),
                                      message: "",
                                      review: false,
                                      gift: false,
                                      counter: {
                                        id: o.id,
                                        revision: o.revision,
                                      },
                                    });
                                    setMode("draft");
                                  }}
                                >
                                  Make counteroffer
                                </button>
                                <button
                                  className="primary"
                                  disabled={
                                    !canAccept ||
                                    !!action.busy ||
                                    !!pending.data ||
                                    recoveryUnchecked
                                  }
                                  onClick={() =>
                                    void mutate({
                                      action: "respond",
                                      offer_id: o.id,
                                      revision: o.revision,
                                      response: "accept",
                                      confirm_gift: gift,
                                    })
                                  }
                                >
                                  {action.busy ? (
                                    <Spinner />
                                  ) : (
                                    <Check size={18} />
                                  )}
                                  Accept trade
                                </button>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                      {o.status === "completed" && (
                        <div className="feedback success">
                          <Check size={18} />
                          <span>
                            Trade complete. These items now belong to their new
                            owners.
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {inspect && (
        <ItemDetails item={inspect} onClose={() => setInspect(null)} />
      )}{" "}
      {history && (
        <Dialog title="Trade activity" onClose={() => setHistory(null)}>
          <div className="activity-list">
            {history.events?.map((event: Data) => (
              <article key={event.id}>
                <strong>{display(event.kind).replaceAll("_", " ")}</strong>
                <time>
                  {date(event.createdAt)} · Revision {event.revision}
                </time>
                <EventDetail detail={event.detail} />
              </article>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
function FlowHeader({
  step,
  title,
  back,
}: {
  step?: number;
  title: string;
  back: () => void;
}) {
  return (
    <div className="flow-header">
      <button className="back-button" onClick={back}>
        <ArrowLeft size={16} />
        Back
      </button>
      {step && (
        <ol className="trade-steps" aria-label="Trade progress">
          {["Choose player", "Select items", "Review & send"].map(
            (label, i) => (
              <li
                key={label}
                className={
                  step === i + 1 ? "current" : step > i + 1 ? "done" : ""
                }
                aria-current={step === i + 1 ? "step" : undefined}
              >
                {step > i + 1 ? <Check size={13} /> : <span>{i + 1}</span>}
                {label}
              </li>
            ),
          )}
        </ol>
      )}
      {title && <h2 className="flow-title">{title}</h2>}
    </div>
  );
}
function TradeConsequences({ items }: { items: Item[] }) {
  return (
    <div className="trade-consequences">
      <ShieldNotice />
      {items.some((i) => i.statTrak) && (
        <p>
          StatTrak counters reset to <strong>0</strong> for the new owner.
          Previous counts remain in trade history.
        </p>
      )}
    </div>
  );
}
function ShieldNotice() {
  return (
    <p>
      Check the player and both sides carefully. Accepted trades exchange the
      exact items shown.
    </p>
  );
}
function Exchange({
  items,
  me,
  partner,
  inspect,
}: {
  items: Item[];
  me: string;
  partner: string;
  inspect: (i: Item) => void;
}) {
  return (
    <div className="exchange">
      {[true, false].map((own) => {
        const side = items.filter((i) => (i.ownerId === me) === own);
        return (
          <section key={String(own)}>
            <div className="exchange-heading">
              <h3>{own ? "You give" : "You receive"}</h3>
              <span>{side.length} items</span>
            </div>
            <p>{own ? "From your inventory" : `From ${partner}`}</p>
            {side.length ? (
              <div className="item-grid">
                {side.map((item) => (
                  <ItemTile
                    key={item.assetId}
                    item={item}
                    onInspect={inspect}
                  />
                ))}
              </div>
            ) : (
              <div className="no-items">No items on this side</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
function EventDetail({ detail }: { detail: Data }) {
  return (
    <>
      {detail?.reason && <p>{String(detail.reason).replaceAll("_", " ")}</p>}
      {detail?.items?.length > 0 && (
        <ul className="receipt-items">
          {detail.items.map((entry: Data, index: number) => {
            const item = entry.before || entry;
            return (
              <li key={item.assetId || index}>
                <strong>{display(item.displayName, "B2G item")}</strong>
                <small>
                  Item {item.assetId}
                  {item.statTrakCount != null &&
                    ` · StatTrak ${item.statTrakCount} → 0 for the new owner`}
                </small>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
function Inventory({
  scope,
  owner,
  title,
  selected,
  select,
  inspect,
}: {
  scope: string;
  owner: string;
  title: string;
  selected: Record<string, Item>;
  select: (i: Item) => void;
  inspect: (i: Item) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [prior, setPrior] = useState<(string | null)[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setCursor(null);
      setPrior([]);
    }, 220);
    return () => clearTimeout(t);
  }, [query]);
  const page = useRemote(
    `${scope}:inventory:${owner}:${search}:${kind}:${cursor}`,
    "trade_inventory",
    { playerId: owner, query: search, kind, cursor },
  );
  return (
    <section className="inventory">
      <div className="exchange-heading">
        <h3>{title}</h3>
        <span>
          {Object.values(selected).filter((i) => i.ownerId === owner).length}{" "}
          selected
        </span>
      </div>
      <div className="inventory-search">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={`Search ${title}`}
            maxLength={80}
            placeholder="Search items"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label={`Filter ${title}`}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setCursor(null);
            setPrior([]);
          }}
        >
          <option value="">All items</option>
          {["cosmetic", "case"].map((k) => (
            <option key={k} value={k}>
              {k.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </div>
      <Feedback error={page.error} retry={page.refresh} />
      {Object.values(selected).some((i) => i.ownerId === owner) && (
        <div className="selected-items" aria-label={`Selected ${title}`}>
          {Object.values(selected)
            .filter((i) => i.ownerId === owner)
            .map((item) => (
              <button
                key={item.assetId}
                className="selected-chip"
                onClick={() => select(item)}
                title={`Remove ${item.displayName}`}
              >
                <span>{item.displayName}</span>
                <X size={13} />
              </button>
            ))}
        </div>
      )}
      <div className="inventory-scroll">
        {!page.data ? (
          <Loading label="Loading inventory" />
        ) : page.data.items?.length ? (
          <div className="item-grid">
            {page.data.items.map((item: Item) => (
              <ItemTile
                key={item.assetId}
                item={item}
                selected={!!selected[item.assetId]}
                onSelect={select}
                onInspect={inspect}
              />
            ))}
          </div>
        ) : (
          <Empty title={search ? "No matching items" : "No items to show"}>
            {search
              ? "Try another item name."
              : "B2G items appear here when this player earns or opens them."}
          </Empty>
        )}
      </div>
      <div className="inventory-pager">
        <button
          className="text-button"
          disabled={!prior.length}
          onClick={() => {
            setCursor(prior[prior.length - 1]!);
            setPrior(prior.slice(0, -1));
          }}
        >
          Previous
        </button>
        <span>Page {prior.length + 1}</span>
        <button
          className="text-button"
          disabled={!page.data?.nextCursor}
          onClick={() => {
            setPrior([...prior, cursor]);
            setCursor(page.data!.nextCursor);
          }}
        >
          Next
        </button>
      </div>
    </section>
  );
}
