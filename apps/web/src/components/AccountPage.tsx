import type { AccountSettings, CosmeticInventoryView, CosmeticLoadoutSelection, PlayerView } from "@aftertick/contracts";
import { ArrowUpRight, Bell, Check, Eye, Gamepad2, LoaderCircle, LockKeyhole, PackageCheck, RefreshCw, Save, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { RankIcon } from "./RankIcon.js";

interface AccountPageProps {
  player: PlayerView;
  pending: boolean;
  onSave: (settings: AccountSettings & { region: string }) => Promise<boolean>;
  onOpenStanding: () => void;
  onLoadInventory: () => Promise<CosmeticInventoryView>;
  onRefreshInventory: () => Promise<CosmeticInventoryView>;
  onSaveLoadout: (selections: CosmeticLoadoutSelection[]) => Promise<CosmeticInventoryView>;
}

const DEFAULT_SETTINGS: AccountSettings = {
  preferredMode: "competitive",
  profileVisibility: "public",
  allowPartyInvites: true,
  matchNotifications: true,
  productUpdates: false,
  reducedMotion: false
};

function Toggle({ checked, onChange, label, detail }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  detail: string;
}) {
  return (
    <label className="settings-toggle">
      <span><strong>{label}</strong><small>{detail}</small></span>
      <input name={label.toLowerCase().replace(/\s+/g, "-")} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

export function AccountPage({
  player,
  pending,
  onSave,
  onOpenStanding,
  onLoadInventory,
  onRefreshInventory,
  onSaveLoadout
}: AccountPageProps) {
  const [settings, setSettings] = useState(player.settings ?? DEFAULT_SETTINGS);
  const [region, setRegion] = useState(player.region);
  const [saved, setSaved] = useState(false);
  const [inventory, setInventory] = useState<CosmeticInventoryView | null>(null);
  const [inventoryPending, setInventoryPending] = useState<"load" | "refresh" | "save" | null>("load");
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [loadout, setLoadout] = useState<Record<string, string>>({});
  const [loadoutSaved, setLoadoutSaved] = useState(false);
  const [inventoryClock, setInventoryClock] = useState(() => Date.now());

  useEffect(() => {
    setSettings(player.settings ?? DEFAULT_SETTINGS);
    setRegion(player.region);
  }, [player]);

  useEffect(() => {
    let active = true;
    setInventoryPending("load");
    void onLoadInventory().then((result) => {
      if (!active) return;
      setInventory(result);
      setLoadout(Object.fromEntries(result.items.filter((item) => item.selected).map((item) => [item.weaponKey, item.assetId])));
      setInventoryError(null);
    }).catch((error) => {
      if (active) setInventoryError(error instanceof Error ? error.message : "Could not load Steam inventory.");
    }).finally(() => {
      if (active) setInventoryPending(null);
    });
    return () => { active = false; };
  }, [onLoadInventory, player.id]);

  useEffect(() => {
    if (!inventory) return;
    const remaining = new Date(inventory.nextRefreshAt).getTime() - Date.now();
    if (remaining <= 0) {
      setInventoryClock(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setInventoryClock(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [inventory]);

  const patch = <K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) => {
    setSaved(false);
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const acceptInventory = (result: CosmeticInventoryView) => {
    setInventory(result);
    setInventoryClock(Date.now());
    setLoadout(Object.fromEntries(result.items.filter((item) => item.selected).map((item) => [item.weaponKey, item.assetId])));
    setLoadoutSaved(false);
  };

  const refreshInventory = async () => {
    setInventoryPending("refresh");
    setInventoryError(null);
    try {
      acceptInventory(await onRefreshInventory());
    } catch (error) {
      setInventoryError(error instanceof Error ? error.message : "Steam inventory could not be refreshed.");
    } finally {
      setInventoryPending(null);
    }
  };

  const saveLoadout = async () => {
    setInventoryPending("save");
    setInventoryError(null);
    try {
      const selections = Object.entries(loadout).flatMap(([weaponKey, assetId]) =>
        assetId ? [{ weaponKey, assetId }] : []
      );
      acceptInventory(await onSaveLoadout(selections));
      setLoadoutSaved(true);
    } catch (error) {
      setInventoryError(error instanceof Error ? error.message : "The owned-item loadout could not be saved.");
    } finally {
      setInventoryPending(null);
    }
  };

  const inventoryGroups = inventory?.items.reduce<Record<string, CosmeticInventoryView["items"]>>((groups, item) => {
    (groups[item.weaponKey] ??= []).push(item);
    return groups;
  }, {}) ?? {};
  const nextRefreshAt = inventory ? new Date(inventory.nextRefreshAt).getTime() : 0;
  const refreshCoolingDown = nextRefreshAt > inventoryClock;

  return (
    <section className="account-page" aria-labelledby="account-title">
      <header className="page-heading account-heading">
        <div>
          <h1 id="account-title">Settings</h1>
          <p>Manage your player identity, matchmaking preferences, privacy, and notifications.</p>
        </div>
        <div className="account-identity">
          <RankIcon rank={player.rank.name} size="lg" />
          <span><strong>{player.displayName}</strong><small>{player.rank.name} · {player.rank.rating.toLocaleString()} Elo</small></span>
        </div>
      </header>

      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-section">
            <header><UserRound size={17} /><div><h2>Player identity</h2><p>How you appear across B2G.</p></div></header>
            <div className="settings-grid">
              <label className="field-stack"><span>In-game name</span><input name="display-name" value={player.displayName} disabled /></label>
              <label className="field-stack"><span>Player ID</span><input name="player-id" value={player.id} disabled /></label>
            </div>
          </section>

          <section className="settings-section">
            <header><Gamepad2 size={17} /><div><h2>Matchmaking</h2><p>Defaults are applied when you open Play.</p></div></header>
            <div className="settings-grid">
              <label className="field-stack"><span>Home region</span><select name="home-region" value={region} onChange={(event) => { setSaved(false); setRegion(event.target.value); }}><option>NA Central</option><option>NA East</option><option>NA West</option><option>EU Central</option></select></label>
              <label className="field-stack"><span>Preferred mode</span><select name="preferred-mode" value={settings.preferredMode} onChange={(event) => patch("preferredMode", event.target.value as AccountSettings["preferredMode"])}><option value="competitive">Competitive 5v5</option><option value="deathmatch">Deathmatch</option></select></label>
            </div>
            <Toggle checked={settings.allowPartyInvites} onChange={(value) => patch("allowPartyInvites", value)} label="Party invites" detail="Allow other B2G players to invite you." />
          </section>

          <section className="settings-section cosmetics-section">
            <header>
              <PackageCheck size={17} />
              <div><h2>Owned weapon loadout</h2><p>Imported from your public App 730 inventory. Unowned asset IDs are rejected by the server.</p></div>
              <button
                className="btn btn--secondary cosmetics-refresh"
                type="button"
                disabled={inventoryPending !== null || refreshCoolingDown}
                onClick={() => void refreshInventory()}
              >
                {inventoryPending === "refresh" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                {inventory?.refreshedAt ? "Refresh" : "Import"}
              </button>
            </header>

            {inventoryPending === "load" && <div className="cosmetics-state" role="status"><LoaderCircle className="spin" size={16} /> Loading inventory…</div>}

            {inventoryPending !== "load" && inventory?.status !== "public" && (
              <div className="cosmetics-state">
                <strong>{inventory?.status === "private" ? "Steam inventory is private" : "No verified inventory yet"}</strong>
                <p>Set Game details and Inventory to Public in Steam, then import again. Existing selections are never replaced after a failed Steam request.</p>
                <a href="https://steamcommunity.com/my/edit/settings" target="_blank" rel="noreferrer">Open Steam privacy settings <ArrowUpRight size={13} /></a>
              </div>
            )}

            {inventory?.status === "public" && (
              <>
                <div className="cosmetics-ledger">
                  <span><strong>{inventory.itemCount}</strong> supported firearms verified</span>
                  <span>Ownership proof expires 24 hours after refresh</span>
                  <span>Matching launcher builds expose these items in CS:GO’s native Inventory and Loadout screens</span>
                </div>
                {Object.keys(inventoryGroups).length === 0 ? (
                  <div className="cosmetics-state"><strong>No supported firearm finishes found</strong><p>Knives, gloves, agents, music kits, containers, and stickers are intentionally excluded from this first ownership-safe pass.</p></div>
                ) : (
                  <div className="cosmetics-loadout">
                    {Object.entries(inventoryGroups).map(([weaponKey, items]) => {
                      const selected = items.find((item) => item.assetId === loadout[weaponKey]) ?? null;
                      const weaponName = items[0]?.marketHashName.split(" | ", 1)[0] ?? weaponKey;
                      return (
                        <label className="cosmetic-slot" key={weaponKey}>
                          <span className="cosmetic-slot__image">
                            {selected?.iconUrl ? <img src={selected.iconUrl} alt="" loading="lazy" /> : <PackageCheck size={18} />}
                          </span>
                          <span className="cosmetic-slot__control">
                            <strong>{weaponName}</strong>
                            <select
                              value={loadout[weaponKey] ?? ""}
                              onChange={(event) => {
                                setLoadoutSaved(false);
                                setLoadout((current) => ({ ...current, [weaponKey]: event.target.value }));
                              }}
                            >
                              <option value="">Use native / stock</option>
                              {items.map((item) => <option key={item.assetId} value={item.assetId}>{item.displayName}</option>)}
                            </select>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="cosmetics-save">
                  <p>This screen sets the initial loadout. In game, you can equip any imported owned finish; the server rejects altered or unowned item data.</p>
                  <button className="btn btn--primary" type="button" disabled={inventoryPending !== null} onClick={() => void saveLoadout()}>
                    {inventoryPending === "save" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
                    Save owned loadout
                  </button>
                </div>
              </>
            )}
            {loadoutSaved && <p className="cosmetics-success" role="status"><Check size={14} /> Owned loadout saved.</p>}
            {inventoryError && <p className="settings-error" role="alert">{inventoryError}</p>}
          </section>

          <section className="settings-section">
            <header><Eye size={17} /><div><h2>Privacy & accessibility</h2><p>Control profile reach and interface motion.</p></div></header>
            <label className="field-stack"><span>Profile visibility</span><select name="profile-visibility" value={settings.profileVisibility} onChange={(event) => patch("profileVisibility", event.target.value as AccountSettings["profileVisibility"])}><option value="public">Public</option><option value="players">Signed-in players</option><option value="private">Private</option></select></label>
            <Toggle checked={settings.reducedMotion} onChange={(value) => patch("reducedMotion", value)} label="Reduce motion" detail="Minimize non-essential interface animation." />
          </section>

          <section className="settings-section">
            <header><Bell size={17} /><div><h2>Notifications</h2><p>Choose which platform updates should reach you.</p></div></header>
            <Toggle checked={settings.matchNotifications} onChange={(value) => patch("matchNotifications", value)} label="Match notifications" detail="Ready checks, assignments, and result notices." />
            <Toggle checked={settings.productUpdates} onChange={(value) => patch("productUpdates", value)} label="Product updates" detail="Occasional playtest and release announcements." />
          </section>

          <div className="settings-save-row">
            {saved && <span><Check size={14} /> Saved</span>}
            <button className="btn btn--primary" type="button" disabled={pending} onClick={() => { void onSave({ ...settings, region }).then((ok) => setSaved(ok)); }}><Save size={14} /> {pending ? "Saving…" : "Save settings"}</button>
          </div>
        </div>

        <aside className="account-rail">
          <button className="standing-card" type="button" onClick={onOpenStanding}>
            <ShieldCheck size={20} />
            <span><strong>Account standing</strong><small>Review penalties and appeals</small></span>
          </button>
          <div className="security-note"><LockKeyhole size={16} /><p><strong>Steam-secured sign in</strong><br />B2G never receives your Steam password.</p></div>
        </aside>
      </div>
    </section>
  );
}
