import type { Express, Request } from "express";
import { z } from "zod";
import type { FriendsService } from "./friends-service.js";
import { LauncherDeviceError } from "./launcher-device-service.js";

export type FriendsServiceLike = Pick<FriendsService,"list"|"request"|"respond"|"profile">;
const offset=z.coerce.number().int().min(0).max(100_000).default(0);
export function registerFriendsRoutes(app:Express,service:FriendsServiceLike|undefined,
  authenticate:(req:Request)=>Promise<{playerId:string}>):void {
  function route(method:"get"|"post",path:string,handler:(s:FriendsServiceLike,p:string,r:Request)=>Promise<unknown>) {
    app[method]("/api/launcher/v1/social"+path,async(req,res,next)=>{
      res.set("Cache-Control","no-store");
      try {
        const {playerId}=await authenticate(req);
        if (!service) throw new LauncherDeviceError(503,"Friends are temporarily unavailable.");
        res.json(await handler(service,playerId,req));
      } catch(error) { next(error); }
    });
  }
  route("get","/friends",(s,p,r)=>{
    const q=z.object({folder:z.enum(["friends","incoming","outgoing","search"]).default("friends"),
      q:z.string().trim().max(80).default(""),offset}).strict().parse(r.query);
    if(q.folder==="search"&&q.q.length<2) throw new LauncherDeviceError(400,"Enter at least two characters to find a player.");
    return s.list(p,q.folder,q.q,q.offset);
  });
  route("post","/requests",(s,p,r)=>{
    const body=z.object({playerId:z.string().uuid(),requestId:z.string().uuid()}).strict().parse(r.body);
    return s.request(p,body.playerId,body.requestId);
  });
  route("post","/requests/:requestId",(s,p,r)=>{
    const {requestId}=z.object({requestId:z.string().uuid()}).parse(r.params);
    const {action}=z.object({action:z.enum(["accept","decline","cancel","remove"])}).strict().parse(r.body);
    return s.respond(p,requestId,action);
  });
  route("get","/players/:playerId",(s,p,r)=>{
    const {playerId}=z.object({playerId:z.union([z.literal("me"),z.string().uuid()])}).parse(r.params);
    const q=z.object({mode:z.enum(["competitive","deathmatch"]).default("competitive"),offset}).strict().parse(r.query);
    return s.profile(p,playerId==="me"?p:playerId,q.mode,q.offset);
  });
}
