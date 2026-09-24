import type { Express, Request } from "express";
import { z } from "zod";
import { tradeTermsSchema, TradingError, type TradingService } from "./trading-service.js";

export type TradingServiceLike = Pick<TradingService,
  "overview" | "preferences" | "findPlayers" | "inventory" | "offer" | "offers" |
  "events" | "markSeen" | "create" | "counter" | "respond">;

const cursor = z.string().regex(/^[0-9]{1,18}$/);
const revision = z.number().int().min(1).max(100);
const requestId = z.string().uuid();
const offerId = z.object({ offerId: z.string().uuid() });

export function registerTradingRoutes(app: Express, service: TradingServiceLike | undefined,
  authenticate: (req: Request) => Promise<{ playerId: string }>): void {
  const prefix = "/api/launcher/v1/trading";
  function route(method: "get" | "post", path: string,
    handler: (service: TradingServiceLike, playerId: string, req: Request) => Promise<unknown>) {
    app[method](prefix+path, async (req,res,next) => {
      res.set("Cache-Control","no-store");
      res.set("X-Content-Type-Options","nosniff");
      try {
        const identity = await authenticate(req);
        if (!service) throw new TradingError(503,"trading_unavailable","Trading is unavailable.");
        res.json(await handler(service,identity.playerId,req));
      } catch (error) { next(error); }
    });
  }
  route("get","/overview",(s,p)=>s.overview(p));
  route("post","/preferences",(s,p,r)=>s.preferences(p,z.object({allowOffers:z.boolean()}).strict().parse(r.body).allowOffers));
  route("get","/players",(s,p,r)=>s.findPlayers(p,z.object({q:z.string().min(2).max(80)}).strict().parse(r.query).q));
  route("get","/inventory/:playerId",(s,p,r)=> {
    const ownerId = z.object({playerId:z.string().uuid()}).parse(r.params).playerId;
    const query = z.object({query:z.string().max(80).optional(),kind:z.enum(["case","cosmetic"]).optional(),
      rarity:z.coerce.number().int().min(0).max(7).optional(),cursor:z.string().regex(/^8[0-9]{18}$/).optional(),
      limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(r.query);
    return s.inventory(p,ownerId,{...query});
  });
  route("get","/offers",(s,p,r)=> {
    const query = z.object({folder:z.enum(["incoming","outgoing","history"]).default("incoming"),before:cursor.optional()}).strict().parse(r.query);
    return s.offers(p,query.folder,query.before);
  });
  route("get","/offers/:offerId",(s,p,r)=>s.offer(p,offerId.parse(r.params).offerId));
  route("post","/offers",(s,p,r)=> {
    const input = z.object({recipientId:z.string().uuid(),requestId,terms:tradeTermsSchema}).strict().parse(r.body);
    return s.create(p,input.recipientId,input.requestId,input.terms);
  });
  route("post","/offers/:offerId/counter",(s,p,r)=> {
    const input = z.object({revision,requestId,terms:tradeTermsSchema}).strict().parse(r.body);
    return s.counter(p,offerId.parse(r.params).offerId,input.revision,input.requestId,input.terms);
  });
  for (const action of ["accept","decline","cancel"] as const) {
    route("post",`/offers/:offerId/${action}`,(s,p,r)=> {
      const input = z.object({revision,requestId,confirmGift:z.boolean().default(false)}).strict().parse(r.body);
      return s.respond(p,offerId.parse(r.params).offerId,input.revision,input.requestId,action,input.confirmGift);
    });
  }
  route("get","/events",(s,p,r)=> {
    const query = z.object({after:cursor.default("0"),offerId:z.string().uuid().optional()}).strict().parse(r.query);
    return s.events(p,query.after,query.offerId);
  });
  route("post","/seen",async (s,p,r)=> {
    await s.markSeen(p,z.object({eventId:cursor}).strict().parse(r.body).eventId);
    return {ok:true};
  });
}
