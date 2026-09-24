import type { NextFunction, Request, Response } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.playerId) {
    next();
    return;
  }

  if (process.env["NODE_ENV"] !== "production" && process.env["DEV_PLAYER_ID"]) {
    req.session.playerId = process.env["DEV_PLAYER_ID"];
    req.session.steamId = "dev-steam-id";
    req.session.displayName = "Dev Player";
    next();
    return;
  }

  res.status(401).json({ error: "Not authenticated." });
}
