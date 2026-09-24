import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { verifySteamLogin } from "../src/auth/steam.js";

const STEAM_ID = "76561198000000000";
const PREVIEW_ORIGIN = "http://127.0.0.1:4173";

function callbackFromRedirect(location: string): URL {
  const providerUrl = new URL(location);
  const returnTo = providerUrl.searchParams.get("openid.return_to");
  if (!returnTo) throw new Error("Steam redirect is missing openid.return_to.");
  return new URL(returnTo);
}

function requiredLocation(value: unknown): string {
  if (typeof value !== "string") throw new Error("Response is missing a redirect location.");
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Steam OpenID", () => {
  it("uses the public request origin and completes a session without Postgres", async () => {
    const verifyLogin = vi.fn(async () => STEAM_ID);
    const loadProfile = vi.fn(async () => ({
      steamId: STEAM_ID,
      displayName: "Test Captain",
      avatarUrl: ""
    }));
    const app = createApp({ auth: { verifyLogin, loadProfile } });
    const agent = request.agent(app);

    const loginResponse = await agent
      .get("/api/auth/steam")
      .set("Host", "127.0.0.1:4173");

    expect(loginResponse.status).toBe(302);
    const loginLocation = requiredLocation(loginResponse.headers.location);
    const providerUrl = new URL(loginLocation);
    expect(providerUrl.origin).toBe("https://steamcommunity.com");
    expect(providerUrl.pathname).toBe("/openid/login");
    expect(providerUrl.searchParams.get("openid.realm")).toBe(PREVIEW_ORIGIN);

    const returnUrl = callbackFromRedirect(loginLocation);
    expect(returnUrl.origin).toBe(PREVIEW_ORIGIN);
    expect(returnUrl.pathname).toBe("/api/auth/steam/callback");
    expect(returnUrl.searchParams.get("state")).toBeTruthy();

    const callbackParams = new URLSearchParams(returnUrl.search);
    callbackParams.set("openid.return_to", returnUrl.toString());
    const callbackResponse = await agent
      .get(`${returnUrl.pathname}?${callbackParams.toString()}`)
      .set("Host", "127.0.0.1:4173");

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.location).toBe(`${PREVIEW_ORIGIN}/`);
    expect(verifyLogin).toHaveBeenCalledOnce();
    expect(loadProfile).toHaveBeenCalledWith(STEAM_ID);

    const authResponse = await agent
      .get("/api/auth/me")
      .set("Host", "127.0.0.1:4173");
    expect(authResponse.body).toMatchObject({
      authenticated: true,
      steamId: STEAM_ID,
      displayName: "Test Captain"
    });

    const bootstrapResponse = await agent
      .get("/api/bootstrap")
      .set("Host", "127.0.0.1:4173");
    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.body.player.displayName).toBe("Test Captain");
    expect(bootstrapResponse.body.player.initials).toBe("TC");

    const csrfResponse = await agent.get("/api/auth/csrf");
    const resetResponse = await agent
      .post("/api/dev/reset")
      .set("X-CSRF-Token", csrfResponse.body.token)
      .set("Host", "127.0.0.1:4173");
    expect(resetResponse.status).toBe(200);
    expect(resetResponse.body.player.displayName).toBe("Test Captain");
    expect(resetResponse.body.player.initials).toBe("TC");
  });

  it("returns a signed-in player to the local launcher approval page", async () => {
    const verifyLogin = vi.fn(async () => STEAM_ID);
    const app = createApp({
      auth: {
        verifyLogin,
        loadProfile: async () => ({
          steamId: STEAM_ID,
          displayName: "Test Captain",
          avatarUrl: ""
        })
      }
    });
    const agent = request.agent(app);
    const localReturnTo = "/?launcher_code=B2G4-PLAY";
    const loginResponse = await agent
      .get("/api/auth/steam")
      .query({ returnTo: localReturnTo })
      .set("Host", "127.0.0.1:4173");
    const returnUrl = callbackFromRedirect(requiredLocation(loginResponse.headers.location));
    const callbackParams = new URLSearchParams(returnUrl.search);
    callbackParams.set("openid.return_to", returnUrl.toString());

    const callbackResponse = await agent
      .get(`${returnUrl.pathname}?${callbackParams.toString()}`)
      .set("Host", "127.0.0.1:4173");

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.location).toBe(`${PREVIEW_ORIGIN}${localReturnTo}`);
  });

  it.each([
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "/\\\\attacker.example/steal"
  ])("does not redirect Steam login to an external return target: %s", async (returnTo) => {
    const app = createApp({
      auth: {
        verifyLogin: async () => STEAM_ID,
        loadProfile: async () => ({
          steamId: STEAM_ID,
          displayName: "Test Captain",
          avatarUrl: ""
        })
      }
    });
    const agent = request.agent(app);
    const loginResponse = await agent
      .get("/api/auth/steam")
      .query({ returnTo })
      .set("Host", "127.0.0.1:4173");
    const returnUrl = callbackFromRedirect(requiredLocation(loginResponse.headers.location));
    const callbackParams = new URLSearchParams(returnUrl.search);
    callbackParams.set("openid.return_to", returnUrl.toString());

    const callbackResponse = await agent
      .get(`${returnUrl.pathname}?${callbackParams.toString()}`)
      .set("Host", "127.0.0.1:4173");

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.location).toBe(`${PREVIEW_ORIGIN}/`);
  });

  it("rejects a callback whose login state does not match the session", async () => {
    const verifyLogin = vi.fn(async () => STEAM_ID);
    const app = createApp({
      auth: {
        verifyLogin,
        loadProfile: async () => ({
          steamId: STEAM_ID,
          displayName: "Test Captain",
          avatarUrl: ""
        })
      }
    });
    const agent = request.agent(app);
    const loginResponse = await agent
      .get("/api/auth/steam")
      .set("Host", "127.0.0.1:4173");
    const returnUrl = callbackFromRedirect(requiredLocation(loginResponse.headers.location));
    const callbackParams = new URLSearchParams(returnUrl.search);
    callbackParams.set("state", "tampered-state");
    callbackParams.set("openid.return_to", returnUrl.toString());

    const response = await agent
      .get(`${returnUrl.pathname}?${callbackParams.toString()}`)
      .set("Host", "127.0.0.1:4173");

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(
      `${PREVIEW_ORIGIN}/?error=steam_auth_state`
    );
    expect(verifyLogin).not.toHaveBeenCalled();
  });

  it("verifies the signed Steam identity with the provider", async () => {
    const claimedId = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n")
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifySteamLogin({
      "openid.claimed_id": claimedId,
      "openid.identity": claimedId,
      "openid.op_endpoint": "https://steamcommunity.com/openid/login",
      "openid.mode": "id_res"
    });

    expect(result).toBe(STEAM_ID);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://steamcommunity.com/openid/login",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("openid.mode=check_authentication")
      })
    );
  });

  it("rejects identities from a different OpenID endpoint", async () => {
    const claimedId = `https://steamcommunity.com/openid/id/${STEAM_ID}`;

    const result = await verifySteamLogin({
      "openid.claimed_id": claimedId,
      "openid.identity": claimedId,
      "openid.op_endpoint": "https://example.com/openid/login"
    });

    expect(result).toBeNull();
  });
});
