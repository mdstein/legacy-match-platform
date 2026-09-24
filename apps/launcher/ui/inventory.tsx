import { useEffect, useState, type CSSProperties } from "react";
import { Check, Package, RefreshCw, Search } from "lucide-react";
import { display, invalidate, useAction, useRemote } from "./api";
import { Dialog, Empty, Feedback, Loading, PageTitle, Pager, Spinner } from "./components";

interface Item {
  assetId: string;
  displayName: string;
  source: "steam" | "b2g";
  itemKind: string;
  iconUrl: string | null;
  selected: boolean;
  rarity: number;
  paintIndex: number | null;
  paintWear: number | null;
  paintSeed: number | null;
  customName: string | null;
  killEaterValue: number | null;
}
interface InventoryView {
  status: "public" | "private" | "unavailable";
  refreshedAt: string | null;
  nextRefreshAt: string;
  items: Item[];
}
const colors = ["#a7a7a7", "#b0c3d9", "#5e98d9", "#4b69ff", "#8847ff", "#d32ce6", "#eb4b4b", "#e4ae39"];
const condition = (item: Item) => item.paintWear == null
  ? item.itemKind === "case" ? "Container" : "Collectible"
  : item.paintWear < 0.07 ? "Factory New" : item.paintWear < 0.15 ? "Minimal Wear"
    : item.paintWear < 0.38 ? "Field-Tested" : item.paintWear < 0.45 ? "Well-Worn" : "Battle-Scarred";

function ItemCard({ item, onInspect }: { item: Item; onInspect: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.iconUrl]);
  return <button className="inventory-item" style={{ "--rarity": colors[item.rarity] || colors[0] } as CSSProperties}
    onClick={onInspect} aria-label={`View ${item.displayName}`}>
    <span className="inventory-art">
      {item.iconUrl && !failed ? <img alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
        src={item.iconUrl.startsWith("/trading-items/") ? `https://play.back2go.net${item.iconUrl}` : item.iconUrl}
        onError={() => setFailed(true)} /> : <Package size={32} aria-hidden="true" />}
    </span>
    <strong>{item.displayName}</strong>
    <span className="muted">{condition(item)}</span>
    <span className="inventory-item-meta"><span>{item.source === "steam" ? "Steam" : "B2G"}</span>
      {item.selected && <span><Check size={13} /> Equipped</span>}</span>
  </button>;
}

export function Inventory({ scope, active }: { scope: string; active: boolean }) {
  const remote = useRemote<InventoryView>(`${scope}:inventory`, "inventory", {}, active, 30_000);
  const action = useAction();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [offset, setOffset] = useState(0);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const data = remote.data;
  const items = data?.items || [];
  const steamCount = items.filter(item => item.source === "steam").length;
  const remaining = Math.max(0, Math.ceil(((Date.parse(data?.nextRefreshAt || "") || 0) - now) / 1000));
  const filtered = items.filter(item => (source === "all" || item.source === source)
    && item.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pageOffset = Math.min(offset, Math.max(0, Math.ceil(filtered.length / 48) - 1) * 48);
  const inspected = items.find(item => item.assetId === inspectId);
  const refreshSteam = async () => {
    const result = await action.run<InventoryView>("inventory_refresh");
    if (result?.status === "public") action.setNotice(`Steam refreshed. ${result.items.filter(item => item.source === "steam").length} compatible items imported.`);
    setNow(Date.now());
    // Reload the saved status even after a failed Steam request so its retry
    // time and privacy state remain accurate. Cached items stay mounted.
    invalidate();
  };
  return <div className="inventory-page">
    <PageTitle title="Inventory" description="Your Steam skins and items earned in B2G.">
      <button className="primary" onClick={() => void refreshSteam()}
        disabled={!!action.busy || remaining > 0 || !data} aria-describedby="inventory-sync">
        {action.busy ? <Spinner /> : <RefreshCw size={17} />}
        {action.busy ? "Refreshing Steam" : "Refresh Steam inventory"}
      </button>
    </PageTitle>
    <p id="inventory-sync" className="muted small inventory-sync">
      {data?.refreshedAt ? `Last Steam import: ${new Date(data.refreshedAt).toLocaleString()}.` : "Refresh Steam to import your compatible skins."}
      {remaining > 0 && ` Refresh available in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}.`}
    </p>
    <Feedback error={action.error || remote.error} notice={action.notice} {...(remote.error ? { retry: remote.refresh } : {})} />
    {data?.status === "private" && <p className="notice">Your Steam inventory is private. Set Inventory to Public in Steam privacy settings, then refresh. Previously imported items are shown below.</p>}
    {data?.status === "unavailable" && data.refreshedAt && <p className="notice">Steam could not verify your inventory. These are your last imported items; refresh when Steam is available.</p>}
    <div className="inventory-toolbar">
      <label className="owned-inventory-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search inventory</span>
        <input placeholder="Search your items" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} /></label>
      <label className="inventory-source"><span className="sr-only">Item source</span><select value={source} onChange={e => { setSource(e.target.value); setOffset(0); }}>
        <option value="all">All items ({items.length})</option><option value="steam">Steam ({steamCount})</option><option value="b2g">B2G ({items.length - steamCount})</option>
      </select></label>
    </div>
    {!data ? remote.loading ? <Loading label="Loading your inventory" /> : null : filtered.length === 0 ? <Empty title={query || source !== "all" ? "No matching items" : "Your inventory is empty"}>
      {query || source !== "all" ? "Try another search or item source." : "Refresh your public Steam inventory to bring in compatible skins. Items you earn in B2G will also appear here."}
    </Empty> : <div className="inventory-grid">{filtered.slice(pageOffset, pageOffset + 48).map(item =>
      <ItemCard key={`${item.source}:${item.assetId}`} item={item} onInspect={() => setInspectId(item.assetId)} />)}</div>}
    <Pager offset={pageOffset} total={filtered.length} limit={48} onChange={setOffset} />
    <p className="muted small inventory-help">Only items supported by CS:GO 2023 are imported. Equip items in the game inventory. Steam items stay linked to your account; B2G item trades are available in Trading.</p>
    {inspected && <Dialog title={inspected.displayName} onClose={() => setInspectId(null)}>
      <p>{condition(inspected)} · {inspected.source === "steam" ? "Steam inventory" : "B2G inventory"}{inspected.selected ? " · Equipped" : ""}</p>
      <dl className="detail-grid">{[
        ["Wear", inspected.paintWear], ["Pattern", inspected.paintSeed], ["Paint kit", inspected.paintIndex],
        ["Name tag", inspected.customName], ["StatTrak kills", inspected.killEaterValue], ["Item ID", inspected.assetId]
      ].filter(([, value]) => value != null).map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{display(value)}</dd></div>)}</dl>
      {inspected.source === "steam" && <p className="muted">This item is imported from your linked Steam account and cannot be traded through B2G.</p>}
    </Dialog>}
  </div>;
}
