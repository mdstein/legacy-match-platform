import {randomUUID} from "node:crypto";
import {createConnection,runMigrations,type Sql} from "@aftertick/db";
import request from "supertest";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {FriendsService} from "../src/friends-service.js";
import {createApp} from "../src/app.js";

const url=process.env["TEST_DATABASE_URL"] ?? "";
(url?describe:describe.skip)("launcher friends and profile data",()=>{
  const schema=`test_${randomUUID().replaceAll("-","")}`;
  let admin:Sql,sql:Sql,s:FriendsService;
  const ids=Array.from({length:8},()=>randomUUID());
  const [a,b,c,d,e,f,g,h]=ids as [string,string,string,string,string,string,string,string];
  beforeAll(async()=>{
    admin=createConnection(url);await admin.unsafe(`create schema "${schema}"`);
    const parsed=new URL(url);parsed.searchParams.set("options",`-csearch_path=${schema}`);
    sql=createConnection(parsed.toString());await runMigrations(sql);s=new FriendsService(sql);
    for(const [i,id] of ids.entries())await sql`insert into players(id,steam_id,display_name,rating,profile_visibility)
      values(${id},${`7656119800000010${i}`},${`Friend Fixture ${i}`},1525,${i===7?'private':'public'})`;
  });
  afterAll(async()=>{await sql?.end();await admin.unsafe(`drop schema if exists "${schema}" cascade`);await admin.end();});
  it("requires explicit acceptance for crossed requests and makes retries idempotent",async()=>{
    const requestId=randomUUID();
    await s.request(a,b,requestId);
    const results=await Promise.all([s.request(a,b,requestId),s.request(a,b,requestId),s.request(b,a,randomUUID())]);
    expect(results[0]?.relationship).toBe("outgoing");
    expect(results[1]?.requestId).toBe(results[0]?.requestId);
    expect(results[2]?.relationship).toBe("incoming");
    expect((await s.list(b,"incoming")).incomingCount).toBe(1);
    await expect(s.respond(a,requestId,"accept")).rejects.toMatchObject({status:403});
    await expect(s.respond(c,requestId,"accept")).rejects.toMatchObject({status:404});
    expect((await s.respond(b,requestId,"accept")).relationship).toBe("friends");
    expect((await s.respond(b,requestId,"accept")).relationship).toBe("friends");
    expect((await s.list(a,"friends")).friendCount).toBe(1);
    expect((await s.respond(a,requestId,"remove")).relationship).toBe("none");
    await expect(s.respond(b,requestId,"accept")).rejects.toMatchObject({status:409});
    expect((await s.request(a,b,requestId)).relationship).toBe("none");
    await expect(s.request(a,b,randomUUID())).rejects.toMatchObject({status:429});
    await sql`update player_friendships set updated_at=now()-interval '2 minutes' where id=${requestId}`;
    const newId=randomUUID();await s.request(a,b,newId);await s.respond(b,newId,"accept");
    // A delayed remove for the prior friendship must leave its replacement intact.
    expect((await s.respond(a,requestId,"remove")).requestId).toBe(newId);
    expect((await s.list(a,"friends")).friendCount).toBe(1);
  });
  it("supports decline/cancel, protects request identities and cannot friend self",async()=>{
    const id=randomUUID();await s.request(c,d,id);
    await expect(s.respond(d,id,"cancel")).rejects.toMatchObject({status:403});
    await expect(s.request(e,f,id)).rejects.toMatchObject({status:409});
    await s.respond(d,id,"decline");await s.respond(d,id,"decline");
    expect((await s.request(c,d,id)).relationship).toBe("none");
    const cancel=randomUUID();await s.request(e,f,cancel);await s.respond(e,cancel,"cancel");
    await expect(s.respond(f,cancel,"accept")).rejects.toMatchObject({status:409});
    await expect(s.request(g,g,randomUUID())).rejects.toMatchObject({status:400});
    expect((await s.list(e,"outgoing")).total).toBe(0);
  });
  it("exposes only identity for private profiles and separates mode stats and stable match pages",async()=>{
    for(let i=0;i<7;i++){
      const id=randomUUID();await sql`insert into matches(id,map,region,mode,status,alpha_rounds,bravo_rounds,ended_at)
        values(${id},'de_dust2','NA Central',${i===6?'deathmatch':'competitive'},'completed',16,8,'2026-09-07')`;
      await sql`insert into rosters(match_id,player_id,team,slot,rating_at_match) values(${id},${g},${i===6?'ffa':'alpha'},1,1525)`;
      await sql`insert into match_stats(match_id,player_id,kills,deaths,assists,adr) values(${id},${g},${i===6?8:20},10,4,80)`;
    }
    const comp=await s.profile(a,g,"competitive"),dm=await s.profile(a,g,"deathmatch");
    expect(comp.stats).toMatchObject({gamesPlayed:6,wins:6,winRate:100,kdRatio:2,averageAdr:80});
    expect(dm.stats).toMatchObject({gamesPlayed:1,wins:0,winRate:0,kills:8});
    expect(comp.rank).toMatchObject({rating:1525,name:"Master Guardian I"});
    expect(comp.steamProfileUrl).toBe("https://steamcommunity.com/profiles/76561198000000106");
    const next=await s.profile(a,g,"competitive",5);
    expect(next.recentMatches).toHaveLength(1);
    expect(new Set([...comp.recentMatches,...next.recentMatches].map(m=>m.id)).size).toBe(6);
    const hidden=await s.profile(a,h,"competitive");
    expect(hidden).toMatchObject({stats:null,rank:null,region:null,memberSince:null,steamProfileUrl:null,recentMatches:[]});
    expect(Object.keys(hidden).sort()).toEqual(["player","mode","region","memberSince","steamProfileUrl","rank","rankId","level","stats","recentMatches","matchTotal","matchOffset"].sort());
    expect((await s.profile(h,h,"competitive")).steamProfileUrl).toBeTruthy();
    expect((await s.list(a,"search","Fixture 7")).entries[0]).toMatchObject({private:true,online:null});
    expect((await s.list(a,"search",g)).entries[0]?.playerId).toBe(g);
    expect((await s.list(a,"search","%_")).total).toBe(0);
  });
  it("authenticates every route and validates pagination and mutation payloads",async()=>{
    const app=createApp({sql,launcherDevices:{authenticate:async()=>({playerId:a})} as never});
    for(const path of ["friends","players/"+b])expect((await request(app).get("/api/launcher/v1/social/"+path)).status).toBe(401);
    expect((await request(app).post("/api/launcher/v1/social/requests").send({playerId:b,requestId:randomUUID()})).status).toBe(401);
    expect((await request(app).post("/api/launcher/v1/social/requests/"+randomUUID()).send({action:"accept"})).status).toBe(401);
    const get=(path:string)=>request(app).get("/api/launcher/v1/social/"+path).set("Authorization",`Bearer ${"73".repeat(32)}`);
    expect((await get("friends?offset=-1")).status).toBe(400);
    expect((await get("friends?folder=search&q=x")).status).toBe(400);
    expect((await get("players/"+b+"?mode=competitive")).status).toBe(200);
    expect((await get("players/me")).body.player.relationship).toBe("self");
  });
  it("serializes simultaneous opposite requests into one explicitly pending relationship",async()=>{
    const [left,right]=await Promise.all([s.request(g,h,randomUUID()),s.request(h,g,randomUUID())]);
    expect([left.relationship,right.relationship].sort()).toEqual(["incoming","outgoing"]);
    expect(left.requestId).toBe(right.requestId);
    const [row]=await sql`select count(*)::int n from player_friendships where status='pending'
      and ((requester_id=${g} and recipient_id=${h}) or (requester_id=${h} and recipient_id=${g}))`;
    expect(row?.n).toBe(1);
  });
});
