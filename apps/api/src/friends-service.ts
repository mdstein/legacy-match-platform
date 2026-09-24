import type { FriendsPage, GameMode, LauncherSocialProfile, SocialPlayer } from "@aftertick/contracts";
import type { Sql } from "@aftertick/db";
import { getRank, RANKS } from "@aftertick/rating";
import type postgres from "postgres";
import { LauncherDeviceError } from "./launcher-device-service.js";

type Db = Sql | postgres.TransactionSql;
type Folder = "friends" | "incoming" | "outgoing" | "search";
type Action = "accept" | "decline" | "cancel" | "remove";
interface FriendRow { id: string; requester_id: string; recipient_id: string; status: string; updated_at: Date }
interface PersonRow {
  id: string; display_name: string; profile_visibility: string; online: boolean;
  request_id: string | null; requester_id: string | null; status: string | null;
}
const fail = (status: number, message: string): never => { throw new LauncherDeviceError(status, message); };
function person(row: PersonRow, viewer: string): SocialPlayer {
  const self = row.id === viewer;
  const hidden = !self && row.profile_visibility === "private";
  return { playerId: row.id, displayName: row.display_name, private: hidden,
    relationship: self ? "self" : row.status === "accepted" ? "friends" : row.status === "pending"
      ? row.requester_id === viewer ? "outgoing" : "incoming" : "none",
    requestId: row.request_id, online: hidden ? null : row.online };
}

export class FriendsService {
  constructor(private readonly sql: Sql) {}

  private people(db: Db, viewer: string) {
    return db`select p.id,p.display_name,p.profile_visibility,f.id as request_id,f.requester_id,f.status,
      exists(select 1 from launcher_credentials c where c.player_id=p.id and c.revoked_at is null
        and c.expires_at>now() and c.last_used_at>now()-interval '90 seconds') as online
      from players p left join player_friendships f on f.status in ('pending','accepted')
        and ((f.requester_id=${viewer} and f.recipient_id=p.id) or (f.recipient_id=${viewer} and f.requester_id=p.id))`;
  }
  private async identity(db: Db, viewer: string, target: string): Promise<SocialPlayer> {
    const [row] = await db<PersonRow[]>`${this.people(db,viewer)} where p.id=${target}`;
    if (!row) return fail(404,"Player not found.");
    return person(row,viewer);
  }
  async list(viewer: string, folder: Folder, query = "", offset = 0): Promise<FriendsPage> {
    return this.sql.begin(async db => {
      await db`set transaction isolation level repeatable read read only`;
      const condition = folder === "friends" ? db`f.status='accepted'` : folder === "incoming"
        ? db`f.status='pending' and f.recipient_id=${viewer}` : folder === "outgoing"
        ? db`f.status='pending' and f.requester_id=${viewer}`
        : db`p.id<>${viewer} and (position(lower(${query}) in lower(p.display_name))>0
          or p.id::text=lower(${query}) or exists(select 1 from b2g_trading_profiles t where t.player_id=p.id and t.trade_code=upper(${query})))`;
      const rows = await db<(PersonRow & { total: number })[]>`
        select q.*, count(*) over()::int as total from (${this.people(db,viewer)} where ${condition}) q
        order by lower(display_name),id limit 8 offset ${offset}`;
      const [counts] = await db<{ incoming: number; friends: number }[]>`
        select count(*) filter(where status='pending' and recipient_id=${viewer})::int as incoming,
          count(*) filter(where status='accepted')::int as friends
        from player_friendships where requester_id=${viewer} or recipient_id=${viewer}`;
      // An empty page may follow removal of its final entry. Count it so the client can recover.
      const total = rows[0]?.total ?? Number((await db`
        select count(*)::int as total from (${this.people(db,viewer)} where ${condition}) q`)[0]?.total ?? 0);
      return {entries:rows.map(row=>person(row,viewer)),total,offset,
        incomingCount:counts?.incoming ?? 0,friendCount:counts?.friends ?? 0};
    });
  }

  private async lockPair(db: postgres.TransactionSql, a: string, b: string) {
    const rows = await db`select id from players where id in (${a},${b}) order by id for update`;
    if (rows.length !== 2) fail(404,"Player not found.");
  }
  private async capacity(db: Db, players: string[], kind: "friends" | "requests") {
    for (const id of players) {
      const [row] = await db`select count(*)::int as total from player_friendships
        where ${kind === "friends" ? db`status='accepted' and (requester_id=${id} or recipient_id=${id})`
          : db`status='pending' and (requester_id=${id} or recipient_id=${id})`}`;
      if (Number(row?.total) >= (kind === "friends" ? 200 : 50))
        fail(409,kind === "friends" ? "One of these accounts has reached the 200-friend limit." : "One of these accounts has too many pending requests. Resolve them before trying again.");
    }
  }
  async request(viewer: string, target: string, requestId: string): Promise<SocialPlayer> {
    if (viewer === target) return fail(400,"You cannot add yourself.");
    try {
      return await this.sql.begin(async db => {
        await this.lockPair(db,viewer,target);
        const [retry] = await db<FriendRow[]>`select * from player_friendships where id=${requestId}`;
        if (retry) {
          if (retry.requester_id !== viewer || retry.recipient_id !== target) fail(409,"This request ID has already been used.");
          return this.identity(db,viewer,target);
        }
        const [active] = await db<FriendRow[]>`select * from player_friendships where status in ('pending','accepted')
          and ((requester_id=${viewer} and recipient_id=${target}) or (requester_id=${target} and recipient_id=${viewer}))`;
        // Crossed requests require an explicit Accept; never silently add a friend.
        if (active) return this.identity(db,viewer,target);
        const [recent] = await db`select id from player_friendships where updated_at>now()-interval '60 seconds'
          and ((requester_id=${viewer} and recipient_id=${target}) or (requester_id=${target} and recipient_id=${viewer})) limit 1`;
        if (recent) fail(429,"Wait a minute before sending another request to this player.");
        const [rate] = await db`select count(*)::int as total from player_friendships
          where requester_id=${viewer} and created_at>now()-interval '1 minute'`;
        if (Number(rate?.total) >= 10) fail(429,"You have sent several requests. Wait a minute before sending another.");
        await this.capacity(db,[viewer,target],"friends");
        await this.capacity(db,[viewer,target],"requests");
        await db`insert into player_friendships(id,requester_id,recipient_id,status) values(${requestId},${viewer},${target},'pending')`;
        return this.identity(db,viewer,target);
      });
    } catch (error) {
      if ((error as {code?:string}).code === "23505") return fail(409,"This request has already changed. Refresh and try again.");
      throw error;
    }
  }
  async respond(viewer: string, requestId: string, action: Action): Promise<SocialPlayer> {
    return this.sql.begin(async db => {
      const [initial] = await db<FriendRow[]>`select * from player_friendships where id=${requestId}
        and (requester_id=${viewer} or recipient_id=${viewer})`;
      if (!initial) return fail(404,"Friend request not found.");
      await this.lockPair(db,initial.requester_id,initial.recipient_id);
      const [row] = await db<FriendRow[]>`select * from player_friendships where id=${requestId} for update`;
      if (!row) return fail(404,"Friend request not found.");
      if ((action === "accept" || action === "decline") && row.recipient_id !== viewer || action === "cancel" && row.requester_id !== viewer)
        fail(403,"You cannot perform that action on this request.");
      const next = {accept:"accepted",decline:"declined",cancel:"cancelled",remove:"removed"}[action];
      if (row.status !== next) {
        if (row.status !== (action === "remove" ? "accepted" : "pending")) fail(409,"This request has changed. Refresh to see its current status.");
        if (action === "accept") await this.capacity(db,[row.requester_id,row.recipient_id],"friends");
        await db`update player_friendships set status=${next},updated_at=now() where id=${requestId}`;
      }
      return this.identity(db,viewer,row.requester_id === viewer ? row.recipient_id : row.requester_id);
    });
  }

  async profile(viewer: string, target: string, mode: GameMode, offset = 0): Promise<LauncherSocialProfile> {
    return this.sql.begin(async db => {
      await db`set transaction isolation level repeatable read read only`;
      const player = await this.identity(db,viewer,target);
      const result: LauncherSocialProfile = {player,mode,region:null,memberSince:null,steamProfileUrl:null,
        rank:null,rankId:null,level:null,stats:null,recentMatches:[],matchTotal:0,matchOffset:offset};
      if (player.private) return result;
      const [row] = await db<{region:string;created_at:Date;steam_id:string|null;rating:number;profile_level:number}[]>`
        select region,created_at,steam_id,rating,profile_level from players where id=${target}`;
      if (!row) return fail(404,"Player not found.");
      const rank = getRank(row.rating);
      result.region=row.region; result.memberSince=row.created_at.toISOString(); result.level=row.profile_level;
      result.steamProfileUrl=row.steam_id && /^7656119\d{10}$/.test(row.steam_id) ? `https://steamcommunity.com/profiles/${row.steam_id}` : null;
      result.rank={name:rank.name,shortName:rank.shortName,rating:row.rating,nextRank:rank.nextRank,
        nextRankFloor:rank.ceiling === null ? null : rank.ceiling+1,progress:rank.progress};
      result.rankId=RANKS.findIndex(r=>r.name===rank.name)+1;
      const history = db`select m.id,m.map,m.mode,m.ended_at,coalesce(m.alpha_rounds,0) a,coalesce(m.bravo_rounds,0) b,
        coalesce(s.kills,0) kills,coalesce(s.deaths,0) deaths,coalesce(s.assists,0) assists,s.adr,
        coalesce(rc.delta,0) delta,case when m.mode='deathmatch' then
          case when coalesce(s.kills,0)<>coalesce(m.alpha_rounds,0) then 'L' when m.alpha_rounds=m.bravo_rounds then 'D' else 'W' end
          when coalesce(m.alpha_rounds,0)=coalesce(m.bravo_rounds,0) then 'D'
          when (r.team='alpha' and m.alpha_rounds>m.bravo_rounds) or (r.team='bravo' and m.bravo_rounds>m.alpha_rounds) then 'W' else 'L' end outcome
        from matches m join rosters r on r.match_id=m.id and r.player_id=${target}
        left join match_stats s on s.match_id=m.id and s.player_id=${target}
        left join rating_changes rc on rc.match_id=m.id and rc.player_id=${target}
        where m.status='completed' and m.mode=${mode}`;
      const [stats] = await db`select count(*)::int games,count(*) filter(where outcome='W')::int wins,
        count(*) filter(where outcome='L')::int losses,count(*) filter(where outcome='D')::int draws,
        coalesce(sum(kills),0)::int kills,coalesce(sum(deaths),0)::int deaths,coalesce(sum(assists),0)::int assists,
        coalesce(avg(adr),0)::float adr from (${history}) h`;
      const games=Number(stats?.games ?? 0), wins=Number(stats?.wins ?? 0), kills=Number(stats?.kills ?? 0), deaths=Number(stats?.deaths ?? 0);
      result.stats={gamesPlayed:games,wins,losses:Number(stats?.losses ?? 0),draws:Number(stats?.draws ?? 0),
        winRate:games ? Math.round(wins/games*1000)/10 : 0,kills,deaths,assists:Number(stats?.assists ?? 0),
        kdRatio:Math.round(kills/Math.max(1,deaths)*100)/100,averageAdr:Math.round(Number(stats?.adr ?? 0)*10)/10};
      result.matchTotal=games;
      const matches = await db`select * from (${history}) h order by ended_at desc nulls last,id desc limit 5 offset ${offset}`;
      result.recentMatches=matches.map(m=>({id:m.id,map:m.map,mode,score:mode==='deathmatch'?`${m.a} top frags`:`${m.a}–${m.b}`,
        outcome:m.outcome,ratingDelta:Number(m.delta),adr:Number(m.adr ?? 0),kills:m.kills,deaths:m.deaths,
        playedAt:m.ended_at?.toISOString() ?? ""}));
      return result;
    });
  }
}
