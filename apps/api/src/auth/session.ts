import session, { type Store } from "express-session";

declare module "express-session" {
  interface SessionData {
    playerId: string;
    steamId: string;
    displayName: string;
    steamAuthState: string;
    steamAuthReturnTo: string;
    csrfToken: string;
  }
}

export interface SessionMiddlewareOptions {
  store?: Store | undefined;
  secret?: string | undefined;
  secureCookies?: boolean | undefined;
}

export function createSessionMiddleware(options: SessionMiddlewareOptions = {}) {
  const secret = options.secret
    ?? process.env["SESSION_SECRET"]
    ?? "aftertick-development-session-secret-only";

  return session({
    name: "aftertick.sid",
    secret,
    store: options.store,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: options.secureCookies ?? process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  });
}
