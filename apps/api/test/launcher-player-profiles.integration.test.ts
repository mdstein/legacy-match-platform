import { randomUUID } from "node:crypto";
import { createConnection, runMigrations, type Sql } from "@aftertick/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { playerService } from "../src/player-service.js";
import { createApp } from "../src/app.js";

const databaseUrl = process.env["TEST_DATABASE_URL"] ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("launcher in-game player profiles", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const requesterId = randomUUID();
  const accessToken = "73".repeat(32);
  let admin!: Sql;
  let sql!: Sql;

  function schemaUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    return parsed.toString();
  }

  beforeAll(async () => {
    admin = createConnection(databaseUrl);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    sql = createConnection(schemaUrl(databaseUrl));
    await runMigrations(sql);
    await sql`
      insert into players (
        id, steam_id, display_name, rating, wins, profile_level, profile_xp,
        profile_visibility
      ) values
        (${requesterId}, '76561198000000001', 'Private Requester', 1525, 42, 4, 380, 'private'),
        (${randomUUID()}, '76561198000000002', 'Public Member', 2500, 900, 40, 999, 'public'),
        (${randomUUID()}, '76561198000000003', 'Players Member', 1125, 20, 7, 400, 'players'),
        (${randomUUID()}, '76561198000000004', 'Private Member', 2300, 300, 15, 200, 'private')
    `;
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it("counts Deathmatch history independently of competitive matches played and pages ties consistently", async () => {
    const matchIds=Array.from({length:10},()=>randomUUID()).sort().reverse();
    for (const [index,id] of matchIds.entries()) {
      await sql`insert into matches(id,map,region,mode,status,ended_at) values
        (${id},'de_dust2','NA Central',${index===9?'competitive':'deathmatch'},'completed','2026-09-07T00:00:00Z')`;
      await sql`insert into rosters(match_id,player_id,team,slot,rating_at_match)
        values(${id},${requesterId},${index===9?'alpha':'ffa'},1,1000)`;
    }
    await sql`update players set matches_played=1 where id=${requesterId}`;
    const service=playerService(sql);
    const first=await service.matchHistory(requesterId,8,0);
    const second=await service.matchHistory(requesterId,8,8);
    expect(first.total).toBe(10);expect(second.total).toBe(10);
    expect([...first.entries,...second.entries].map(entry=>entry.id)).toEqual(matchIds);
    expect(first.entries.every(entry=>entry.mode==='deathmatch')).toBe(true);
  });

  it("shows self and player-visible party ranks while withholding private profiles", async () => {
    const launcherDevices = {
      authenticate: async (token: string) => {
        if (token !== accessToken) throw new Error("unexpected token");
        return {
          credentialId: randomUUID(),
          playerId: requesterId,
          expiresAt: "2026-12-02T01:00:00.000Z"
        };
      }
    };
    const app = createApp({ sql, launcherDevices: launcherDevices as never });
    const response = await request(app)
      .post("/api/launcher/v1/player-profiles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ accountIds: [39_734_274, 39_734_276, 39_734_273, 39_734_275] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      version: 1,
      profiles: [
        {
          accountId: 39_734_274,
          competitiveRankId: 18,
          competitiveWins: 900,
          playerLevel: 40,
          playerXp: 999
        },
        {
          accountId: 39_734_273,
          competitiveRankId: 11,
          competitiveWins: 42,
          playerLevel: 4,
          playerXp: 380
        },
        {
          accountId: 39_734_275,
          competitiveRankId: 8,
          competitiveWins: 20,
          playerLevel: 7,
          playerXp: 400
        }
      ]
    });
  });
});
