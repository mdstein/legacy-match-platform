import { randomUUID } from "node:crypto";
import { createConnection, runMigrations, type Sql } from "@aftertick/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InventoryService } from "../src/inventory-service.js";
import { MatchIngestionService, signMatchIngestion } from "../src/match-ingestion-service.js";
import { NodeControlService } from "../src/node-control-service.js";
import { TradingService } from "../src/trading-service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("server-observed StatTrak item persistence", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const manifestSecret = "stattrak-integration-manifest-secret";
  const eventSecret = "stattrak-integration-event-ingestion-secret";
  let admin!: Sql;
  let sql!: Sql;
  let nodes!: NodeControlService;
  let inventory!: InventoryService;

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    sql = createConnection(scopedUrl.toString());
    await runMigrations(sql);
    nodes = new NodeControlService(sql, manifestSecret);
    inventory = new InventoryService(sql);
  });

  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function fixture() {
    const matchId = randomUUID();
    const playerId = randomUUID();
    const secondPlayerId = randomUUID();
    const steamId = `76561198${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    const secondSteamId = (BigInt(steamId) + 1n).toString();
    const region = `StatTrak ${matchId}`;
    const credentials = await nodes.registerNode({ name: region, region });
    await nodes.heartbeat(credentials.token, {
      agentVersion: "stattrak-test",
      capacityTotal: 1,
      instances: [{
        instanceKey: "stattrak-test", state: "ready",
        address: "127.0.0.1:27115", gamePort: 27115, pluginVersion: "0.1.6"
      }]
    });
    await sql`
      insert into players (id, steam_id, display_name) values
        (${playerId}, ${steamId}, 'StatTrak Test'),
        (${secondPlayerId}, ${secondSteamId}, 'Weapon Owner Test')
    `;
    await sql`
      insert into matches (id, map, region, mode, status)
      values (${matchId}, 'Dust II', ${region}, 'deathmatch', 'live')
    `;
    await sql`
      insert into rosters (match_id, player_id, team, slot, rating_at_match) values
        (${matchId}, ${playerId}, 'ffa', 1, 1000),
        (${matchId}, ${secondPlayerId}, 'ffa', 2, 1000)
    `;
    const items: string[] = [];
    for (const owner of [playerId, playerId, secondPlayerId]) {
      const [row] = await sql<{ asset_id: string }[]>`
        insert into player_b2g_inventory_items (
          player_id, asset_id, item_kind, definition_index, weapon_key, display_name,
          inventory_position, paint_index, paint_wear, paint_seed,
          quality, rarity, origin, kill_eater_score_type, kill_eater_value, loadout_slot
        ) values (
          ${owner}, nextval('b2g_inventory_asset_id_seq')::text, 'cosmetic', 7,
          'ak47', 'AK-47 | Test', 1, 180, 0.1, 10, 9, 5, 8, 0, 4, 15
        ) returning asset_id
      `;
      items.push(row!.asset_id);
    }
    // The first AK was selected before the match. A later switch uses the
    // second item; the immutable manifest's equipped flags remain unchanged.
    await sql`
      insert into player_cosmetic_loadouts (player_id, weapon_key, asset_id)
      values (${playerId}, 'ak47', ${items[0]!})
    `;
    const cosmetics = await inventory.manifestsForPlayers([playerId, secondPlayerId], "cosmetics");
    const lease = await nodes.leaseReadyServer({
      matchId, region, ttlSeconds: 600,
      payload: {
        mode: "deathmatch",
        roster: [
          { playerId, steamId, team: "ffa" },
          { playerId: secondPlayerId, steamId: secondSteamId, team: "ffa" }
        ],
        cosmetics, map: "Dust II", rulesetVersion: "dm-1.0", pluginVersion: "0.1.6",
        serverConfigVersion: "1.0", demoObjectKey: `matches/${matchId}/gotv.dem`,
        eventIngestSecret: eventSecret, serverPassword: "stattrakTestPassword123",
        integrityPolicy: { protocolVersion: 1, provider: "none", enforcement: "disabled" }
      }
    });
    const kill = {
      attackerSteamId: steamId, victimSteamId: secondSteamId, weapon: "ak47",
      weaponItemId: items[1]!, weaponOriginalOwnerSteamId: steamId
    };
    const batch = (payloads: Record<string, unknown>[], firstSequence = 1) => ({
      leaseId: lease.id, fencingToken: lease.fencingToken,
      events: payloads.map((payload, index) => ({
        eventId: randomUUID(), sequence: firstSequence + index,
        occurredAt: new Date().toISOString(), type: "player.killed", payload
      }))
    });
    const readCounts = () => sql<{ asset_id: string; count: number }[]>`
      select asset_id, kill_eater_value::int as count from player_b2g_inventory_items
      where asset_id = any(${items}) order by asset_id
    `;
    return { matchId, playerId, secondPlayerId, lease, items, kill, batch, readCounts, credentials };
  }

  it("persists the actual item through service restart and concurrent event replay", async () => {
    const f = await fixture();
    const batch = f.batch([f.kill]);
    const signature = signMatchIngestion(batch, eventSecret);
    const submit = () => new MatchIngestionService(sql, nodes)
      .ingestEvents(f.credentials.token, f.matchId, batch, signature);
    const outcomes = await Promise.all([submit(), submit()]);
    expect(outcomes.map((outcome) => outcome.inserted).sort()).toEqual([0, 1]);
    expect(outcomes.map((outcome) => outcome.duplicates).sort()).toEqual([0, 1]);
    expect((await f.readCounts()).map((row) => row.count)).toEqual([4, 5, 4]);
    expect(await submit()).toEqual({ inserted: 0, duplicates: 1, conflicts: 0 });
    const refreshed = await new InventoryService(sql).manifestsForPlayers([f.playerId]);
    expect(refreshed[0]!.items.find((item) => item.assetId === f.items[1])?.killEaterValue).toBe(5);

    const conflicting = { ...batch, events: [{ ...batch.events[0]!, payload: {
      ...f.kill, weaponItemId: f.items[0]!
    } }] };
    expect(await new MatchIngestionService(sql, nodes).ingestEvents(
      f.credentials.token, f.matchId, conflicting, signMatchIngestion(conflicting, eventSecret)
    )).toEqual({ inserted: 0, duplicates: 0, conflicts: 1 });
    expect((await f.readCounts()).map((row) => row.count)).toEqual([4, 5, 4]);
  });

  it("resets a traded gun and rejects old-owner kills through a round trip, heartbeat refresh and retry", async () => {
    const f = await fixture();
    await sql`update platform_controls set trading_enabled=true`;
    const trades = new TradingService(sql);
    const give = async (from: string, to: string) => {
      const item = (await trades.inventory(from,from)).items.find(item => item.assetId === f.items[1])!;
      return trades.create(from,to,randomUUID(),{
        giveAssetIds:[item.assetId],receiveAssetIds:[],confirmGift:true,
        itemFingerprints:{[item.assetId]:item.fingerprint}
      });
    };
    const submit = (batch: ReturnType<typeof f.batch>) => new MatchIngestionService(sql,nodes)
      .ingestEvents(f.credentials.token,f.matchId,batch,signMatchIngestion(batch,eventSecret),true);
    const beforeTrade = f.batch([f.kill]);
    const sent = await give(f.playerId,f.secondPlayerId);
    await Promise.all([
      submit(beforeTrade),
      trades.respond(f.secondPlayerId,sent.id,1,randomUUID(),"accept",true)
    ]);
    expect((await f.readCounts())[1]!.count).toBe(0);
    const returned = await give(f.secondPlayerId,f.playerId);
    await trades.respond(f.playerId,returned.id,1,randomUUID(),"accept",true);
    const old = f.batch([{...f.kill,weaponOwnershipGeneration:"0"}],2);
    // The node still has the pre-transfer signed policy. SQL must independently
    // fence the epoch even though the captured kill matches that stale policy.
    expect((await submit(old)).counterReceipt?.receipt.counts).toEqual([]);
    expect((await f.readCounts())[1]!.count).toBe(0);
    const heartbeat = await nodes.heartbeat(f.credentials.token,{
      agentVersion:"stattrak-test",capacityTotal:1,metadata:{inventorySyncVersion:1},
      instances:[{instanceKey:"stattrak-test",state:"ready",address:"127.0.0.1:27115",gamePort:27115,
        metadata:{srcdsHealth:{protocolVersion:1,activeLeaseId:f.lease.id,activeMatchId:f.matchId}}}]
    });
    expect(heartbeat.commands.some(command=>command.commandType==="sync-inventory")).toBe(true);
    const refreshed = await inventory.manifestsForPlayers([f.playerId],"cosmetics");
    expect(refreshed[0]!.items.find(item=>item.assetId===f.items[1]))
      .toMatchObject({ownershipGeneration:"2",killEaterValue:0,equipped:false});
    await submit(f.batch([{...f.kill,weaponOwnershipGeneration:"0"}],3));
    const current = f.batch([{...f.kill,weaponOwnershipGeneration:"2"}],4);
    const receipt = (await submit(current)).counterReceipt!;
    expect(receipt.receipt.counts).toEqual([
      {steamId:f.kill.attackerSteamId,assetId:f.items[1],count:1,ownershipGeneration:"2"}
    ]);
    expect(receipt.signature).toBe(signMatchIngestion(receipt.receipt,eventSecret));
    await submit(beforeTrade); await submit(old); await submit(current);
    expect((await f.readCounts())[1]!.count).toBe(1);
    await sql`update platform_controls set trading_enabled=false`;
  });

  it("returns signed batch-bound committed counts and heals a lost response without granting twice", async () => {
    const f = await fixture();
    const batch = f.batch([f.kill, { ...f.kill, victimSteamId: "" }]);
    const submit = () => new MatchIngestionService(sql, nodes).ingestEvents(
      f.credentials.token, f.matchId, batch, signMatchIngestion(batch, eventSecret), true);
    const first = await submit();
    const signed = first.counterReceipt!;
    expect(first.inserted).toBe(2);
    expect(signed.receipt).toMatchObject({ kind: "stattrak.committed", version: 1,
      matchId: f.matchId, leaseId: batch.leaseId, fencingToken: batch.fencingToken, sequence: 2,
      counts: [{ steamId: f.kill.attackerSteamId, assetId: f.items[1], count: 6 }] });
    expect(signed.signature).toBe(signMatchIngestion(signed.receipt, eventSecret));
    expect((await f.readCounts()).map((row) => row.count)).toEqual([4, 6, 4]);
    const retry = await submit();
    expect(retry).toMatchObject({ inserted: 0, duplicates: 2, conflicts: 0 });
    expect(retry.counterReceipt).toEqual(signed);
    const conflicting = { ...batch, events: [{ ...batch.events[0]!, payload: {
      ...f.kill, weaponItemId: f.items[0]!
    } }] };
    const conflict = await new MatchIngestionService(sql, nodes).ingestEvents(f.credentials.token,
      f.matchId, conflicting, signMatchIngestion(conflicting, eventSecret), true);
    expect(conflict.conflicts).toBe(1);
    expect(conflict.counterReceipt).toBeUndefined();
  });

  it("retains uncreditable evidence without changing another item's counter", async () => {
    const f = await fixture();
    const batch = f.batch([
      { attackerSteamId: f.kill.attackerSteamId, victimSteamId: f.kill.victimSteamId, weapon: "ak47" },
      { ...f.kill, weaponItemId: f.items[2]!, weaponOriginalOwnerSteamId: f.kill.victimSteamId },
      { ...f.kill, weaponItemId: f.items[2]! },
      { ...f.kill, victimSteamId: f.kill.attackerSteamId },
      { ...f.kill, weapon: "awp" },
      { ...f.kill, weaponItemId: "8000000000999999999" }
    ]);
    const ingestion = new MatchIngestionService(sql, nodes);
    await expect(ingestion.ingestEvents(f.credentials.token, f.matchId, batch, "invalid"))
      .rejects.toThrow("signature is invalid");
    expect(await ingestion.ingestEvents(
      f.credentials.token, f.matchId, batch, signMatchIngestion(batch, eventSecret)
    )).toEqual({ inserted: 6, duplicates: 0, conflicts: 0 });
    expect((await f.readCounts()).map((row) => row.count)).toEqual([4, 4, 4]);
  });

  it("does not resurrect a consumed item and saturates an active uint32 counter", async () => {
    const f = await fixture();
    await sql`
      update player_b2g_inventory_items set state = 'consumed', consumed_at = now()
      where player_id = ${f.playerId} and asset_id = ${f.items[1]!}
    `;
    await sql`
      update player_b2g_inventory_items set kill_eater_value = 4294967294
      where player_id = ${f.playerId} and asset_id = ${f.items[0]!}
    `;
    const batch = f.batch([
      f.kill,
      { ...f.kill, weaponItemId: f.items[0]! },
      { ...f.kill, weaponItemId: f.items[0]!, victimSteamId: "" }
    ]);
    await new MatchIngestionService(sql, nodes).ingestEvents(
      f.credentials.token, f.matchId, batch, signMatchIngestion(batch, eventSecret)
    );
    const rows = await sql<{ asset_id: string; count: string; state: string }[]>`
      select asset_id, kill_eater_value::text as count, state
      from player_b2g_inventory_items where asset_id = any(${f.items}) order by asset_id
    `;
    expect(rows).toEqual([
      { asset_id: f.items[0], count: "4294967295", state: "active" },
      { asset_id: f.items[1], count: "4", state: "consumed" },
      { asset_id: f.items[2], count: "4", state: "active" }
    ]);
  });
});
