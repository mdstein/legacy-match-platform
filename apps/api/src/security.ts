import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { rateLimit, type Store } from "express-rate-limit";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

export function csrfToken(req: Request, res: Response) {
  req.session.csrfToken ??= randomBytes(32).toString("base64url");
  res.setHeader("Cache-Control", "no-store");
  res.json({ token: req.session.csrfToken });
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  const supplied = req.get("x-csrf-token") ?? "";
  const expected = req.session.csrfToken ?? "";
  if (!supplied || !expected || !safeEqual(supplied, expected)) {
    res.status(403).json({ error: "Invalid or missing CSRF token." });
    return;
  }

  next();
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  store?: Store | undefined;
  identifier: string;
}

export function createRateLimiter(options: RateLimiterOptions) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    identifier: options.identifier,
    ...(options.store ? { store: options.store } : {}),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please retry later." },
    skip: (req) => req.path === "/health" || req.path === "/ready"
  });
}
