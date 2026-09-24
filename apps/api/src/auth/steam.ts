import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";
const STEAM_API_BASE = "https://api.steampowered.com";

const OPENID_PARAMS = {
  "openid.ns": "http://specs.openid.net/auth/2.0",
  "openid.mode": "checkid_setup",
  "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
  "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select"
} as const;

const STEAM_ID_PATTERN = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function describeAuthError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  return `${error.name}: ${error.message}`;
}

function requestBaseUrl(req: Request): string {
  const configured = process.env["AFTERTICK_PUBLIC_URL"];
  if (configured) return new URL(configured).origin;

  if (process.env["NODE_ENV"] === "production") {
    throw new Error("AFTERTICK_PUBLIC_URL is required in production.");
  }

  const host = req.get("host");
  if (!host) throw new Error("Request host is missing.");
  return `${req.protocol}://${host}`;
}

function callbackUrl(baseUrl: string, state: string): string {
  const url = new URL("/api/auth/steam/callback", `${baseUrl}/`);
  url.searchParams.set("state", state);
  return url.toString();
}

function safeLocalReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

export function steamLoginUrl(returnTo: string, realm: string): string {
  const params = new URLSearchParams({
    ...OPENID_PARAMS,
    "openid.return_to": returnTo,
    "openid.realm": realm
  });
  return `${STEAM_OPENID_URL}?${params.toString()}`;
}

export async function verifySteamLogin(
  query: Record<string, string>
): Promise<string | null> {
  const claimedId = query["openid.claimed_id"];
  if (!claimedId) return null;

  if (query["openid.identity"] !== claimedId) return null;
  if (query["openid.op_endpoint"] !== STEAM_OPENID_URL) return null;

  const match = STEAM_ID_PATTERN.exec(claimedId);
  if (!match?.[1]) return null;

  const verifyParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("openid.")) {
      verifyParams.set(key, value);
    }
  }
  verifyParams.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verifyParams.toString()
  });

  const body = await response.text();
  if (!body.includes("is_valid:true")) return null;

  return match[1];
}

export interface SteamProfile {
  steamId: string;
  displayName: string;
  avatarUrl: string;
}

export async function fetchSteamProfile(
  steamId: string
): Promise<SteamProfile | null> {
  const apiKey = process.env["STEAM_API_KEY"];
  if (!apiKey) {
    return {
      steamId,
      displayName: `Player_${steamId.slice(-6)}`,
      avatarUrl: ""
    };
  }

  const url = `${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(apiKey)}&steamids=${encodeURIComponent(steamId)}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = (await response.json()) as {
    response?: {
      players?: Array<{
        steamid: string;
        personaname: string;
        avatarmedium: string;
      }>;
    };
  };

  const player = data.response?.players?.[0];
  if (!player) return null;

  return {
    steamId: player.steamid,
    displayName: player.personaname,
    avatarUrl: player.avatarmedium
  };
}

export interface AuthRouteDeps {
  onLogin: (
    steamId: string,
    profile: SteamProfile
  ) => Promise<{ id: string; displayName: string }>;
  verifyLogin?: typeof verifySteamLogin;
  loadProfile?: typeof fetchSteamProfile;
}

export function buildAuthRoutes(deps: AuthRouteDeps) {
  const verifyLogin = deps.verifyLogin ?? verifySteamLogin;
  const loadProfile = deps.loadProfile ?? fetchSteamProfile;

  return {
    login(req: Request, res: Response, next: NextFunction) {
      try {
        const baseUrl = requestBaseUrl(req);
        const state = randomBytes(24).toString("base64url");
        const returnTo = callbackUrl(baseUrl, state);
        req.session.steamAuthState = state;
        req.session.steamAuthReturnTo = safeLocalReturnTo(req.query["returnTo"]);
        req.session.save((error) => {
          if (error) {
            next(error);
            return;
          }
          res.redirect(steamLoginUrl(returnTo, baseUrl));
        });
      } catch (error) {
        next(error);
      }
    },

    async callback(req: Request, res: Response) {
      let baseUrl: string | undefined;
      try {
        const resolvedBaseUrl = requestBaseUrl(req);
        baseUrl = resolvedBaseUrl;
        const providedState = typeof req.query["state"] === "string"
          ? req.query["state"]
          : "";
        const expectedState = req.session.steamAuthState ?? "";
        const localReturnTo = safeLocalReturnTo(req.session.steamAuthReturnTo);
        delete req.session.steamAuthState;
        delete req.session.steamAuthReturnTo;

        if (!providedState || !expectedState || !safeEqual(providedState, expectedState)) {
          res.redirect(`${resolvedBaseUrl}/?error=steam_auth_state`);
          return;
        }

        const expectedReturnTo = callbackUrl(resolvedBaseUrl, expectedState);
        if (req.query["openid.return_to"] !== expectedReturnTo) {
          res.redirect(`${resolvedBaseUrl}/?error=steam_auth_failed`);
          return;
        }

        const steamId = await verifyLogin(
          req.query as Record<string, string>
        );
        if (!steamId) {
          res.redirect(`${resolvedBaseUrl}/?error=steam_auth_failed`);
          return;
        }

        const profile = await loadProfile(steamId);
        if (!profile) {
          res.redirect(`${resolvedBaseUrl}/?error=steam_profile_failed`);
          return;
        }

        const player = await deps.onLogin(steamId, profile);

        req.session.regenerate((regenerateError) => {
          if (regenerateError) {
            res.redirect(`${resolvedBaseUrl}/?error=auth_error`);
            return;
          }

          req.session.playerId = player.id;
          req.session.steamId = steamId;
          req.session.displayName = player.displayName;
          req.session.save((saveError) => {
            if (saveError) {
              res.redirect(`${resolvedBaseUrl}/?error=auth_error`);
              return;
            }
            res.redirect(new URL(localReturnTo, `${resolvedBaseUrl}/`).toString());
          });
        });
      } catch (error) {
        // Do not log callback parameters: OpenID signatures and account details
        // should never be copied into preview or production logs.
        console.error("Steam auth callback failed:", describeAuthError(error));
        const fallbackBaseUrl = baseUrl
          ?? process.env["AFTERTICK_PUBLIC_URL"]
          ?? "http://127.0.0.1:5173";
        res.redirect(`${new URL(fallbackBaseUrl).origin}/?error=auth_error`);
      }
    },

    me(req: Request, res: Response) {
      if (!req.session.playerId) {
        res.json({ authenticated: false });
        return;
      }
      res.json({
        authenticated: true,
        playerId: req.session.playerId,
        steamId: req.session.steamId,
        displayName: req.session.displayName
      });
    },

    logout(req: Request, res: Response) {
      req.session.destroy(() => {
        res.json({ ok: true });
      });
    }
  };
}
