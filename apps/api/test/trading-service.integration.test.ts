import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  B2G_CASES, B2G_DROP_ODDS, B2G_GRAFFITI, B2G_PIN_PACKAGES, B2G_SOUVENIR_PACKAGES, B2G_SERVICE_DROP_ODDS,
  createConnection, runMigrations, type Sql
} from "@aftertick/db";
import type { TradeTermsInput } from "@aftertick/contracts";
import { InventoryService } from "../src/inventory-service.js";
import { TradingService } from "../src/trading-service.js";
import { setTradingEnabled, tradingStatus } from "../src/trading-operations.js";
import { LauncherDeviceService } from "../src/launcher-device-service.js";
import { createApp } from "../src/app.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("B2G player trading", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  let admin: Sql, sql: Sql, trading: TradingService, inventory: InventoryService;
  let serial = 0;
  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    sql = createConnection(url.toString());
    await runMigrations(sql);
    await sql`update platform_controls set trading_enabled=true`;
    trading = new TradingService(sql);
    inventory = new InventoryService(sql);
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  async function player(name = "Trade tester") {
    const id = randomUUID();
    await sql`insert into players(id,steam_id,display_name)
      values (${id},${String(76561199000000000n+BigInt(++serial))},${`${name} ${serial}`})`;
    return id;
  }
  async function skin(playerId: string, count: number | null = null) {
    const [row] = await sql<{ asset_id: string }[]>`insert into player_b2g_inventory_items (
      player_id,asset_id,item_kind,definition_index,weapon_key,display_name,inventory_position,
      paint_index,paint_wear,paint_seed,quality,rarity,origin,kill_eater_score_type,kill_eater_value,
      custom_name,stickers,loadout_slot,collection_definition_index
    ) values (${playerId},nextval('b2g_inventory_asset_id_seq')::text,'cosmetic',7,'ak47','AK-47 | Test',
      1,180,0.03125,321,${count===null ? 4 : 9},3,8,${count===null ? null : 0},${count},
      'A distinct name',${sql.json([{slot:0,stickerId:4,wear:0.25,scale:1,rotation:12}])},15,
      ${B2G_CASES[0]!.definitionIndex}) returning asset_id`;
    return row!.asset_id;
  }
  async function terms(sender: string, recipient: string, give: string[], receive: string[]): Promise<TradeTermsInput> {
    const items = [...(await trading.inventory(sender,sender,{limit:100})).items,
      ...(await trading.inventory(sender,recipient,{limit:100})).items];
    const selected = new Set([...give,...receive]);
    return {giveAssetIds:give,receiveAssetIds:receive,confirmGift:!give.length || !receive.length,
      itemFingerprints:Object.fromEntries(items.filter(i=>selected.has(i.assetId)).map(i=>[i.assetId,i.fingerprint]))};
  }
  async function owned(assetId: string) {
    const [row] = await sql<{ player_id: string; original_player_id: string; ownership_generation: bigint;
      kill_eater_value: bigint | null; paint_wear: number; paint_seed: number; custom_name: string; state: string }[]>`
      select * from player_b2g_inventory_items where asset_id=${assetId}`;
    return row!;
  }
  async function sealedCase(owner: string) {
    const definition=B2G_CASES[0]!;
    const [ids]=await sql<{case_id:string;key_id:string}[]>`select nextval('b2g_inventory_asset_id_seq')::text as case_id,
      nextval('b2g_inventory_asset_id_seq')::text as key_id`;
    const [grant]=await sql<{id:string}[]>`insert into player_b2g_case_grants(player_id,grant_type,batch_id,
      case_definition_index,key_definition_index,case_asset_id,key_asset_id,odds_version)
      values (${owner},'admin',${randomUUID()},${definition.definitionIndex},${definition.keyDefinitionIndex},
        ${ids!.case_id},${ids!.key_id},${B2G_DROP_ODDS.version}) returning id`;
    await sql`insert into player_b2g_inventory_items(player_id,asset_id,case_grant_id,item_kind,definition_index,
      weapon_key,display_name,inventory_position,quality,rarity,origin,loadout_slot) values
      (${owner},${ids!.case_id},${grant!.id},'case',${definition.definitionIndex},'case','Case',1,4,1,8,63),
      (${owner},${ids!.key_id},${grant!.id},'key',${definition.keyDefinitionIndex},'key','Key',1,4,1,8,63)`;
    return ids!;
  }

  it("settles exact reviewed terms once, preserves details, resets StatTrak and retains provenance", async () => {
    const a = await player(), b = await player();
    const aItem = await skin(a,87), bItem = await skin(b);
    await inventory.saveLoadout(a,[{weaponKey:"ak47",assetId:aItem}]);
    const request = randomUUID();
    const input = await terms(a,b,[aItem],[bItem]);
    const offer = await trading.create(a,b,request,input);
    expect((await trading.create(a,b,request,input)).id).toBe(offer.id);
    const acceptId = randomUUID();
    expect((await trading.respond(b,offer.id,1,acceptId,"accept")).status).toBe("accepted");
    expect((await trading.respond(b,offer.id,1,acceptId,"accept")).status).toBe("accepted");
    expect(await owned(aItem)).toMatchObject({player_id:b,original_player_id:a,ownership_generation:1n,
      kill_eater_value:0n,paint_wear:0.03125,paint_seed:321,custom_name:"A distinct name"});
    expect(await owned(bItem)).toMatchObject({player_id:a,original_player_id:b,ownership_generation:1n});
    expect(await sql`select * from player_cosmetic_loadouts where player_id=${a}`).toHaveLength(0);
    const history = await trading.events(b,"0",offer.id);
    expect(history.events.filter(e=>e.kind==="accepted")).toHaveLength(1);
    expect(history.events.find(e=>e.kind==="accepted")!.detail["items"]).toEqual(expect.arrayContaining([
      expect.objectContaining({before:expect.objectContaining({assetId:aItem,statTrakCount:87}),newOwnerId:b,statTrakCount:0})
    ]));
    const [counts] = await sql<{ count: number }[]>`select count(*)::int as count from player_b2g_inventory_items
      where asset_id=any(${[aItem,bItem]})`;
    expect(counts!.count).toBe(2);
    await expect(trading.create(a,b,request,{...input,message:"different"})).rejects.toMatchObject({code:"request_reused"});
  });

  it("keeps full inbox pages bounded and fetches exact terms only when opening an offer", async () => {
    const a=await player(),b=await player();
    const left=await Promise.all(Array.from({length:50},()=>skin(a,12)));
    const right=await Promise.all(Array.from({length:50},()=>skin(b)));
    const large=await trading.create(a,b,randomUUID(),await terms(a,b,left,right));
    const small=await terms(a,b,[left[0]!],[right[0]!]);
    for(let i=0;i<25;i++)await trading.create(a,b,randomUUID(),small);
    const page=await trading.offers(b,"incoming");
    expect(page.offers).toHaveLength(25);expect(page.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64*1024);
    expect(page.offers.every(offer=>!("items" in offer)&&offer.itemCount===2)).toBe(true);
    const older=await trading.offers(b,"incoming",page.nextCursor!);
    expect(older.offers).toHaveLength(1);expect(older.offers[0]).toMatchObject({id:large.id,itemCount:100});
    expect((await trading.offer(b,large.id)).items).toHaveLength(100);
    await trading.respond(b,large.id,1,randomUUID(),"accept");
    const notifications=await trading.events(b);
    expect(notifications.events.every(event=>Object.keys(event.detail).length===0)).toBe(true);
    const receipt=await trading.events(b,"0",large.id);
    expect(receipt.events.find(event=>event.kind==="accepted")!.detail["items"]).toHaveLength(100);
  },30_000);

  it("counteroffers revoke approval and require the opposite player to review the new revision", async () => {
    const a = await player(), b = await player();
    const ia = await skin(a), ib = await skin(b), extra = await skin(b);
    const initial = await trading.create(a,b,randomUUID(),await terms(a,b,[ia],[ib]));
    const counter = await trading.counter(b,initial.id,1,randomUUID(),await terms(b,a,[ib,extra],[ia]));
    expect(counter).toMatchObject({revision:2,senderId:b,status:"pending"});
    await expect(trading.respond(a,initial.id,1,randomUUID(),"accept")).rejects.toMatchObject({code:"offer_changed"});
    await expect(trading.respond(b,initial.id,2,randomUUID(),"accept")).rejects.toMatchObject({code:"wrong_participant"});
    expect((await trading.respond(a,initial.id,2,randomUUID(),"accept")).status).toBe("accepted");
    expect((await owned(extra)).player_id).toBe(a);
    expect((await trading.events(a,"0",initial.id)).events.map(e=>e.kind)).toEqual(["sent","countered","accepted"]);
  });

  it("requires gift confirmation from both sides and fences a return to the original owner", async () => {
    const a = await player(), b = await player(), item = await skin(a,21);
    const input = await terms(a,b,[item],[]);
    await expect(trading.create(a,b,randomUUID(),{...input,confirmGift:false})).rejects.toMatchObject({code:"confirm_gift"});
    const first = await trading.create(a,b,randomUUID(),input);
    await expect(trading.respond(b,first.id,1,randomUUID(),"accept")).rejects.toMatchObject({code:"confirm_gift"});
    await trading.respond(b,first.id,1,randomUUID(),"accept",true);
    const back = await trading.create(b,a,randomUUID(),await terms(b,a,[item],[]));
    await trading.respond(a,back.id,1,randomUUID(),"accept",true);
    expect(await owned(item)).toMatchObject({player_id:a,original_player_id:a,ownership_generation:2n,kill_eater_value:0n});
    // A queued pre-trade snapshot cannot re-equip the returned ID or hide its
    // newly received state; a current snapshot can still equip and acknowledge.
    await expect(inventory.syncLauncherLoadout(a,[item])).rejects.toMatchObject({status:409});
    await expect(inventory.syncLauncherLoadout(a,[item],{[item]:"1"})).rejects.toMatchObject({status:409});
    const unaffected=await skin(a);
    await inventory.acknowledgeB2GItems(a,[{assetId:item,position:130},{assetId:unaffected,position:131}]);
    const positions=await sql<{asset_id:string;inventory_position:bigint}[]>`select asset_id,inventory_position
      from player_b2g_inventory_items where asset_id=any(${[item,unaffected]})`;
    expect(positions.find(i=>i.asset_id===item)!.inventory_position).toBe(1_073_741_827n);
    expect(positions.find(i=>i.asset_id===unaffected)!.inventory_position).toBe(131n);
    await inventory.syncLauncherLoadout(a,[item],{[item]:"2"});
    await inventory.acknowledgeB2GItems(a,[{assetId:item,position:130,ownershipGeneration:"2"}]);
    expect(await sql`select asset_id from player_cosmetic_loadouts where player_id=${a}`).toEqual([{asset_id:item}]);
    expect((await sql`select inventory_position from player_b2g_inventory_items where asset_id=${item}`)[0]!.inventory_position).toBe(130n);
  });

  it("serializes web equipment saves with transfers without retaining an unowned loadout", async () => {
    for(let round=0;round<6;round++) {
      const a=await player(),b=await player(),item=await skin(a);
      const offer=await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
      const results=await Promise.allSettled([inventory.saveLoadout(a,[{weaponKey:"ak47",assetId:item}]),
        trading.respond(b,offer.id,1,randomUUID(),"accept",true)]);
      expect(results[1]!.status).toBe("fulfilled");
      expect((await owned(item)).player_id).toBe(b);
      expect(await sql`select * from player_cosmetic_loadouts where player_id=${a}`).toHaveLength(0);
    }
  });

  it("rejects unreviewed changes before send and invalidates consumed or changed pending items", async () => {
    const a = await player(), b = await player(), item = await skin(a);
    const old = await terms(a,b,[item],[]);
    await inventory.renameB2GItem(a,item,"Changed before sending");
    await expect(trading.create(a,b,randomUUID(),old)).rejects.toMatchObject({code:"items_changed"});
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    await inventory.renameB2GItem(a,item,"Changed while pending");
    expect((await trading.offer(b,offer.id)).changedAssetIds).toEqual([item]);
    await expect(trading.respond(b,offer.id,1,randomUUID(),"accept",true)).rejects.toMatchObject({code:"items_changed"});
    expect((await trading.offer(a,offer.id)).status).toBe("invalidated");
    expect((await owned(item)).player_id).toBe(a);
  });

  it("allows gameplay counter changes while pending, but receipts record the actual count reset", async () => {
    const a = await player(), b = await player(), item = await skin(a,5);
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    await sql`update player_b2g_inventory_items set kill_eater_value=9 where asset_id=${item}`;
    await inventory.acknowledgeB2GItems(a,[{assetId:item,position:42}]);
    expect((await trading.offer(b,offer.id)).changedAssetIds).toEqual([]);
    await trading.respond(b,offer.id,1,randomUUID(),"accept",true);
    const receipt = (await trading.events(b,"0",offer.id)).events.find(e=>e.kind==="accepted")!;
    expect(receipt.detail["items"]).toEqual([expect.objectContaining({before:expect.objectContaining({statTrakCount:9}),statTrakCount:0})]);
  });

  it("serializes competing offers so only one recipient can acquire an item", async () => {
    const a = await player(), b = await player(), c = await player();
    const ia = await skin(a), ib = await skin(b), ic = await skin(c);
    const ab = await trading.create(a,b,randomUUID(),await terms(a,b,[ia],[ib]));
    const ac = await trading.create(a,c,randomUUID(),await terms(a,c,[ia],[ic]));
    const results = await Promise.allSettled([
      trading.respond(b,ab.id,1,randomUUID(),"accept"),trading.respond(c,ac.id,1,randomUUID(),"accept")
    ]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
    expect([b,c]).toContain((await owned(ia)).player_id);
    expect([await trading.offer(a,ab.id),await trading.offer(a,ac.id)].map(o=>o.status).sort()).toEqual(["accepted","invalidated"]);
    expect([await owned(ib),await owned(ic)].filter(i=>i.player_id===a)).toHaveLength(1);
  });

  it("makes accept-versus-cancel terminal exactly once", async () => {
    const a = await player(), b = await player(), item = await skin(a,11);
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    const results = await Promise.allSettled([
      trading.respond(a,offer.id,1,randomUUID(),"cancel"),trading.respond(b,offer.id,1,randomUUID(),"accept",true)
    ]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const finished = await trading.offer(a,offer.id);
    expect(["cancelled","accepted"]).toContain(finished.status);
    expect(await owned(item)).toMatchObject(finished.status==="accepted"
      ? {player_id:b,kill_eater_value:0n} : {player_id:a,kill_eater_value:11n});
    expect((await trading.events(a,"0",offer.id)).events).toHaveLength(2);
  });

  it("rolls back both owners, counters, equipment and receipts when settlement fails midway", async () => {
    const a = await player(), b = await player(), ia = await skin(a,18), ib = await skin(b,27);
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[ia],[ib]));
    await sql.unsafe(`CREATE FUNCTION reject_test_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected transfer failure'; END; $$;
      CREATE TRIGGER reject_test_transfer BEFORE UPDATE OF player_id ON player_b2g_inventory_items
      FOR EACH ROW WHEN (OLD.asset_id='${ib}') EXECUTE FUNCTION reject_test_transfer();`);
    try {
      await expect(trading.respond(b,offer.id,1,randomUUID(),"accept")).rejects.toThrow("injected transfer failure");
      expect(await owned(ia)).toMatchObject({player_id:a,ownership_generation:0n,kill_eater_value:18n});
      expect(await owned(ib)).toMatchObject({player_id:b,ownership_generation:0n,kill_eater_value:27n});
      expect((await trading.offer(a,offer.id)).status).toBe("pending");
      expect((await trading.events(a,"0",offer.id)).events).toHaveLength(1);
    } finally {
      await sql.unsafe("DROP TRIGGER reject_test_transfer ON player_b2g_inventory_items; DROP FUNCTION reject_test_transfer();");
    }
    await trading.respond(b,offer.id,1,randomUUID(),"accept");
  });

  it("retains a historical trade-up result reference when that result changes owners", async () => {
    const a = await player(), b = await player(), item = await skin(a);
    await sql`insert into player_b2g_trade_ups(player_id,input_fingerprint,input_asset_ids,input_rarity,output_rarity,
      stattrak,selected_collection_definition_index,collection_roll,candidate_roll,recipe_index,result_asset_id)
      values (${a},${"f".repeat(64)},${Array.from({length:10},(_,i)=>String(i+1))},3,4,false,
        ${B2G_CASES[0]!.definitionIndex},0,0,2,${item})`;
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    await trading.respond(b,offer.id,1,randomUUID(),"accept",true);
    expect(await sql`select player_id from player_b2g_trade_ups where result_asset_id=${item}`).toEqual([expect.objectContaining({player_id:a})]);
    expect((await owned(item)).player_id).toBe(b);
  });

  it("transfers a case with a compatible hidden key, then the recipient can open it", async () => {
    const a = await player(), b = await player();
    const definition = B2G_CASES[0]!;
    const [ids] = await sql<{ case_id: string; key_id: string }[]>`select nextval('b2g_inventory_asset_id_seq')::text as case_id,
      nextval('b2g_inventory_asset_id_seq')::text as key_id`;
    const [grant] = await sql<{ id: string }[]>`insert into player_b2g_case_grants(player_id,grant_type,batch_id,
      case_definition_index,key_definition_index,case_asset_id,key_asset_id,odds_version)
      values (${a},'admin',${randomUUID()},${definition.definitionIndex},${definition.keyDefinitionIndex},
        ${ids!.case_id},${ids!.key_id},${B2G_DROP_ODDS.version}) returning id`;
    await sql`insert into player_b2g_inventory_items(player_id,asset_id,case_grant_id,item_kind,definition_index,
      weapon_key,display_name,inventory_position,quality,rarity,origin,loadout_slot) values
      (${a},${ids!.case_id},${grant!.id},'case',${definition.definitionIndex},'case','Case',1,4,1,8,63),
      (${a},${ids!.key_id},${grant!.id},'key',${definition.keyDefinitionIndex},'key','Key',1,4,1,8,63)`;
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[ids!.case_id],[]));
    await trading.respond(b,offer.id,1,randomUUID(),"accept",true);
    expect((await owned(ids!.key_id)).player_id).toBe(b);
    await expect(inventory.openB2GCase(a,ids!.case_id)).rejects.toMatchObject({status:404});
    const reward = await inventory.openB2GCase(b,ids!.case_id);
    expect(reward.alreadyOpened).toBe(false);
    expect((await owned(reward.item.assetId)).player_id).toBe(b);
    const [origin] = await sql`select player_id,owner_id from player_b2g_case_grants where id=${grant!.id}`;
    expect(origin).toMatchObject({player_id:a,owner_id:b});
    expect((await inventory.openB2GCase(b,ids!.case_id)).alreadyOpened).toBe(true);
  });

  it.each(["pin_package","souvenir_package"] as const)("transfers a keyless %s with its opening authority", async (kind) => {
    const a = await player(), b = await player(), definition = (kind==="pin_package"?B2G_PIN_PACKAGES:B2G_SOUVENIR_PACKAGES)[0]!;
    const [id] = await sql<{ asset_id: string }[]>`select nextval('b2g_inventory_asset_id_seq')::text as asset_id`;
    const [grant] = await sql<{ id: string }[]>`insert into player_b2g_container_grants(player_id,grant_type,batch_id,
      container_type,container_definition_index,container_asset_id,odds_version)
      values (${a},'admin',${randomUUID()},${kind},${definition.definitionIndex},${id!.asset_id},
        ${B2G_SERVICE_DROP_ODDS.version}) returning id`;
    await sql`insert into player_b2g_inventory_items(player_id,asset_id,container_grant_id,item_kind,definition_index,
      weapon_key,display_name,inventory_position,quality,rarity,origin,loadout_slot)
      values (${a},${id!.asset_id},${grant!.id},'case',${definition.definitionIndex},'case','Pin Package',1,4,1,8,63)`;
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[id!.asset_id],[]));
    await trading.respond(b,offer.id,1,randomUUID(),"accept",true);
    expect((await inventory.openB2GCase(b,id!.asset_id)).alreadyOpened).toBe(false);
  });

  it("resolves simultaneous opening and acceptance with one usable outcome", async () => {
    for(let round=0;round<4;round++) {
      const a=await player(),b=await player(),ids=await sealedCase(a);
      const offer=await trading.create(a,b,randomUUID(),await terms(a,b,[ids.case_id],[]));
      const results=await Promise.allSettled([inventory.openB2GCase(a,ids.case_id),
        trading.respond(b,offer.id,1,randomUUID(),"accept",true)]);
      expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
      const transferred=results[1]!.status==="fulfilled";
      if(transferred) expect((await inventory.openB2GCase(b,ids.case_id)).alreadyOpened).toBe(false);
      const [grant]=await sql`select owner_id,result_asset_id from player_b2g_case_grants where case_asset_id=${ids.case_id}`;
      expect(grant!.owner_id).toBe(transferred?b:a);
      expect((await owned(grant!.result_asset_id as string)).player_id).toBe(transferred?b:a);
      expect((await owned(ids.case_id)).state).toBe("consumed");expect((await owned(ids.key_id)).state).toBe("consumed");
    }
  });

  it("transfers sealed graffiti with its grant and preserves tint and charges when unsealed", async () => {
    const a=await player(),b=await player(),definition=B2G_GRAFFITI[0]!;
    const [service]=await sql<{id:string}[]>`insert into player_service_drops(player_id,service_level) values (${a},2) returning id`;
    const [id]=await sql<{asset_id:string}[]>`select nextval('b2g_inventory_asset_id_seq')::text as asset_id`;
    const [grant]=await sql<{id:string}[]>`insert into player_b2g_direct_reward_grants(player_id,service_drop_id,drop_slot,
      reward_type,sealed_asset_id,spray_kit_id,spray_tint_id,charges,odds_version)
      values (${a},${service!.id},3,'graffiti',${id!.asset_id},${definition.sprayKitId},7,50,${B2G_SERVICE_DROP_ODDS.version}) returning id`;
    await sql`insert into player_b2g_inventory_items(player_id,asset_id,direct_reward_grant_id,item_kind,definition_index,
      weapon_key,display_name,inventory_position,quality,rarity,origin,loadout_slot,spray_kit_id,spray_tint_id)
      values (${a},${id!.asset_id},${grant!.id},'cosmetic',1348,'graffiti',${definition.displayName},1,4,${definition.rarity},24,56,${definition.sprayKitId},7)`;
    const offer=await trading.create(a,b,randomUUID(),await terms(a,b,[id!.asset_id],[]));
    await trading.respond(b,offer.id,1,randomUUID(),"accept",true);
    await expect(inventory.unsealB2GGraffiti(a,id!.asset_id)).rejects.toMatchObject({status:404});
    const opened=await inventory.unsealB2GGraffiti(b,id!.asset_id);
    expect(opened.item).toMatchObject({definitionIndex:1349,sprayKitId:definition.sprayKitId,sprayTintId:7,spraysRemaining:50});
    expect((await inventory.consumeB2GGraffiti(b,opened.item.assetId)).spraysRemaining).toBe(49);
    expect((await trading.inventory(b,b)).items.find(item=>item.assetId===opened.item.assetId)).toMatchObject({tradable:false});
    expect((await inventory.unsealB2GGraffiti(b,id!.asset_id)).alreadyUnsealed).toBe(true);
  });

  it("invalidates a multi-case offer when compatible opening keys are exhausted", async () => {
    const a=await player(),b=await player(),first=await sealedCase(a),second=await sealedCase(a);
    const offer=await trading.create(a,b,randomUUID(),await terms(a,b,[first.case_id,second.case_id],[]));
    await sql`update player_b2g_inventory_items set state='consumed',consumed_at=now() where asset_id=${second.key_id}`;
    await expect(trading.respond(b,offer.id,1,randomUUID(),"accept",true)).rejects.toMatchObject({code:"entitlement_unavailable"});
    expect((await trading.offer(a,offer.id)).status).toBe("invalidated");
    expect((await owned(first.case_id)).player_id).toBe(a);expect((await owned(first.key_id)).player_id).toBe(a);
    await sql`update player_b2g_inventory_items set state='consumed',consumed_at=now() where asset_id=${first.key_id}`;
    expect((await trading.inventory(a,a)).items.find(item=>item.assetId===first.case_id)).toMatchObject({tradable:false,
      restriction:"Opening entitlement unavailable."});
  });

  it("serializes ten-item crafting against transfer of one of its inputs", async () => {
    const a=await player(),b=await player(),inputs=await Promise.all(Array.from({length:10},()=>skin(a)));
    const reward=B2G_CASES[0]!.rewards.find(item=>item.rarity===3)!;
    await sql`update player_b2g_inventory_items set definition_index=${reward.definitionIndex},weapon_key=${reward.weaponKey},
      paint_index=${reward.paintIndex},paint_wear=${reward.minWear},loadout_slot=${reward.loadoutSlot},custom_name=null,stickers='[]'
      where asset_id=any(${inputs})`;
    const offer=await trading.create(a,b,randomUUID(),await terms(a,b,[inputs[0]!],[]));
    const results=await Promise.allSettled([inventory.tradeUpB2G(a,inputs),trading.respond(b,offer.id,1,randomUUID(),"accept",true)]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const consumed=await sql`select asset_id from player_b2g_inventory_items where asset_id=any(${inputs}) and state='consumed'`;
    expect(consumed).toHaveLength(results[0]!.status==="fulfilled"?10:0);
    expect((await owned(inputs[0]!)).player_id).toBe(results[0]!.status==="fulfilled"?a:b);
  });

  it("protects account-bound items and participant actions", async () => {
    const a = await player(), b = await player(), c = await player(), item = await skin(a);
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    await expect(trading.offer(c,offer.id)).rejects.toMatchObject({status:404});
    await expect(trading.respond(c,offer.id,1,randomUUID(),"accept",true)).rejects.toMatchObject({status:404});
    await expect(trading.respond(a,offer.id,1,randomUUID(),"accept",true)).rejects.toMatchObject({status:403});
    await trading.respond(b,offer.id,1,randomUUID(),"decline");
    expect((await owned(item)).player_id).toBe(a);
    await sql`update player_b2g_inventory_items set weapon_key='service_medal' where asset_id=${item}`;
    const [medal] = (await trading.inventory(a,a)).items;
    expect(medal).toMatchObject({tradable:false,restriction:expect.stringContaining("Service medals")});
    await expect(trading.create(a,b,randomUUID(),await terms(a,b,[item],[]))).rejects.toMatchObject({code:"items_unavailable"});
  });

  it("persists notifications across reconnect, bounds cursors and supports recipient preferences", async () => {
    const a = await player("Findable player"), b = await player(), item = await skin(a);
    const profile = await trading.overview(b);
    expect((await trading.findPlayers(a,profile.player.tradeCode))[0]!.playerId).toBe(b);
    await trading.preferences(b,false);
    await expect(trading.create(a,b,randomUUID(),await terms(a,b,[item],[]))).rejects.toMatchObject({code:"offers_disabled"});
    await trading.preferences(b,true);
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    const reconnected = new TradingService(sql);
    expect(await reconnected.overview(b)).toMatchObject({incomingCount:1,unreadCount:1});
    expect((await reconnected.offers(b,"incoming")).offers.map(o=>o.id)).toEqual([offer.id]);
    const events = await reconnected.events(b);
    await reconnected.markSeen(b,events.nextCursor);
    expect((await reconnected.overview(b)).unreadCount).toBe(0);
    await sql`update b2g_trade_offers set created_at=now()-interval '8 days',expires_at=now()-interval '1 day' where id=${offer.id}`;
    expect((await reconnected.offer(a,offer.id)).status).toBe("expired");
    expect((await reconnected.events(b,events.nextCursor)).events.map(e=>e.kind)).toEqual(["expired"]);
    expect((await reconnected.offers(b,"history")).offers).toHaveLength(1);
  });

  it("pauses new transfers while allowing cancellation and history", async () => {
    const a = await player(), b = await player(), item = await skin(a,90);
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    await setTradingEnabled(sql,false,"Fixture maintenance");
    try {
      expect(await tradingStatus(sql)).toMatchObject({control:{trading_enabled:false},health:{invalid_b2g_loadouts:0,inconsistent_container_owners:0}});
      await expect(trading.respond(b,offer.id,1,randomUUID(),"accept",true)).rejects.toMatchObject({code:"trading_paused"});
      expect((await owned(item)).kill_eater_value).toBe(90n);
      expect((await trading.respond(a,offer.id,1,randomUUID(),"cancel")).status).toBe("cancelled");
      const [audit]=await sql`select detail from audit_log where action='trading.control' order by created_at desc limit 1`;
      expect(audit!.detail).toMatchObject({enabled:false,reason:"Fixture maintenance"});
    } finally { await setTradingEnabled(sql,true,"Fixture maintenance finished"); }
  });

  it("checks post-transfer capacity without truncating items and permits retry after making room", async () => {
    const a = await player(), b = await player(), item = await skin(a,91);
    await inventory.manifestsForPlayers([b]); // Includes the account's free name tag.
    const offer = await trading.create(a,b,randomUUID(),await terms(a,b,[item],[]));
    const filler = await sql<{ asset_id: string }[]>`insert into player_b2g_inventory_items(player_id,asset_id,item_kind,
      definition_index,weapon_key,display_name,inventory_position,quality,rarity,origin,loadout_slot)
      select ${b},nextval('b2g_inventory_asset_id_seq')::text,'cosmetic',7,'ak47','Capacity fixture',1,4,3,8,15
      from generate_series(1,511) returning asset_id`;
    await expect(trading.respond(b,offer.id,1,randomUUID(),"accept",true)).rejects.toMatchObject({code:"inventory_full"});
    expect(await owned(item)).toMatchObject({player_id:a,kill_eater_value:91n,ownership_generation:0n});
    expect((await trading.offer(a,offer.id)).status).toBe("pending");
    await sql`update player_b2g_inventory_items set state='consumed',consumed_at=now() where asset_id=${filler[0]!.asset_id}`;
    await trading.respond(b,offer.id,1,randomUUID(),"accept",true);
    const manifests = await inventory.manifestsForPlayers([b]);
    expect(manifests[0]!.items).toHaveLength(512);
    expect(manifests[0]!.items).toEqual(expect.arrayContaining([expect.objectContaining({assetId:item,killEaterValue:0})]));
    let cursor: string | undefined;
    const all = [];
    do {
      const page = await trading.inventory(b,b,{limit:100,cursor});
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toHaveLength(512);
    expect(new Set(all.map(i=>i.assetId)).size).toBe(512);
  });

  it("completes an HTTP journey with two real launcher credentials and rejects identity injection", async () => {
    const a = await player(), b = await player(), item = await skin(a,44);
    const devices = new LauncherDeviceService(sql,{publicUrl:"https://play.back2go.net"});
    async function token(playerId: string) {
      const authorization = await devices.issue();
      await devices.approve(playerId,authorization.userCode);
      const exchange = await devices.exchange(authorization.deviceCode,"Trading test launcher");
      if (exchange.status!=="authorized") throw new Error("Fixture device was not approved.");
      return exchange.accessToken;
    }
    const aToken = await token(a), bToken = await token(b);
    const app = createApp({trading,launcherDevices:devices,rateLimits:{windowMs:60_000,apiLimit:1000,authLimit:30}});
    const prefix = "/api/launcher/v1/trading";
    expect((await request(app).get(`${prefix}/overview`)).status).toBe(401);
    expect((await request(app).post(`${prefix}/offers`).send({playerId:a})).status).toBe(401);
    const inventoryResponse = await request(app).get(`${prefix}/inventory/${a}`).set("Authorization",`Bearer ${aToken}`);
    expect(inventoryResponse.status).toBe(200);
    expect(inventoryResponse.headers["cache-control"]).toBe("no-store");
    const input = {recipientId:b,requestId:randomUUID(),terms:await terms(a,b,[item],[])};
    const spoofed = await request(app).post(`${prefix}/offers`).set("Authorization",`Bearer ${aToken}`).send({...input,playerId:b});
    expect(spoofed.status).toBe(400);
    const sent = await request(app).post(`${prefix}/offers`).set("Authorization",`Bearer ${aToken}`).send(input);
    expect(sent.status).toBe(200);
    expect(sent.body.senderId).toBe(a);
    const incoming = await request(app).get(`${prefix}/offers?folder=incoming`).set("Authorization",`Bearer ${bToken}`);
    expect(incoming.body.offers[0].id).toBe(sent.body.id);
    const acceptance = {revision:1,requestId:randomUUID(),confirmGift:true};
    const accepted = await request(app).post(`${prefix}/offers/${sent.body.id}/accept`)
      .set("Authorization",`Bearer ${bToken}`).send(acceptance);
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("accepted");
    expect((await owned(item)).player_id).toBe(b);
    await devices.revoke(aToken);
    expect((await request(app).get(`${prefix}/overview`).set("Authorization",`Bearer ${aToken}`)).status).toBe(401);
    const forged = await request(app).post(`${prefix}/offers/${sent.body.id}/cancel`)
      .set("Authorization",`Bearer ${bToken}`).send({...acceptance,ownerId:a});
    expect(forged.status).toBe(400);
    const history = await request(app).get(`${prefix}/events?offerId=${sent.body.id}`).set("Authorization",`Bearer ${bToken}`);
    expect(history.body.events.map((e:{kind:string})=>e.kind)).toEqual(["sent","accepted"]);
  });
});
