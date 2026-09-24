import request from "supertest";
import type { Sql } from "@aftertick/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createE2EReadService } from "../src/e2e-read-service.js";
import { PartyService } from "../src/party-service.js";
import { QueueService } from "../src/queue-service.js";
import type { PlayerReadService } from "../src/player-service.js";
import { ServiceMedalError } from "../src/service-medal-service.js";
import { InventoryError } from "../src/inventory-service.js";
import { B2G_RELEASE } from "@aftertick/contracts";

function createTestApp() {
  const service = new QueueService({ autoMatchDelayMs: null, readyCheckSeconds: 20 });
  const app = createApp({ queueService: service });
  return app;
}

async function authenticatedAgent(app: ReturnType<typeof createTestApp>) {
  const agent = request.agent(app);

  const meResponse = await agent.get("/api/auth/me");
  if (!meResponse.body.authenticated) {
    await agent
      .get("/api/bootstrap")
      .set("Cookie", "");
  }

  return agent;
}

describe("API", () => {
  it("finishes native signup only once for the authenticated device owner",async()=>{
    const playerId="6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    let onboardingRequired=true;
    const completeOnboarding=vi.fn(async(_id:string,displayName:string,region:string)=>{
      onboardingRequired=false; return {id:playerId,displayName,region,onboardingRequired};
    });
    const playerReads={...createE2EReadService(playerId),getPlayerView:vi.fn(async()=>({id:playerId,onboardingRequired})),completeOnboarding} as unknown as PlayerReadService;
    const launcherDevices={issue:vi.fn(),approve:vi.fn(),exchange:vi.fn(),revoke:vi.fn(),authenticate:vi.fn(async()=>({credentialId:playerId,playerId,expiresAt:"2027-01-01T00:00:00Z"}))};
    const app=createApp({launcherDevices,playerReads});const path="/api/launcher/v1/account/onboarding";const bearer=`Bearer ${"ab".repeat(32)}`;
    const input={displayName:"New_Player",region:"NA Central"};
    expect((await request(app).post(path).send(input)).status).toBe(401);
    for(const body of [{...input,playerId:"someone-else"},{...input,displayName:"bad name"},{...input,region:"nowhere"}]){
      expect((await request(app).post(path).set("Authorization",bearer).send(body)).status).toBe(400);
    }
    const result=await request(app).post(path).set("Authorization",bearer).send(input);
    expect(result.status).toBe(200);expect(result.headers["cache-control"]).toBe("no-store");
    expect(completeOnboarding).toHaveBeenCalledExactlyOnceWith(playerId,input.displayName,input.region);
    expect((await request(app).post(path).set("Authorization",bearer).send({...input,displayName:"FreeRename"})).status).toBe(409);
    expect(completeOnboarding).toHaveBeenCalledTimes(1);
  });
  it("serves native settings and match evidence only for the authenticated launcher owner",async()=>{
    const playerId="6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const matchId="8edc25d0-1954-4d15-8497-fb37bdff48bd";
    const settings={region:"NA Central",preferredMode:"deathmatch",profileVisibility:"private",allowPartyInvites:false,
      matchNotifications:true,productUpdates:false,reducedMotion:true};
    const playerReads={...createE2EReadService(playerId),
      getPlayerView:vi.fn(async()=>({id:playerId,displayName:"Fixture",settings})),
      updateSettings:vi.fn(async()=>({id:playerId,settings})),
      matchHistory:vi.fn(async()=>({entries:[],total:0})),
      getMatchDetails:vi.fn(async()=>({id:matchId,teams:{alpha:[{playerId}],bravo:[]},demo:null}))} as unknown as PlayerReadService;
    const launcherDevices={issue:vi.fn(),approve:vi.fn(),exchange:vi.fn(),revoke:vi.fn(),
      authenticate:vi.fn(async()=>({credentialId:matchId,playerId,expiresAt:"2027-01-01T00:00:00.000Z"}))};
    const app=createApp({launcherDevices,playerReads});const bearer=`Bearer ${"ab".repeat(32)}`;
    for(const route of ["/account","/matches",`/matches/${matchId}`]){
      expect((await request(app).get(`/api/launcher/v1${route}`)).status).toBe(401);
      const response=await request(app).get(`/api/launcher/v1${route}`).set("Authorization",bearer);
      expect(response.status).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect((await request(app).post("/api/launcher/v1/account/settings").send(settings)).status).toBe(401);
    expect((await request(app).post("/api/launcher/v1/account/settings").set("Authorization",bearer).send({...settings,playerId:"other"})).status).toBe(400);
    expect((await request(app).post("/api/launcher/v1/account/settings").set("Authorization",bearer).send(settings)).status).toBe(200);
    expect(playerReads.updateSettings).toHaveBeenCalledExactlyOnceWith(playerId,settings);
    expect((await request(app).get("/api/launcher/v1/matches?limit=8&offset=16").set("Authorization",bearer)).status).toBe(200);
    expect(playerReads.matchHistory).toHaveBeenLastCalledWith(playerId,8,16);
    expect((await request(app).get("/api/launcher/v1/matches?offset=-1").set("Authorization",bearer)).status).toBe(400);
    vi.mocked(playerReads.getMatchDetails).mockResolvedValueOnce({id:matchId,teams:{alpha:[],bravo:[]}} as never);
    expect((await request(app).get(`/api/launcher/v1/matches/${matchId}`).set("Authorization",bearer)).status).toBe(404);
  });
  it("binds medal preview and redemption to the authenticated launcher account", async () => {
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const launcherDevices = {
      issue: vi.fn(), approve: vi.fn(), exchange: vi.fn(), revoke: vi.fn(),
      authenticate: vi.fn(async () => ({ credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId, expiresAt: "2026-12-02T01:00:00.000Z" }))
    };
    const serviceMedals = {
      preview: vi.fn(async () => ({ playerLevel: 40, playerXp: 0, completedPrestiges: 0, canRedeem: true, failureReason: 0, medal: null })),
      redeem: vi.fn(async () => { throw new ServiceMedalError(409, "Reach level 40 to redeem your next service medal."); })
    };
    const app = createApp({ launcherDevices, serviceMedals });
    const path = "/api/launcher/v1/service-medal";
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).post(path).send({ definitionIndex: 1331 })).status).toBe(401);
    expect(serviceMedals.preview).not.toHaveBeenCalled();
    expect(serviceMedals.redeem).not.toHaveBeenCalled();
    const bearer = `Bearer ${"ab".repeat(32)}`;
    const preview = await request(app).get(path).set("Authorization", bearer);
    expect(preview.status).toBe(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(serviceMedals.preview).toHaveBeenCalledWith(playerId);
    for (const body of [{}, { definitionIndex: 0 }, { definitionIndex: 1331.5 },
      { definitionIndex: 1331, playerId: "someone-else" }]) {
      expect((await request(app).post(path).set("Authorization", bearer).send(body)).status).toBe(400);
    }
    expect(serviceMedals.redeem).not.toHaveBeenCalled();
    const denied = await request(app).post(path).set("Authorization", bearer).send({ definitionIndex: 1331 });
    expect(denied.status).toBe(409);
    expect(denied.headers["cache-control"]).toBe("no-store");
    expect(serviceMedals.redeem).toHaveBeenCalledWith(playerId, 1331);
  });
  it("keeps bounded node ingestion traffic separate from the browser request budget", async () => {
    const app = createApp({ rateLimits: { windowMs: 60_000, apiLimit: 1, authLimit: 1, nodeLimit: 2 } });
    expect((await request(app).get("/api/auth/me")).status).toBe(200);
    expect((await request(app).get("/api/auth/me")).status).toBe(429);
    // Missing service/credentials do not bypass the node limiter either.
    expect((await request(app).post("/api/node/v1/heartbeat").send({})).status).toBe(503);
    expect((await request(app).post("/api/node/v1/heartbeat").send({})).status).toBe(503);
    expect((await request(app).post("/api/node/v1/heartbeat").send({})).status).toBe(429);
  });
  it("pairs browser-approved launchers and serves bearer-authenticated client state", async () => {
    const deviceCode = "ab".repeat(32);
    const accessToken = "cd".repeat(32);
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const launcherDevices = {
      issue: vi.fn(async () => ({
        version: 1 as const,
        deviceCode,
        userCode: "B2G4-PLAY",
        verificationUrl: "https://play.back2go.net/?launcher_code=B2G4-PLAY",
        expiresAt: "2026-09-03T01:00:00.000Z",
        intervalSeconds: 2
      })),
      approve: vi.fn(async (_playerId: string, userCode: string) => ({
        version: 1 as const,
        status: "approved" as const,
        userCode,
        expiresAt: "2026-09-03T01:00:00.000Z"
      })),
      exchange: vi.fn(async () => ({
        version: 1 as const,
        status: "authorized" as const,
        accessToken,
        expiresAt: "2026-12-02T01:00:00.000Z"
      })),
      authenticate: vi.fn(async () => ({
        credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId,
        expiresAt: "2026-12-02T01:00:00.000Z"
      })),
      revoke: vi.fn(async () => undefined)
    };
    const app = createApp({
      devIdentity: {
        playerId,
        steamId: "76561198000000000",
        displayName: "Launcher Player"
      },
      launcherDevices
    });
    const agent = request.agent(app);

    const authorization = await request(app)
      .post("/api/launcher/v1/device/authorizations")
      .send({});
    expect(authorization.status).toBe(201);
    expect(authorization.body.userCode).toBe("B2G4-PLAY");
    expect(authorization.headers["cache-control"]).toBe("no-store");

    const exchange = await request(app)
      .post("/api/launcher/v1/device/token")
      .send({ deviceCode, deviceName: "Max's PC" });
    expect(exchange.status).toBe(200);
    expect(exchange.body.accessToken).toBe(accessToken);
    expect(launcherDevices.exchange).toHaveBeenCalledWith(deviceCode, "Max's PC");

    const missingBearer = await request(app).get("/api/launcher/v1/bootstrap");
    expect(missingBearer.status).toBe(401);
    const bootstrap = await request(app)
      .get("/api/launcher/v1/bootstrap")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.player.id).toBe(playerId);
    expect(bootstrap.body.gameProfile).toMatchObject({
      steamId: "76561198000000000",
      competitiveRankId: expect.any(Number),
      playerLevel: 3,
      playerXp: 0,
      serviceDropCount: 0,
      b2gInventoryVersion: 0
    });
    expect(bootstrap.body.launcher).toMatchObject({
      content: {
        version: 1,
        releaseVersion: B2G_RELEASE.launcherVersion,
        history: B2G_RELEASE.history,
        channel: "Founders Playtest",
        changelog: {
          title: B2G_RELEASE.changelog.title
        },
        news: {
          title: B2G_RELEASE.news.title
        }
      }
    });
    expect(bootstrap.headers["cache-control"]).toBe("no-store");

    const queued = await request(app)
      .post("/api/launcher/v1/queue/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ regions: ["NA Central"], maps: [], mode: "deathmatch" });
    expect(queued.status).toBe(201);
    expect(queued.body.mode).toBe("deathmatch");
    const cleanupPath = "/api/launcher/v1/queue/session-ended";
    expect((await request(app).post(cleanupPath).send({ ticketId: queued.body.ticketId })).status).toBe(401);
    expect((await request(app).post(cleanupPath).set("Authorization", `Bearer ${accessToken}`).send({})).status).toBe(400);
    const closed = await request(app).post(cleanupPath)
      .set("Authorization", `Bearer ${accessToken}`).send({ ticketId: queued.body.ticketId });
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ released: true });
    const repeated = await request(app).post(cleanupPath)
      .set("Authorization", `Bearer ${accessToken}`).send({ ticketId: queued.body.ticketId });
    expect(repeated.body).toEqual({ released: false });

    const rejectedApproval = await agent
      .post("/api/launcher/v1/device/approve")
      .send({ userCode: "B2G4-PLAY" });
    expect(rejectedApproval.status).toBe(403);
    const csrf = (await agent.get("/api/auth/csrf")).body.token as string;
    const approved = await agent
      .post("/api/launcher/v1/device/approve")
      .set("X-CSRF-Token", csrf)
      .send({ userCode: "B2G4-PLAY" });
    expect(approved.status).toBe(200);
    expect(launcherDevices.approve).toHaveBeenCalledWith(playerId, "B2G4-PLAY");

    const revoked = await request(app)
      .post("/api/launcher/v1/device/revoke")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
    expect(revoked.status).toBe(200);
    expect(launcherDevices.revoke).toHaveBeenCalledWith(accessToken);
  });

  it("resolves a native Steam lobby to active B2G launchers before grouped queueing", async () => {
    const leaderId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const memberId = "a2bff0d2-960f-4d86-b064-554e97b1581a";
    const leaderSteamId = "76561198000000001";
    const memberSteamId = "76561198000000002";
    const accessToken = "ef".repeat(32);
    const joinVerifiedParty = vi.fn(async (request) => ({
      mode: request.mode ?? "competitive",
      phase: "searching" as const,
      joinedAt: new Date().toISOString(),
      regions: [...request.regions],
      maps: [...request.maps],
      playersFound: 2,
      estimatedWaitSeconds: 0,
      ratingWindow: 50
    }));
    const queueService = Object.assign(
      new QueueService({ autoMatchDelayMs: null, readyCheckSeconds: 20 }),
      { joinVerifiedParty }
    );
    let memberLauncherActive = true;
    const sql = vi.fn(async () => [
      {
        id: leaderId,
        steam_id: leaderSteamId,
        ingame_name_set_at: new Date(),
        launcher_active: memberLauncherActive
      },
      {
        id: memberId,
        steam_id: memberSteamId,
        ingame_name_set_at: new Date(),
        launcher_active: true
      }
    ]) as unknown as Sql;
    const playerReads = {
      getPlayerView: vi.fn(async () => ({ onboardingRequired: false }))
    } as unknown as PlayerReadService;
    const launcherDevices = {
      authenticate: vi.fn(async () => ({
        credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId: leaderId,
        expiresAt: "2026-12-02T01:00:00.000Z"
      }))
    };
    const app = createApp({
      sql,
      playerReads,
      queueService,
      launcherDevices: launcherDevices as never
    });

    const queued = await request(app)
      .post("/api/launcher/v1/queue/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        regions: ["NA Central"],
        maps: ["Mirage", "Inferno"],
        mode: "competitive",
        nativeParty: {
          steamLobbyId: "109775241234567890",
          memberSteamIds: [leaderSteamId, memberSteamId]
        }
      });

    expect(queued.status).toBe(201);
    expect(queued.body.playersFound).toBe(2);
    expect(joinVerifiedParty).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: leaderId, mode: "competitive" }),
      {
        partyId: "steam-lobby:109775241234567890",
        leaderPlayerId: leaderId,
        memberPlayerIds: [leaderId, memberId]
      }
    );

    memberLauncherActive = false;
    const inactiveMember = await request(app)
      .post("/api/launcher/v1/queue/join")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        regions: ["NA Central"],
        maps: ["Mirage"],
        mode: "competitive",
        nativeParty: {
          steamLobbyId: "109775241234567890",
          memberSteamIds: [leaderSteamId, memberSteamId]
        }
      });
    expect(inactiveMember.status).toBe(409);
    expect(inactiveMember.body.error).toContain("Every Steam lobby member must have B2G Launcher open");
    expect(joinVerifiedParty).toHaveBeenCalledTimes(1);
  });

  it("returns bounded authoritative profiles to the authenticated in-game party UI", async () => {
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const accessToken = "91".repeat(32);
    const sql = vi.fn(async () => [
      {
        steam_id: "76561198000000001",
        rating: 1_525,
        wins: 42,
        profile_level: 4,
        profile_xp: 380
      },
      {
        steam_id: "76561198000000002",
        rating: 2_500,
        wins: 900,
        profile_level: 40,
        profile_xp: 999
      }
    ]) as unknown as Sql;
    const launcherDevices = {
      authenticate: vi.fn(async () => ({
        credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId,
        expiresAt: "2026-12-02T01:00:00.000Z"
      }))
    };
    const app = createApp({ sql, launcherDevices: launcherDevices as never });

    expect((await request(app)
      .post("/api/launcher/v1/player-profiles")
      .send({ accountIds: [39_734_273] })).status).toBe(401);

    const response = await request(app)
      .post("/api/launcher/v1/player-profiles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ accountIds: [39_734_274, 39_734_273] });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
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
        }
      ]
    });
    expect(launcherDevices.authenticate).toHaveBeenCalledWith(accessToken);
    expect(sql).toHaveBeenCalledTimes(1);

    const duplicate = await request(app)
      .post("/api/launcher/v1/player-profiles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ accountIds: [39_734_273, 39_734_273] });
    expect(duplicate.status).toBe(400);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("issues launcher-authenticated latency challenges without browser cookies", async () => {
    const accessToken = "12".repeat(32);
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const launcherDevices = {
      issue: vi.fn(),
      approve: vi.fn(),
      exchange: vi.fn(),
      authenticate: vi.fn(async () => ({
        credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId,
        expiresAt: "2026-12-02T01:00:00.000Z"
      })),
      revoke: vi.fn()
    };
    const latencyProbes = {
      issue: vi.fn(async () => ({
        version: 1 as const,
        challengeId: "74c5fd31-5a64-499f-8180-a6976ba3bd53",
        expiresAt: "2026-09-03T01:00:00.000Z",
        endpoints: [{ region: "NA Central", server: "game.example.test:27015", samples: 5 }],
        launcherUrl: "b2g://probe?challenge=fixture"
      })),
      submit: vi.fn(),
      status: vi.fn(),
      assertFresh: vi.fn(),
      regions: vi.fn(() => ["NA Central"])
    };
    const app = createApp({ launcherDevices, latencyProbes });

    expect((await request(app)
      .post("/api/launcher/v1/latency/challenges")
      .send({ regions: ["NA Central"] })).status).toBe(401);
    const challenge = await request(app)
      .post("/api/launcher/v1/latency/challenges")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ regions: ["NA Central"] });
    expect(challenge.status).toBe(201);
    expect(challenge.body).toMatchObject({ enabled: true, launcherUrl: "b2g://probe?challenge=fixture" });
    expect(latencyProbes.issue).toHaveBeenCalledWith(playerId, ["NA Central"]);
    expect(challenge.headers["cache-control"]).toBe("no-store");
  });

  it("protects owned-inventory refresh and loadout writes with auth and CSRF", async () => {
    const view = {
      status: "public" as const,
      refreshedAt: "2026-09-02T12:00:00.000Z",
      nextRefreshAt: "2026-09-02T12:05:00.000Z",
      itemCount: 1,
      items: [],
      serverApplication: "owned-native-loadout" as const
    };
    const inventory = {
      view: vi.fn(async () => view),
      refresh: vi.fn(async () => view),
      saveLoadout: vi.fn(async () => view)
    };
    const app = createApp({
      devIdentity: {
        playerId: "6dcd25d0-1954-4d15-8497-fb37bdff48bd",
        steamId: "76561198000000000",
        displayName: "Inventory Player"
      },
      inventory
    });
    const agent = request.agent(app);

    expect((await agent.get("/api/account/inventory")).status).toBe(200);
    expect((await agent.post("/api/account/inventory/refresh")).status).toBe(403);
    const csrf = (await agent.get("/api/auth/csrf")).body.token as string;
    expect((await agent.post("/api/account/inventory/refresh").set("X-CSRF-Token", csrf)).status).toBe(200);
    expect((await agent.put("/api/account/loadout").set("X-CSRF-Token", csrf).send({
      selections: [{ weaponKey: "ak47", assetId: "1234567890123456789" }]
    })).status).toBe(200);
    expect(inventory.saveLoadout).toHaveBeenCalledWith(
      "6dcd25d0-1954-4d15-8497-fb37bdff48bd",
      [{ weaponKey: "ak47", assetId: "1234567890123456789" }]
    );
  });

  it("serves match-scoped launcher inventory with a strict bearer grant and no cache", async () => {
    const grantId = "74c5fd31-5a64-499f-8180-a6976ba3bd53";
    const token = "aB".repeat(32);
    const bundle = {
      version: 1 as const,
      matchId: "19483b60-4c46-45ef-907f-40cdf74304ee",
      expiresAt: "2026-09-02T13:00:00.000Z",
      schemaSha256: "cd".repeat(32),
      players: []
    };
    const inventory = {
      view: vi.fn(),
      refresh: vi.fn(),
      saveLoadout: vi.fn(),
      launcherBundle: vi.fn(async () => bundle)
    };
    const app = createApp({ inventory });

    const rejected = await request(app).get(`/api/launcher/v1/inventory/${grantId}`);
    expect(rejected.status).toBe(401);

    const accepted = await request(app)
      .get(`/api/launcher/v1/inventory/${grantId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual(bundle);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(accepted.headers["x-content-type-options"]).toBe("nosniff");
    expect(inventory.launcherBundle).toHaveBeenCalledWith(grantId, token.toLowerCase());
  });

  it("scopes launcher inventory viewing and Steam refresh to the authenticated account", async () => {
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const result = { status: "public" as const, refreshedAt: null, nextRefreshAt: "2026-09-08T00:00:00Z",
      itemCount: 0, items: [], serverApplication: "owned-native-loadout" as const };
    const inventory = { view: vi.fn(async () => result), refresh: vi.fn(async () => result), saveLoadout: vi.fn() };
    const launcherDevices = { issue: vi.fn(), approve: vi.fn(), exchange: vi.fn(), revoke: vi.fn(),
      authenticate: vi.fn(async () => ({ credentialId: playerId, playerId, expiresAt: "2026-12-02T01:00:00Z" })) };
    const app = createApp({ inventory, launcherDevices });
    const path = "/api/launcher/v1/account/inventory";
    const bearer = `Bearer ${"ab".repeat(32)}`;
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).post(`${path}/refresh`).send({})).status).toBe(401);
    expect(inventory.view).not.toHaveBeenCalled();
    expect(inventory.refresh).not.toHaveBeenCalled();
    const view = await request(app).get(path).set("Authorization", bearer);
    expect(view.status).toBe(200);
    expect(view.headers["cache-control"]).toBe("private, no-store");
    expect(inventory.view).toHaveBeenCalledWith(playerId);
    expect((await request(app).post(`${path}/refresh`).set("Authorization", bearer).send({ playerId: "other" })).status).toBe(400);
    expect(inventory.refresh).not.toHaveBeenCalled();
    expect((await request(app).post(`${path}/refresh`).set("Authorization", bearer).send({})).status).toBe(200);
    expect(inventory.refresh).toHaveBeenCalledWith(playerId);
    inventory.refresh.mockRejectedValueOnce(new InventoryError(429, "Inventory was refreshed recently."));
    expect((await request(app).post(`${path}/refresh`).set("Authorization", bearer).send({})).status).toBe(429);
  });

  it("serves paired-account inventory without exposing a match grant to the game", async () => {
    const accessToken = "ef".repeat(32);
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const bundle = {
      version: 1 as const,
      matchId: "19483b60-4c46-45ef-907f-40cdf74304ee",
      expiresAt: "2026-09-03T01:00:00.000Z",
      schemaSha256: "cd".repeat(32),
      players: []
    };
    const inventory = {
      view: vi.fn(),
      refresh: vi.fn(),
      saveLoadout: vi.fn(),
      launcherAccountBundle: vi.fn(async () => bundle)
    };
    const launcherDevices = {
      issue: vi.fn(),
      approve: vi.fn(),
      exchange: vi.fn(),
      authenticate: vi.fn(async () => ({
        credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId,
        expiresAt: "2026-12-02T01:00:00.000Z"
      })),
      revoke: vi.fn()
    };
    const app = createApp({ inventory, launcherDevices });

    expect((await request(app).get("/api/launcher/v1/inventory")).status).toBe(401);
    const accepted = await request(app)
      .get("/api/launcher/v1/inventory")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual(bundle);
    expect(inventory.launcherAccountBundle).toHaveBeenCalledWith(playerId);
    expect(accepted.headers["cache-control"]).toBe("no-store");
  });

  it("opens only bearer-authenticated B2G cases without browser CSRF", async () => {
    const accessToken = "fa".repeat(32);
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const caseAssetId = "8000000000000000100";
    const keyAssetId = "8000000000000000101";
    const result = {
      oddsVersion: "b2g-cases-v2",
      alreadyOpened: false,
      itemName: "M9 Bayonet | Doppler",
      item: {
        assetId: "8000000000000000102",
        source: "b2g" as const,
        itemKind: "cosmetic" as const,
        definitionIndex: 508,
        weaponKey: "knife_m9_bayonet",
        inventoryPosition: 1_073_741_829,
        paintIndex: 38,
        paintWear: 0.01,
        paintSeed: 500,
        quality: 3,
        rarity: 6,
        origin: 8,
        killEaterScoreType: null,
        killEaterValue: null,
        customName: null,
        stickers: [],
        loadoutSlot: 0,
        equipped: false
      }
    };
    const inventory = {
      view: vi.fn(),
      refresh: vi.fn(),
      saveLoadout: vi.fn(),
      openB2GCase: vi.fn(async () => result)
    };
    const launcherDevices = {
      issue: vi.fn(),
      approve: vi.fn(),
      exchange: vi.fn(),
      authenticate: vi.fn(async () => ({
        credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId,
        expiresAt: "2026-12-02T01:00:00.000Z"
      })),
      revoke: vi.fn()
    };
    const app = createApp({ inventory, launcherDevices });
    expect((await request(app).post("/api/launcher/v1/cases/open").send({
      caseAssetId,
      keyAssetId
    })).status).toBe(401);
    const opened = await request(app)
      .post("/api/launcher/v1/cases/open")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ caseAssetId });
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual(result);
    expect(opened.headers["cache-control"]).toBe("no-store");
    expect(inventory.openB2GCase).toHaveBeenCalledWith(playerId, caseAssetId, undefined);
  });

  it("executes only bearer-authenticated authoritative B2G Trade Up Contracts", async () => {
    const accessToken = "fb".repeat(32);
    const playerId = "6dcd25d0-1954-4d15-8497-fb37bdff48bd";
    const inputAssetIds = Array.from(
      { length: 10 },
      (_, index) => (8_000_000_000_000_001_000n + BigInt(index)).toString()
    );
    const result = {
      alreadyCompleted: false,
      inputAssetIds,
      recipeIndex: 2,
      item: {
        assetId: "8000000000000002000",
        source: "b2g" as const,
        itemKind: "cosmetic" as const,
        definitionIndex: 4,
        weaponKey: "glock",
        inventoryPosition: 1_073_741_841,
        paintIndex: 48,
        paintWear: 0.04,
        paintSeed: 500,
        quality: 4,
        rarity: 4,
        origin: 8,
        killEaterScoreType: null,
        killEaterValue: null,
        customName: null,
        stickers: [],
        loadoutSlot: 2,
        equipped: false
      }
    };
    const inventory = {
      view: vi.fn(),
      refresh: vi.fn(),
      saveLoadout: vi.fn(),
      tradeUpB2G: vi.fn(async () => result)
    };
    const launcherDevices = {
      issue: vi.fn(),
      approve: vi.fn(),
      exchange: vi.fn(),
      authenticate: vi.fn(async () => ({
        credentialId: "18c2b63a-fb09-41c8-9cc9-0b19b26722a8",
        playerId,
        expiresAt: "2026-12-02T01:00:00.000Z"
      })),
      revoke: vi.fn()
    };
    const app = createApp({ inventory, launcherDevices });
    expect((await request(app).post("/api/launcher/v1/trade-ups").send({
      inputAssetIds
    })).status).toBe(401);
    expect((await request(app)
      .post("/api/launcher/v1/trade-ups")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ inputAssetIds: [...inputAssetIds.slice(0, 9), inputAssetIds[0]] })).status).toBe(400);
    const traded = await request(app)
      .post("/api/launcher/v1/trade-ups")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ inputAssetIds });
    expect(traded.status).toBe(200);
    expect(traded.body).toEqual(result);
    expect(traded.headers["cache-control"]).toBe("no-store");
    expect(inventory.tradeUpB2G).toHaveBeenCalledWith(playerId, inputAssetIds);
  });

  it("returns auth state for unauthenticated requests", async () => {
    const app = createTestApp();
    const response = await request(app).get("/api/auth/me");
    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(false);
  });

  it("rejects protected routes without auth", async () => {
    const app = createTestApp();
    const response = await request(app).get("/api/bootstrap");
    expect(response.status).toBe(401);
  });

  it("returns 200 for health check", async () => {
    const app = createTestApp();
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("reports dependency readiness independently from liveness", async () => {
    const app = createApp({
      readiness: async () => ({
        ready: false,
        checks: { redis: { status: "error" } }
      })
    });
    const response = await request(app).get("/ready");
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("not-ready");
  });

  it("requires a session-bound CSRF token for mutations", async () => {
    const app = createApp({
      devIdentity: {
        playerId: "csrf-player",
        steamId: "csrf-steam",
        displayName: "CSRF Player"
      }
    });
    const agent = request.agent(app);

    const rejected = await agent.post("/api/queue/leave");
    expect(rejected.status).toBe(403);

    const tokenResponse = await agent.get("/api/auth/csrf");
    const accepted = await agent
      .post("/api/queue/leave")
      .set("X-CSRF-Token", tokenResponse.body.token);
    expect(accepted.status).toBe(200);
  });

  it("separates browser-authenticated latency challenges from one-use launcher reports", async () => {
    const calls: {
      issued?: { playerId: string; regions: string[] };
      submitted?: { token: string; signature: string; challengeId: string };
      asserted?: { playerIds: string[]; regions: string[] };
    } = {};
    const status = {
      enabled: true,
      regions: ["NA Central"],
      measurements: [{
        region: "NA Central",
        server: "127.0.0.1:27015",
        requestedSamples: 5,
        successfulSamples: 5,
        medianMs: 18,
        p95Ms: 24,
        packetLossPercent: 0,
        measuredAt: "2026-08-29T20:00:00.000Z",
        validUntil: "2026-08-29T20:15:00.000Z"
      }]
    };
    const app = createApp({
      devIdentity: {
        playerId: "latency-player",
        steamId: "latency-steam",
        displayName: "Latency Player"
      },
      latencyProbes: {
        regions: () => ["NA Central"],
        status: async () => status,
        issue: async (playerId, regions) => {
          calls.issued = { playerId, regions };
          return {
            version: 1,
            challengeId: "74c5fd31-5a64-499f-8180-a6976ba3bd53",
            expiresAt: "2026-08-29T20:02:00.000Z",
            endpoints: [{ region: "NA Central", server: "127.0.0.1:27015", samples: 5 }],
            launcherUrl: "b2g://probe?challenge=redacted"
          };
        },
        submit: async (token, signature, submission) => {
          calls.submitted = { token, signature, challengeId: submission.challengeId };
          return status;
        },
        assertFresh: async (playerIds, regions) => {
          calls.asserted = { playerIds, regions };
        }
      }
    });
    const agent = request.agent(app);

    const visible = await agent.get("/api/latency-probes");
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual(status);

    const rejectedChallenge = await agent
      .post("/api/latency-probes/challenges")
      .send({ regions: ["NA Central"] });
    expect(rejectedChallenge.status).toBe(403);
    expect(calls.issued).toBeUndefined();

    const csrf = (await agent.get("/api/auth/csrf")).body.token as string;
    const challenge = await agent
      .post("/api/latency-probes/challenges")
      .set("X-CSRF-Token", csrf)
      .send({ regions: ["NA Central"] });
    expect(challenge.status).toBe(201);
    expect(calls.issued).toEqual({ playerId: "latency-player", regions: ["NA Central"] });

    const token = "a".repeat(64);
    const report = await request(app)
      .post("/api/latency/v1/reports")
      .set("Authorization", `Bearer ${token}`)
      .set("X-B2G-Probe-Signature", "signed-report")
      .send({
        version: 1,
        challengeId: challenge.body.challengeId,
        measurements: [{
          region: "NA Central",
          server: "127.0.0.1:27015",
          requestedSamples: 5,
          successfulSamples: 5,
          medianMs: 18,
          p95Ms: 24,
          packetLossPercent: 0
        }]
      });
    expect(report.status).toBe(200);
    expect(calls.submitted).toEqual({
      token,
      signature: "signed-report",
      challengeId: challenge.body.challengeId
    });

    const queued = await agent
      .post("/api/queue/join")
      .set("X-CSRF-Token", csrf)
      .send({ regions: ["NA Central"], maps: ["Mirage"] });
    expect(queued.status).toBe(201);
    expect(calls.asserted).toEqual({
      playerIds: ["latency-player"],
      regions: ["NA Central"]
    });
  });

  it("exposes the authenticated party lifecycle", async () => {
    const parties = new PartyService();
    const leaderApp = createApp({
      partyService: parties,
      devIdentity: { playerId: "leader", steamId: "leader-steam", displayName: "Leader" }
    });
    const memberApp = createApp({
      partyService: parties,
      devIdentity: { playerId: "member", steamId: "member-steam", displayName: "Member" }
    });
    const leader = request.agent(leaderApp);
    const member = request.agent(memberApp);
    const leaderCsrf = (await leader.get("/api/auth/csrf")).body.token as string;
    const memberCsrf = (await member.get("/api/auth/csrf")).body.token as string;

    const created = await leader
      .post("/api/party")
      .set("X-CSRF-Token", leaderCsrf);
    expect(created.status).toBe(201);

    const invited = await leader
      .post("/api/party/invites")
      .set("X-CSRF-Token", leaderCsrf)
      .send({ playerId: "member" });
    expect(invited.status).toBe(201);

    const accepted = await member
      .post(`/api/party/invites/${invited.body.id}/accept`)
      .set("X-CSRF-Token", memberCsrf);
    expect(accepted.status).toBe(200);
    expect(accepted.body.members).toHaveLength(2);

    const ready = await member
      .patch("/api/party/ready")
      .set("X-CSRF-Token", memberCsrf)
      .send({ ready: true });
    expect(ready.body.members.every((candidate: { ready: boolean }) => candidate.ready)).toBe(true);

    const current = await leader.get("/api/party");
    expect(current.body.party.id).toBe(created.body.id);
  });

  it("serves paginated match history and rank-enriched party members", async () => {
    const playerId = "10000000-0000-4000-8000-000000000001";
    const app = createApp({
      playerReads: createE2EReadService(playerId),
      devIdentity: { playerId, steamId: "76561198000000000", displayName: "E2E Player" }
    });
    const agent = request.agent(app);

    const history = await agent.get(`/api/players/${playerId}/matches?limit=50&offset=0`);
    expect(history.status).toBe(200);
    expect(history.body.entries).toHaveLength(1);
    expect(history.body.total).toBe(143);

    const csrf = (await agent.get("/api/auth/csrf")).body.token as string;
    const party = await agent.post("/api/party").set("X-CSRF-Token", csrf);
    expect(party.status).toBe(201);
    expect(party.body.members[0]).toMatchObject({
      playerId,
      displayName: "E2E Player",
      initials: "EP",
      rank: { shortName: "DMG", rating: 1937 }
    });
  });
});
