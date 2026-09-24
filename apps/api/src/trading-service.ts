import { createHash } from "node:crypto";
import { z } from "zod";
import type postgres from "postgres";
import { lockInventoryPlayers, tradingItemImage, type Sql } from "@aftertick/db";
import type {
  TradeAction, TradeEventView, TradeOfferView, TradeOfferSummary, TradeStatus, TradeTermsInput,
  TradingItem, TradingOverview, TradingPlayer
} from "@aftertick/contracts";

type Tx = postgres.TransactionSql;
type Db = Sql | Tx;
export const TRADING_LIMITS = { itemsPerSide: 50, activeOffers: 50, visibleInventory: 512, expiryDays: 7 } as const;
const uuid = z.string().uuid();
const asset = z.string().regex(/^8[0-9]{18}$/);
export const tradeTermsSchema = z.object({
  giveAssetIds: z.array(asset).max(TRADING_LIMITS.itemsPerSide),
  receiveAssetIds: z.array(asset).max(TRADING_LIMITS.itemsPerSide),
  itemFingerprints: z.record(asset, z.string().regex(/^[a-f0-9]{64}$/)),
  message: z.string().max(240).regex(/^[^\x00-\x1f\x7f]*$/u).default(""),
  confirmGift: z.boolean().default(false)
}).strict();

export class TradingError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new TradingError(status, code, message); }
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type ItemRow = {
  player_id: string; asset_id: string; ownership_generation: bigint; state: string;
  item_kind: TradingItem["itemKind"]; definition_index: number; weapon_key: string;
  display_name: string; icon_path: string | null; paint_index: number | null;
  paint_wear: number | null; paint_seed: number | null; quality: number; rarity: number;
  origin: number; kill_eater_score_type: bigint | null; kill_eater_value: bigint | null;
  custom_name: string | null; stickers: TradingItem["stickers"]; equipped: boolean;
  spray_kit_id: number | null; spray_tint_id: number | null; sprays_remaining: number | null;
  case_grant_id: string | null; container_grant_id: string | null; direct_reward_grant_id: string | null;
  collection_definition_index: number | null; loadout_slot: number;
  opening_entitlement: boolean;
};
type OfferRow = {
  id: string; participant_a: string; participant_b: string; sender_id: string;
  revision: number; status: TradeStatus; status_reason: string | null;
  created_at: Date; updated_at: Date; expires_at: Date; completed_at: Date | null;
  last_event_id: bigint;
};
type MutationResult = { offerId: string; error?: { status: number; code: string; message: string } };
type Terms = z.infer<typeof tradeTermsSchema>;

function parseId(id: string) {
  if (!uuid.safeParse(id).success) fail(400, "invalid_id", "Invalid player, offer or request identifier.");
}
function normalizeTerms(input: TradeTermsInput): Terms {
  const parsed = tradeTermsSchema.safeParse(input);
  if (!parsed.success) fail(400, "invalid_terms", "Select at most 50 B2G items per side and use a short plain-text message.");
  const value = parsed.data;
  const all = [...value.giveAssetIds, ...value.receiveAssetIds];
  if (all.length === 0 || new Set(all).size !== all.length)
    fail(400, "invalid_terms", "Select at least one item, without duplicates.");
  if (Object.keys(value.itemFingerprints).length !== all.length || all.some(id => !value.itemFingerprints[id]))
    fail(400, "missing_review", "Review the current details of every selected item before sending.");
  if ((!value.giveAssetIds.length || !value.receiveAssetIds.length) && !value.confirmGift)
    fail(400, "confirm_gift", "Review and confirm the empty side of this gift before sending.");
  return { ...value, giveAssetIds: [...value.giveAssetIds].sort(), receiveAssetIds: [...value.receiveAssetIds].sort(),
    itemFingerprints: Object.fromEntries(Object.entries(value.itemFingerprints).sort(([a],[b]) => a.localeCompare(b))) };
}

function itemView(row: ItemRow): TradingItem {
  const restriction = row.state !== "active" ? "This item has been consumed."
    : row.item_kind === "key" ? "Included with its case."
    : row.weapon_key === "service_medal" ? "Service medals stay with the player who earned them."
    : row.definition_index === 1200 ? "Free name tags stay with your account."
    : row.definition_index === 1349 ? "Unsealed graffiti stays with your account."
    : row.item_kind === "case" && !row.case_grant_id && !row.container_grant_id ? "Opening entitlement unavailable."
    : row.definition_index === 1348 && !row.direct_reward_grant_id ? "Graffiti entitlement unavailable."
    : !row.opening_entitlement ? "Opening entitlement unavailable."
    : null;
  const view: TradingItem = {
    assetId: row.asset_id, ownerId: row.player_id, ownershipGeneration: String(row.ownership_generation),
    itemKind: row.item_kind, definitionIndex: row.definition_index, weaponKey: row.weapon_key,
    displayName: row.display_name, iconPath: row.icon_path, paintIndex: row.paint_index,
    imageUrl: tradingItemImage(row.definition_index, row.paint_index, row.spray_kit_id),
    paintWear: row.paint_wear, paintSeed: row.paint_seed, quality: row.quality, rarity: row.rarity,
    origin: row.origin, statTrak: row.kill_eater_score_type === 0n && row.kill_eater_value !== null,
    statTrakCount: row.kill_eater_value === null ? null : Number(row.kill_eater_value),
    customName: row.custom_name, stickers: row.stickers, sprayKitId: row.spray_kit_id,
    sprayTintId: row.spray_tint_id, spraysRemaining: row.sprays_remaining,
    equipped: row.equipped, tradable: restriction === null, restriction, fingerprint: ""
  };
  // Kill counts, acknowledgement positions and equipment may change while an
  // offer is pending. Cosmetic terms and the ownership generation may not.
  const { equipped: _equipped, statTrakCount: _count, imageUrl: _image, fingerprint: _fingerprint, ...terms } = view;
  view.fingerprint = digest({ ...terms, caseGrant: row.case_grant_id, containerGrant: row.container_grant_id,
    directGrant: row.direct_reward_grant_id, collection: row.collection_definition_index, slot: row.loadout_slot });
  return view;
}

async function lockPlayers(tx: Tx, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  const rows = await lockInventoryPlayers(tx, unique);
  if (rows.length !== unique.length) fail(404, "player_missing", "That B2G player is unavailable.");
}

async function readItems(db: Db, ids: string[], lock = false): Promise<ItemRow[]> {
  if (!ids.length) return [];
  return db<ItemRow[]>`
    select item.*, exists(select 1 from player_cosmetic_loadouts loadout
      where loadout.player_id=item.player_id and loadout.asset_id=item.asset_id) as equipped,
      ${openingEntitlement(db)} as opening_entitlement
    from player_b2g_inventory_items item where asset_id=any(${ids})
    order by item.asset_id ${lock ? db`for update of item` : db``}
  `;
}

function openingEntitlement(db: Db) {
  return db`case when item.item_kind='case' then (
    exists(select 1 from player_b2g_case_grants g where g.id=item.case_grant_id and g.owner_id=item.player_id
      and g.case_asset_id=item.asset_id and g.opened_at is null and exists(select 1 from player_b2g_inventory_items k
        where k.player_id=item.player_id and k.item_kind='key' and k.state='active' and k.definition_index=g.key_definition_index))
    or exists(select 1 from player_b2g_container_grants g where g.id=item.container_grant_id and g.owner_id=item.player_id
      and g.container_asset_id=item.asset_id and g.opened_at is null))
    when item.definition_index=1348 then exists(select 1 from player_b2g_direct_reward_grants g
      where g.id=item.direct_reward_grant_id and g.owner_id=item.player_id and g.sealed_asset_id=item.asset_id and g.unsealed_at is null)
    else true end`;
}

export class TradingService {
  constructor(private readonly sql: Sql) {}

  private async player(db: Db, playerId: string): Promise<TradingPlayer> {
    await db`insert into b2g_trading_profiles(player_id)
      select id from players where id=${playerId} on conflict (player_id) do nothing`;
    const [row] = await db<{ player_id: string; display_name: string; trade_code: string; allow_offers: boolean }[]>`
      select p.id as player_id, p.display_name, t.trade_code, t.allow_offers
      from players p join b2g_trading_profiles t on t.player_id=p.id where p.id=${playerId}
    `;
    if (!row) fail(404, "player_missing", "That B2G player is unavailable.");
    return { playerId: row.player_id, displayName: row.display_name, tradeCode: row.trade_code, allowOffers: row.allow_offers };
  }

  private async requireEnabled(tx: Tx): Promise<void> {
    const [control] = await tx<{ trading_enabled: boolean }[]>`
      select trading_enabled from platform_controls where singleton=true for share
    `;
    if (!control?.trading_enabled) fail(503, "trading_paused", "Trading is temporarily unavailable. Your items and offers are saved.");
  }

  async overview(playerId: string): Promise<TradingOverview> {
    parseId(playerId);
    await this.expireOffers(playerId);
    const player = await this.player(this.sql, playerId);
    const [row] = await this.sql<{
      enabled: boolean; incoming_count: number; unread_count: number; latest_event_id: string;
    }[]>`
      select (select trading_enabled from platform_controls where singleton=true) as enabled,
        (select count(*)::int from b2g_trade_offers where status='pending' and sender_id<>${playerId}
          and ${playerId} in (participant_a,participant_b)) as incoming_count,
        (select count(*)::int from b2g_trade_events e join b2g_trade_offers o on o.id=e.offer_id
          where ${playerId} in (o.participant_a,o.participant_b)
          and e.actor_id is distinct from ${playerId}::uuid
          and e.id>(select last_seen_event_id from b2g_trading_profiles where player_id=${playerId})) as unread_count,
        (select coalesce(max(e.id),0)::text from b2g_trade_events e join b2g_trade_offers o on o.id=e.offer_id
          where ${playerId} in (o.participant_a,o.participant_b)) as latest_event_id
    `;
    return { enabled: row?.enabled ?? false, player, incomingCount: row?.incoming_count ?? 0,
      unreadCount: row?.unread_count ?? 0, latestEventId: row?.latest_event_id ?? "0", limits: TRADING_LIMITS };
  }

  async preferences(playerId: string, allowOffers: boolean): Promise<TradingPlayer> {
    parseId(playerId);
    return this.sql.begin(async tx => {
      await lockPlayers(tx, [playerId]);
      await this.player(tx, playerId);
      await tx`update b2g_trading_profiles set allow_offers=${allowOffers} where player_id=${playerId}`;
      return this.player(tx, playerId);
    });
  }

  async findPlayers(playerId: string, query: string): Promise<TradingPlayer[]> {
    parseId(playerId);
    const term = query.trim();
    if (term.length < 2 || term.length > 80) fail(400, "invalid_search", "Enter a B2G name or trade code (2–80 characters).");
    // LIKE wildcards are escaped; public results contain no credentials/email.
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await this.sql<{ id: string }[]>`
      select p.id from players p left join b2g_trading_profiles t on t.player_id=p.id
      where p.id<>${playerId} and (t.trade_code=${term.toUpperCase()} or p.display_name ilike ${pattern})
      order by (t.trade_code=${term.toUpperCase()}) desc nulls last, p.display_name, p.id limit 20
    `;
    const players: TradingPlayer[] = [];
    for (const row of rows) players.push(await this.player(this.sql, row.id));
    return players;
  }

  async inventory(playerId: string, ownerId: string, options: {
    query?: string | undefined; kind?: string | undefined; rarity?: number | undefined;
    cursor?: string | undefined; limit?: number | undefined;
  } = {}): Promise<{ player: TradingPlayer; items: TradingItem[]; nextCursor: string | null }> {
    parseId(playerId); parseId(ownerId);
    const limit = options.limit ?? 48;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.query?.length ?? 0) > 80
      || (options.cursor !== undefined && !asset.safeParse(options.cursor).success)
      || (options.kind !== undefined && !["case", "cosmetic"].includes(options.kind))
      || (options.rarity !== undefined && (!Number.isInteger(options.rarity) || options.rarity < 0 || options.rarity > 7)))
      fail(400, "invalid_inventory_query", "Invalid inventory filter or page.");
    const player = await this.player(this.sql, ownerId);
    const pattern = `%${(options.query ?? "").trim().replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await this.sql<ItemRow[]>`
      select item.*, exists(select 1 from player_cosmetic_loadouts l
        where l.player_id=item.player_id and l.asset_id=item.asset_id) as equipped,
        ${openingEntitlement(this.sql)} as opening_entitlement
      from player_b2g_inventory_items item
      where player_id=${ownerId} and state='active' and item_kind<>'key'
        and (${options.cursor ?? null}::text is null or asset_id>${options.cursor ?? null})
        and (${options.kind ?? null}::text is null or item_kind=${options.kind ?? null})
        and (${options.rarity ?? null}::int is null or rarity=${options.rarity ?? null})
        and (display_name ilike ${pattern} or coalesce(custom_name,'') ilike ${pattern})
      order by asset_id limit ${limit + 1}
    `;
    return { player, items: rows.slice(0, limit).map(itemView),
      nextCursor: rows.length > limit ? rows[limit - 1]!.asset_id : null };
  }

  private async offerRow(db: Db, playerId: string, offerId: string, lock = false): Promise<OfferRow> {
    const [row] = await db<OfferRow[]>`select * from b2g_trade_offers
      where id=${offerId} and ${playerId} in (participant_a,participant_b) ${lock ? db`for update` : db``}`;
    if (!row) fail(404, "offer_missing", "That trade offer is unavailable.");
    return row;
  }

  private async view(db: Db, row: OfferRow): Promise<TradeOfferView> {
    const versions = await db<{ message: string }[]>`select message from b2g_trade_versions
      where offer_id=${row.id} and revision=${row.revision}`;
    const terms = await db<{ snapshot: TradingItem; fingerprint: string }[]>`
      select snapshot, fingerprint from b2g_trade_items where offer_id=${row.id} and revision=${row.revision}
      order by owner_id, asset_id
    `;
    const current = row.status === "pending" ? await readItems(db, terms.map(t => t.snapshot.assetId)) : [];
    const byId = new Map(current.map(item => [item.asset_id, itemView(item)]));
    const changed = row.status === "pending" ? terms.filter(t => byId.get(t.snapshot.assetId)?.fingerprint !== t.fingerprint)
      .map(t => t.snapshot.assetId) : [];
    return { id: row.id, revision: row.revision, status: row.status, statusReason: row.status_reason,
      senderId: row.sender_id, participants: [await this.player(db, row.participant_a), await this.player(db, row.participant_b)],
      message: versions[0]?.message ?? "", items: terms.map(t => t.snapshot), changedAssetIds: changed,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      expiresAt: row.expires_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null };
  }

  async offer(playerId: string, offerId: string): Promise<TradeOfferView> {
    parseId(playerId); parseId(offerId);
    await this.expireOffers(playerId);
    return this.sql.begin("isolation level repeatable read", async tx => this.view(tx, await this.offerRow(tx, playerId, offerId)));
  }

  async offers(playerId: string, folder: "incoming" | "outgoing" | "history", before?: string) {
    parseId(playerId);
    if (!["incoming", "outgoing", "history"].includes(folder)
      || (before && !/^[0-9]{1,18}$/.test(before)))
      fail(400, "invalid_folder", "Invalid trade folder or history cursor.");
    await this.expireOffers(playerId);
    return this.sql.begin("isolation level repeatable read", async tx => {
      const rows = await tx<(OfferRow & { item_count: number; message: string })[]>`
        select o.*, (select count(*)::int from b2g_trade_items i where i.offer_id=o.id and i.revision=o.revision) as item_count,
          (select message from b2g_trade_versions v where v.offer_id=o.id and v.revision=o.revision) as message
        from b2g_trade_offers o
        where ${playerId} in (participant_a,participant_b)
          and ((${folder}='history' and status<>'pending')
            or (${folder}='incoming' and status='pending' and sender_id<>${playerId})
            or (${folder}='outgoing' and status='pending' and sender_id=${playerId}))
          and (${before ?? null}::bigint is null or last_event_id<${before ?? null}::bigint)
        order by last_event_id desc limit 26`;
      const participants = [...new Set(rows.flatMap(row => [row.participant_a, row.participant_b]))];
      const profiles = participants.length ? await tx<{
        player_id: string; display_name: string; trade_code: string; allow_offers: boolean;
      }[]>`select p.id as player_id,p.display_name,t.trade_code,t.allow_offers from players p
        join b2g_trading_profiles t on t.player_id=p.id where p.id=any(${participants})` : [];
      const players = new Map(profiles.map(p => [p.player_id, {
        playerId:p.player_id,displayName:p.display_name,tradeCode:p.trade_code,allowOffers:p.allow_offers
      }]));
      const offers: TradeOfferSummary[] = rows.slice(0,25).map(row => ({
        id:row.id,revision:row.revision,status:row.status,statusReason:row.status_reason,senderId:row.sender_id,
        participants:[row.participant_a,row.participant_b].map(id => players.get(id)!).filter(Boolean),
        message:row.message,itemCount:row.item_count,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),
        expiresAt:row.expires_at.toISOString(),completedAt:row.completed_at?.toISOString() ?? null
      }));
      return { offers, nextCursor: rows.length > 25 ? String(rows[24]!.last_event_id) : null };
    });
  }

  async events(playerId: string, after = "0", offerId?: string): Promise<{ events: TradeEventView[]; nextCursor: string }> {
    parseId(playerId); if (offerId) parseId(offerId);
    if (!/^[0-9]{1,18}$/.test(after)) fail(400, "invalid_cursor", "Invalid trade notification cursor.");
    const rows = await this.sql<{
      id: bigint; offer_id: string; revision: number; actor_id: string | null;
      kind: TradeEventView["kind"]; detail: Record<string, unknown>; created_at: Date;
    }[]>`select e.id,e.offer_id,e.revision,e.actor_id,e.kind,e.created_at,
      case when ${offerId ?? null}::uuid is null then '{}'::jsonb else e.detail end as detail
      from b2g_trade_events e join b2g_trade_offers o on o.id=e.offer_id
      where ${playerId} in (o.participant_a,o.participant_b) and e.id>${after}::bigint
        and (${offerId ?? null}::uuid is null or e.offer_id=${offerId ?? null}::uuid)
      order by e.id limit 100`;
    return { events: rows.map(row => ({ id: String(row.id), offerId: row.offer_id, revision: row.revision,
      actorId: row.actor_id, kind: row.kind, detail: row.detail, createdAt: row.created_at.toISOString() })),
      nextCursor: rows.length ? String(rows.at(-1)!.id) : after };
  }

  async markSeen(playerId: string, eventId: string): Promise<void> {
    parseId(playerId);
    if (!/^[0-9]{1,18}$/.test(eventId)) fail(400, "invalid_cursor", "Invalid trade notification cursor.");
    await this.player(this.sql, playerId);
    await this.sql`update b2g_trading_profiles set last_seen_event_id=greatest(last_seen_event_id,
      least(${eventId}::bigint, (select coalesce(max(e.id),0) from b2g_trade_events e
        join b2g_trade_offers o on o.id=e.offer_id where ${playerId} in (o.participant_a,o.participant_b))))
      where player_id=${playerId}`;
  }

  private async event(tx: Tx, offer: OfferRow, kind: TradeEventView["kind"], actorId: string | null, detail: unknown = {}) {
    // Serial IDs alone do not imply commit order. Hold a short journal lock
    // through commit so advancing a notification cursor never skips an earlier
    // allocated event that commits later. Acquire only after other write locks.
    await tx`select pg_advisory_xact_lock(hashtextextended('b2g-trade-event-journal',0))`;
    const [event] = await tx<{ id: bigint }[]>`insert into b2g_trade_events(offer_id,revision,actor_id,kind,detail)
      values (${offer.id},${offer.revision},${actorId},${kind},${tx.json(json(detail))}) returning id`;
    await tx`update b2g_trade_offers set last_event_id=${String(event!.id)},updated_at=clock_timestamp() where id=${offer.id}`;
  }

  async expireOffers(playerId?: string): Promise<number> {
    if (playerId) parseId(playerId);
    return this.sql.begin(async tx => {
      const rows = await tx<OfferRow[]>`select * from b2g_trade_offers where status='pending' and expires_at<=now()
        and (${playerId ?? null}::uuid is null or ${playerId ?? null}::uuid in (participant_a,participant_b))
        order by id limit 100 for update skip locked`;
      for (const row of rows) {
        await tx`update b2g_trade_offers set status='expired', completed_at=now(),updated_at=now() where id=${row.id}`;
        await this.event(tx, row, "expired", null);
      }
      return rows.length;
    });
  }

  private async mutate(actorId: string, requestId: string, otherId: string, payload: unknown,
    work: (tx: Tx) => Promise<MutationResult>): Promise<TradeOfferView> {
    parseId(actorId); parseId(otherId); parseId(requestId);
    if (actorId === otherId) fail(400, "self_trade", "Choose another B2G player.");
    const fingerprint = digest(payload);
    const result = await this.sql.begin(async tx => {
      await lockPlayers(tx, [actorId, otherId]);
      const [previous] = await tx<{ fingerprint: string; response: MutationResult }[]>`
        select fingerprint,response from b2g_trade_requests where actor_id=${actorId} and request_id=${requestId}`;
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, "request_reused", "This request was already used for different trade terms.");
        return previous.response;
      }
      const response = await work(tx);
      await tx`insert into b2g_trade_requests(actor_id,request_id,fingerprint,response)
        values (${actorId},${requestId},${fingerprint},${tx.json(json(response))})`;
      return response;
    });
    if (result.error) fail(result.error.status, result.error.code, result.error.message);
    return this.offer(actorId, result.offerId);
  }

  private async terms(tx: Tx, sender: string, recipient: string, terms: Terms): Promise<ItemRow[]> {
    const rows = await readItems(tx, [...terms.giveAssetIds, ...terms.receiveAssetIds], true);
    if (rows.length !== terms.giveAssetIds.length + terms.receiveAssetIds.length)
      fail(409, "items_unavailable", "One or more selected B2G items are unavailable.");
    for (const row of rows) {
      const owner = terms.giveAssetIds.includes(row.asset_id) ? sender : recipient;
      const view = itemView(row);
      if (row.player_id !== owner || !view.tradable)
        fail(409, "items_unavailable", "A selected item is unavailable, belongs to somebody else, or cannot be traded.");
      if (view.fingerprint !== terms.itemFingerprints[row.asset_id])
        fail(409, "items_changed", "An item changed since you selected it. Review its current details before sending.");
    }
    await this.entitlements(tx, rows);
    return rows;
  }

  private async version(tx: Tx, row: OfferRow, terms: Terms, items: ItemRow[]) {
    await tx`insert into b2g_trade_versions(offer_id,revision,sender_id,message)
      values (${row.id},${row.revision},${row.sender_id},${terms.message})`;
    for (const item of items) {
      const view = itemView(item);
      await tx`insert into b2g_trade_items(offer_id,revision,owner_id,asset_id,ownership_generation,fingerprint,snapshot)
        values (${row.id},${row.revision},${item.player_id},${item.asset_id},${String(item.ownership_generation)},
          ${view.fingerprint},${tx.json(json(view))})`;
    }
  }

  async create(actorId: string, recipientId: string, requestId: string, input: TradeTermsInput): Promise<TradeOfferView> {
    const terms = normalizeTerms(input);
    return this.mutate(actorId,requestId,recipientId,{ action:"create",recipientId,terms },async tx => {
      await this.requireEnabled(tx);
      const recipient = await this.player(tx,recipientId);
      if (!recipient.allowOffers) fail(409,"offers_disabled","That player is not accepting new offers.");
      const counts = await tx<{ player_id: string; count: number }[]>`
        select p.id as player_id,count(o.id)::int as count from players p left join b2g_trade_offers o
          on p.id in (o.participant_a,o.participant_b) and o.status='pending' and o.expires_at>now()
        where p.id=any(${[actorId,recipientId]}) group by p.id`;
      if (counts.some(row => row.count >= TRADING_LIMITS.activeOffers))
        fail(409,"too_many_offers","One of these players has 50 active offers. Close an offer and try again.");
      const items = await this.terms(tx,actorId,recipientId,terms);
      const [a,b] = [actorId,recipientId].sort();
      const [offer] = await tx<OfferRow[]>`insert into b2g_trade_offers(participant_a,participant_b,sender_id)
        values (${a!},${b!},${actorId}) returning *`;
      if (!offer) throw new Error("Could not create trade offer.");
      await this.version(tx,offer,terms,items);
      await this.event(tx,offer,"sent",actorId);
      return { offerId:offer.id };
    });
  }

  async counter(actorId: string, offerId: string, revision: number, requestId: string, input: TradeTermsInput): Promise<TradeOfferView> {
    parseId(actorId); parseId(offerId);
    if (!Number.isInteger(revision) || revision < 1) fail(400,"invalid_revision","Review the current offer first.");
    const terms = normalizeTerms(input);
    const initial = await this.offerRow(this.sql,actorId,offerId);
    const otherId = initial.participant_a===actorId ? initial.participant_b : initial.participant_a;
    return this.mutate(actorId,requestId,otherId,{action:"counter",offerId,revision,terms},async tx => {
      await this.requireEnabled(tx);
      const offer = await this.offerRow(tx,actorId,offerId,true);
      const unavailable = await this.validatePending(tx,offer,revision);
      if (unavailable) return unavailable;
      if (offer.sender_id===actorId) fail(409,"not_recipient","Only the recipient can counter. Cancel your offer to replace it.");
      if (offer.revision>=100) fail(409,"revision_limit","Start a new offer after 100 revisions.");
      const items = await this.terms(tx,actorId,otherId,terms);
      const [updated] = await tx<OfferRow[]>`update b2g_trade_offers set sender_id=${actorId},revision=revision+1,
        updated_at=now(),expires_at=now()+interval '7 days' where id=${offerId} returning *`;
      await this.version(tx,updated!,terms,items);
      await this.event(tx,updated!,"countered",actorId,{previousRevision:revision});
      return { offerId };
    });
  }

  private async validatePending(tx: Tx, offer: OfferRow, revision: number): Promise<MutationResult | null> {
    if (offer.status!=="pending") return {offerId:offer.id,error:{status:409,code:"offer_closed",message:"This offer is already closed."}};
    const [time] = await tx<{ expired: boolean }[]>`select ${offer.expires_at}::timestamptz<=clock_timestamp() as expired`;
    if (time?.expired) {
      await tx`update b2g_trade_offers set status='expired',completed_at=now(),updated_at=now() where id=${offer.id}`;
      await this.event(tx,offer,"expired",null);
      return {offerId:offer.id,error:{status:409,code:"offer_expired",message:"This offer has expired."}};
    }
    if (offer.revision!==revision) fail(409,"offer_changed","The offer changed. Review the new terms before responding.");
    return null;
  }

  async respond(actorId: string, offerId: string, revision: number, requestId: string, action: TradeAction,
    confirmGift = false): Promise<TradeOfferView> {
    parseId(actorId); parseId(offerId);
    if (!Number.isInteger(revision) || revision<1 || !["accept","decline","cancel"].includes(action))
      fail(400,"invalid_action","Invalid trade action or revision.");
    const initial = await this.offerRow(this.sql,actorId,offerId);
    const otherId = initial.participant_a===actorId ? initial.participant_b : initial.participant_a;
    return this.mutate(actorId,requestId,otherId,{action,offerId,revision,confirmGift},async tx => {
      if (action==="accept") await this.requireEnabled(tx);
      const offer = await this.offerRow(tx,actorId,offerId,true);
      const unavailable = await this.validatePending(tx,offer,revision);
      if (unavailable) return unavailable;
      if ((action==="cancel") !== (offer.sender_id===actorId))
        fail(403,"wrong_participant","Only the sender can cancel; only the recipient can accept or decline.");
      if (action==="accept") return this.settle(tx,offer,actorId,confirmGift);
      const status = action==="cancel" ? "cancelled" : "declined";
      await tx`update b2g_trade_offers set status=${status},completed_at=now(),updated_at=now() where id=${offerId}`;
      await this.event(tx,offer,status,actorId);
      return {offerId};
    });
  }

  private async entitlements(tx: Tx, items: ItemRow[]): Promise<ItemRow[]> {
    const companions: string[] = [];
    for (const item of items) {
      if (item.item_kind==="case" && item.case_grant_id) {
        const [grant] = await tx<{ key_definition_index: number }[]>`select key_definition_index from player_b2g_case_grants
          where id=${item.case_grant_id} and owner_id=${item.player_id} and case_asset_id=${item.asset_id}
            and opened_at is null for update`;
        if (!grant) fail(409,"entitlement_unavailable","A selected case no longer has an available opening entitlement.");
        const [key] = await tx<{ asset_id: string }[]>`select asset_id from player_b2g_inventory_items
          where player_id=${item.player_id} and state='active' and item_kind='key'
            and definition_index=${grant.key_definition_index} and not (asset_id=any(${companions}))
          order by asset_id limit 1 for update`;
        if (!key) fail(409,"entitlement_unavailable","A selected case is missing its opening entitlement.");
        companions.push(key.asset_id);
      } else if (item.item_kind==="case" && item.container_grant_id) {
        const [grant] = await tx`select id from player_b2g_container_grants where id=${item.container_grant_id}
          and owner_id=${item.player_id} and container_asset_id=${item.asset_id} and opened_at is null for update`;
        if (!grant) fail(409,"entitlement_unavailable","A selected package has already been opened or transferred.");
      } else if (item.definition_index===1348) {
        const [grant] = await tx`select id from player_b2g_direct_reward_grants where id=${item.direct_reward_grant_id}
          and owner_id=${item.player_id} and sealed_asset_id=${item.asset_id} and unsealed_at is null for update`;
        if (!grant) fail(409,"entitlement_unavailable","A selected graffiti has already been unsealed or transferred.");
      }
    }
    return readItems(tx,companions,true);
  }

  private async settle(tx: Tx, offer: OfferRow, actorId: string, confirmGift: boolean): Promise<MutationResult> {
    const terms = await tx<{ asset_id: string; fingerprint: string; snapshot: TradingItem }[]>`
      select asset_id,fingerprint,snapshot from b2g_trade_items where offer_id=${offer.id} and revision=${offer.revision}
      order by asset_id`;
    if ((!terms.some(t=>t.snapshot.ownerId===offer.participant_a) || !terms.some(t=>t.snapshot.ownerId===offer.participant_b)) && !confirmGift)
      fail(400,"confirm_gift","Review and confirm the empty side of this gift before accepting.");
    const items = await readItems(tx,terms.map(t=>t.asset_id),true);
    const byId = new Map(items.map(item=>[item.asset_id,itemView(item)]));
    if (!terms.length || terms.some(t=>byId.get(t.asset_id)?.fingerprint!==t.fingerprint || !byId.get(t.asset_id)?.tradable)) {
      const reason = "An offered item changed, was consumed, or changed owners. Create a new offer with the current inventory.";
      await tx`update b2g_trade_offers set status='invalidated',status_reason=${reason},completed_at=now(),updated_at=now() where id=${offer.id}`;
      await this.event(tx,offer,"invalidated",actorId,{reason});
      return {offerId:offer.id,error:{status:409,code:"items_changed",message:reason}};
    }
    let companions: ItemRow[];
    try { companions = await this.entitlements(tx,items); }
    catch (error) {
      if (!(error instanceof TradingError) || error.code!=="entitlement_unavailable") throw error;
      await tx`update b2g_trade_offers set status='invalidated',status_reason=${error.message},completed_at=now(),updated_at=now() where id=${offer.id}`;
      await this.event(tx,offer,"invalidated",actorId,{reason:error.message});
      return {offerId:offer.id,error:{status:error.status,code:error.code,message:error.message}};
    }
    for (const playerId of [offer.participant_a,offer.participant_b]) {
      const [capacity] = await tx<{ count: number; name_tag: boolean }[]>`
        select ((select count(*) from player_b2g_inventory_items where player_id=${playerId} and state='active' and item_kind<>'key')
          + (select count(*) from player_inventory_items where player_id=${playerId} and legacy_compatible=true))::int as count,
          exists(select 1 from player_b2g_inventory_items where player_id=${playerId} and state='active' and definition_index=1200) as name_tag`;
      const outgoing = items.filter(item=>item.player_id===playerId).length;
      const incoming = items.length-outgoing;
      if ((capacity?.count ?? 0)+(capacity?.name_tag ? 0 : 1)-outgoing+incoming > TRADING_LIMITS.visibleInventory)
        fail(409,"inventory_full","One player's inventory would exceed 512 visible items. Make room before accepting.");
    }
    const transferred = [...items,...companions].sort((a,b)=>a.asset_id.localeCompare(b.asset_id));
    for (const item of transferred) {
      const recipient = item.player_id===offer.participant_a ? offer.participant_b : offer.participant_a;
      await tx`update player_b2g_inventory_items set player_id=${recipient}
        where asset_id=${item.asset_id} and player_id=${item.player_id}`;
      if (item.item_kind==="case" && item.case_grant_id)
        await tx`update player_b2g_case_grants set owner_id=${recipient} where id=${item.case_grant_id}`;
      if (item.item_kind==="case" && item.container_grant_id)
        await tx`update player_b2g_container_grants set owner_id=${recipient} where id=${item.container_grant_id}`;
      if (item.definition_index===1348)
        await tx`update player_b2g_direct_reward_grants set owner_id=${recipient} where id=${item.direct_reward_grant_id}`;
    }
    await tx`update b2g_trade_offers set status='accepted',completed_at=now(),updated_at=now() where id=${offer.id}`;
    const receipt = { items: items.map(item=>({ before:itemView(item),
      newOwnerId:item.player_id===offer.participant_a ? offer.participant_b : offer.participant_a,
      ownershipGeneration:String(item.ownership_generation+1n),statTrakCount:item.kill_eater_value===null ? null : 0 })),
      includedEntitlements:companions.map(item=>item.asset_id) };
    await this.event(tx,offer,"accepted",actorId,receipt);
    await tx`insert into audit_log(actor_id,action,target_type,target_id,detail)
      values (${actorId},'trade.accepted','trade',${offer.id},${tx.json(json({revision:offer.revision,...receipt}))})`;
    return {offerId:offer.id};
  }
}
