import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, type Sql } from "../src/connection.js";
import { runMigrations } from "../src/migrations.js";
import { ServiceMedalService } from "../../../apps/api/src/service-medal-service.js";

const url=process.env["TEST_DATABASE_URL"] ?? "";
(url?describe:describe.skip)("1,000 XP release conversion",()=>{
  const schema=`xp_conversion_${randomUUID().replaceAll("-","")}`;
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  let admin:Sql;let sql:Sql;let fixtureDir:string;
  beforeAll(async()=>{
    admin=createConnection(url);await admin.unsafe(`create schema "${schema}"`);
    const scoped=new URL(url);scoped.searchParams.set("options",`-csearch_path=${schema}`);sql=createConnection(scoped.toString());
    const root=resolve(".artifacts","tests");await mkdir(root,{recursive:true});fixtureDir=await mkdtemp(join(root,"xp-migrations-"));
    const source=resolve("packages/db/migrations");
    for(const file of await readdir(source))if(file.endsWith(".sql")&&file<"033")await writeFile(join(fixtureDir,file),await readFile(join(source,file)));
    await runMigrations(sql,fixtureDir);
    for (const [index,level,xp] of [[0,3,4900],[1,39,4900],[2,40,4999]] as const) {
      await sql`insert into players(id,steam_id,display_name,profile_level,profile_xp,lifetime_xp)
        values(${ids[index]!},${`7656119809000000${index}`},${`XP fixture ${index}`},${level},${xp},50000)`;
    }
  });
  afterAll(async()=>{
    await sql?.end();if(admin){await admin.unsafe(`drop schema "${schema}" cascade`);await admin.end();}
    if(fixtureDir&&fixtureDir.startsWith(resolve(".artifacts","tests")+"\\"))await rm(fixtureDir,{recursive:true});
  });
  it("rolls back a failed reward grant, converts once, and retains overflow for medal redemption",async()=>{
    await sql`create function reject_xp_test_reward() returns trigger language plpgsql as $$ begin raise exception 'XP fixture rollback'; end $$`;
    await sql`create trigger reject_xp_test_reward before insert on player_b2g_inventory_items for each row execute function reject_xp_test_reward()`;
    await expect(runMigrations(sql)).rejects.toThrow("XP fixture rollback");
    expect(await sql`select profile_level,profile_xp from players where id=${ids[0]!}`).toEqual([{profile_level:3,profile_xp:4900}]);
    expect(await sql`select version from schema_migrations where version='033_profile_xp_1000'`).toHaveLength(0);
    expect(await sql`select id from player_service_drops`).toHaveLength(0);
    await sql`drop trigger reject_xp_test_reward on player_b2g_inventory_items`;
    const applied=await Promise.all([runMigrations(sql),runMigrations(sql)]);
    expect(applied.flatMap(result=>result.applied)).toEqual(["033_profile_xp_1000","034_player_friends"]);
    const read=async(id:string)=>(await sql`select profile_level,profile_xp,profile_xp_reserve,lifetime_xp from players where id=${id}`)[0];
    expect(await read(ids[0]!)).toMatchObject({profile_level:7,profile_xp:900,profile_xp_reserve:0,lifetime_xp:50000n});
    expect(await read(ids[1]!)).toMatchObject({profile_level:40,profile_xp:0,profile_xp_reserve:3900,lifetime_xp:50000n});
    expect(await read(ids[2]!)).toMatchObject({profile_level:40,profile_xp:0,profile_xp_reserve:4999,lifetime_xp:50000n});
    expect(await sql`select id from player_service_drops where player_id=${ids[0]!}`).toHaveLength(4);
    expect(await sql`select id from player_b2g_direct_reward_grants where player_id=${ids[0]!}`).toHaveLength(4);
    const [containers]=await sql`select
      (select count(*) from player_b2g_case_grants where player_id=${ids[0]!})+
      (select count(*) from player_b2g_container_grants where player_id=${ids[0]!}) as count`;
    expect(Number(containers!.count)).toBe(8);
    const medals=new ServiceMedalService(sql);
    const first=await medals.redeem(ids[1]!,1331);
    expect(first).toMatchObject({playerLevel:4,playerXp:900,alreadyCompleted:false});
    expect(await medals.redeem(ids[1]!,1331)).toMatchObject({playerLevel:4,playerXp:900,alreadyCompleted:true});
    expect(await read(ids[1]!)).toMatchObject({profile_xp_reserve:0,lifetime_xp:50000n});
    expect(await sql`select id from player_service_drops where player_id=${ids[1]!} and service_prestige=1`).toHaveLength(3);
    expect((await runMigrations(sql)).applied).toEqual([]);
  });
});
