import type { Sql } from "@aftertick/db";

/** Operator-only DB entry point; never registered as a player HTTP route. */
export async function setTradingEnabled(sql: Sql, enabled: boolean, reason: string): Promise<void> {
  if (!reason.trim() || reason.length>240) throw new Error("Supply a reason between 1 and 240 characters.");
  await sql.begin(async tx => {
    // Mutations hold this row FOR SHARE through commit. Disabling waits for
    // any settlement already in progress, then prevents subsequent transfers.
    const [previous]=await tx`select trading_enabled from platform_controls where singleton=true for update`;
    if (!previous) throw new Error("Platform controls are unavailable; verify migrations.");
    if(previous.trading_enabled===enabled)return;
    await tx`update platform_controls set trading_enabled=${enabled},version=version+1,updated_at=now(),updated_by=null
      where singleton=true`;
    await tx`insert into audit_log(action,target_type,detail)
      values ('trading.control','platform',${tx.json({enabled,previous:previous.trading_enabled as boolean,reason:reason.trim(),source:"operator-cli"})})`;
  });
}

export async function tradingStatus(sql: Sql) {
  const [control]=await sql`select trading_enabled,version::text,updated_at from platform_controls where singleton=true`;
  const offers=await sql`select status,count(*)::int as count,min(created_at) as oldest from b2g_trade_offers group by status order by status`;
  const [health]=await sql`
    select (select count(*)::int from b2g_trade_offers where status='pending' and expires_at<=now()) as expiry_backlog,
      (select count(*)::int from player_b2g_inventory_items where ownership_generation>0) as transferred_assets,
      (select count(*)::int from player_cosmetic_loadouts l join player_b2g_inventory_items i on i.asset_id=l.asset_id
        where i.player_id<>l.player_id or i.state<>'active') as invalid_b2g_loadouts,
      (select count(*)::int from player_b2g_inventory_items i
        where i.state='active' and i.item_kind='case' and (
          (i.case_grant_id is not null and not exists(select 1 from player_b2g_case_grants g where g.id=i.case_grant_id and g.owner_id=i.player_id and g.opened_at is null)) or
          (i.container_grant_id is not null and not exists(select 1 from player_b2g_container_grants g where g.id=i.container_grant_id and g.owner_id=i.player_id and g.opened_at is null)))) as inconsistent_container_owners`;
  const sizes=await sql`select relname,pg_total_relation_size(c.oid)::text as bytes from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname=current_schema()
      and relname in ('b2g_trade_offers','b2g_trade_versions','b2g_trade_items','b2g_trade_events','b2g_trade_requests') order by relname`;
  return {control,offers,health,sizes};
}
