import { randomUUID } from "node:crypto";
import type { PartyInvite, PartyState } from "@aftertick/contracts";
import { createClient } from "redis";
import { PartyError, type PartyServiceLike } from "./party-service.js";

type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3, {}>>;

export interface RedisPartyServiceOptions {
  prefix?: string | undefined;
  inviteTtlMs?: number | undefined;
}

const CREATE_SCRIPT = String.raw`
local prefix = ARGV[1]
local playerId = ARGV[2]
local pointerKey = prefix .. 'player:' .. playerId .. ':party'
local existingId = redis.call('GET', pointerKey)
if existingId then
  local existing = redis.call('GET', prefix .. 'party:' .. existingId)
  if existing then return existing end
  redis.call('DEL', pointerKey)
end
redis.call('SET', prefix .. 'party:' .. ARGV[3], ARGV[4])
redis.call('SET', pointerKey, ARGV[3])
return ARGV[4]
`;

const INVITE_SCRIPT = String.raw`
local prefix = ARGV[1]
local playerId = ARGV[2]
local invitedPlayerId = ARGV[3]
local partyId = redis.call('GET', prefix .. 'player:' .. playerId .. ':party')
if not partyId then return redis.error_reply('PARTY_NOT_FOUND') end
local partyRaw = redis.call('GET', prefix .. 'party:' .. partyId)
if not partyRaw then
  redis.call('DEL', prefix .. 'player:' .. playerId .. ':party')
  return redis.error_reply('PARTY_NOT_FOUND')
end
local party = cjson.decode(partyRaw)
if party.leaderPlayerId ~= playerId then return redis.error_reply('PARTY_LEADER_REQUIRED') end
if #party.members >= 5 then return redis.error_reply('PARTY_FULL') end
for _, member in ipairs(party.members) do
  if member.playerId == invitedPlayerId then return redis.error_reply('ALREADY_MEMBER') end
end
if redis.call('GET', prefix .. 'player:' .. invitedPlayerId .. ':party') then
  return redis.error_reply('ALREADY_IN_PARTY')
end
redis.call('SET', prefix .. 'party:invite:' .. ARGV[4], ARGV[5], 'PX', ARGV[6])
redis.call('ZADD', prefix .. 'player:' .. invitedPlayerId .. ':invites', ARGV[7], ARGV[4])
return ARGV[5]
`;

const ACCEPT_SCRIPT = String.raw`
local prefix = ARGV[1]
local playerId = ARGV[2]
local inviteId = ARGV[3]
local inviteKey = prefix .. 'party:invite:' .. inviteId
local inviteRaw = redis.call('GET', inviteKey)
if not inviteRaw then return redis.error_reply('INVITE_NOT_FOUND') end
local invite = cjson.decode(inviteRaw)
if invite.invitedPlayerId ~= playerId then return redis.error_reply('INVITE_NOT_FOUND') end
if redis.call('GET', prefix .. 'player:' .. playerId .. ':party') then
  return redis.error_reply('ALREADY_IN_PARTY')
end
if redis.call('GET', prefix .. 'party:' .. invite.partyId .. ':ticket') then
  return redis.error_reply('PARTY_QUEUED')
end
local partyKey = prefix .. 'party:' .. invite.partyId
local partyRaw = redis.call('GET', partyKey)
if not partyRaw then return redis.error_reply('PARTY_NOT_FOUND') end
local party = cjson.decode(partyRaw)
if #party.members >= 5 then return redis.error_reply('PARTY_FULL') end
table.insert(party.members, cjson.decode(ARGV[4]))
party.version = party.version + 1
local encoded = cjson.encode(party)
redis.call('SET', partyKey, encoded)
redis.call('SET', prefix .. 'player:' .. playerId .. ':party', invite.partyId)
redis.call('DEL', inviteKey)
redis.call('ZREM', prefix .. 'player:' .. playerId .. ':invites', inviteId)
return encoded
`;

const READY_SCRIPT = String.raw`
local prefix = ARGV[1]
local playerId = ARGV[2]
local partyId = redis.call('GET', prefix .. 'player:' .. playerId .. ':party')
if not partyId then return redis.error_reply('PARTY_NOT_FOUND') end
if redis.call('GET', prefix .. 'party:' .. partyId .. ':ticket') then
  return redis.error_reply('PARTY_QUEUED')
end
local partyKey = prefix .. 'party:' .. partyId
local partyRaw = redis.call('GET', partyKey)
if not partyRaw then return redis.error_reply('PARTY_NOT_FOUND') end
local party = cjson.decode(partyRaw)
local found = false
for _, member in ipairs(party.members) do
  if member.playerId == playerId then
    member.ready = ARGV[3] == 'true'
    found = true
  end
end
if not found then return redis.error_reply('PARTY_NOT_FOUND') end
party.version = party.version + 1
local encoded = cjson.encode(party)
redis.call('SET', partyKey, encoded)
return encoded
`;

const TRANSFER_SCRIPT = String.raw`
local prefix = ARGV[1]
local playerId = ARGV[2]
local nextLeader = ARGV[3]
local partyId = redis.call('GET', prefix .. 'player:' .. playerId .. ':party')
if not partyId then return redis.error_reply('PARTY_NOT_FOUND') end
if redis.call('GET', prefix .. 'party:' .. partyId .. ':ticket') then
  return redis.error_reply('PARTY_QUEUED')
end
local partyKey = prefix .. 'party:' .. partyId
local partyRaw = redis.call('GET', partyKey)
if not partyRaw then return redis.error_reply('PARTY_NOT_FOUND') end
local party = cjson.decode(partyRaw)
if party.leaderPlayerId ~= playerId then return redis.error_reply('PARTY_LEADER_REQUIRED') end
local found = false
for _, member in ipairs(party.members) do
  if member.playerId == nextLeader then found = true end
end
if not found then return redis.error_reply('MEMBER_NOT_FOUND') end
party.leaderPlayerId = nextLeader
party.version = party.version + 1
local encoded = cjson.encode(party)
redis.call('SET', partyKey, encoded)
return encoded
`;

const LEAVE_SCRIPT = String.raw`
local prefix = ARGV[1]
local playerId = ARGV[2]
local pointerKey = prefix .. 'player:' .. playerId .. ':party'
local partyId = redis.call('GET', pointerKey)
if not partyId then return redis.error_reply('PARTY_NOT_FOUND') end
if redis.call('GET', prefix .. 'party:' .. partyId .. ':ticket') then
  return redis.error_reply('PARTY_QUEUED')
end
local partyKey = prefix .. 'party:' .. partyId
local partyRaw = redis.call('GET', partyKey)
if not partyRaw then
  redis.call('DEL', pointerKey)
  return false
end
local party = cjson.decode(partyRaw)
local remaining = {}
for _, member in ipairs(party.members) do
  if member.playerId ~= playerId then table.insert(remaining, member) end
end
redis.call('DEL', pointerKey)
if #remaining == 0 then
  redis.call('DEL', partyKey)
  return false
end
party.members = remaining
if party.leaderPlayerId == playerId then party.leaderPlayerId = remaining[1].playerId end
party.version = party.version + 1
local encoded = cjson.encode(party)
redis.call('SET', partyKey, encoded)
return encoded
`;

function parseParty(raw: string): PartyState {
  const party = JSON.parse(raw) as Partial<PartyState>;
  if (
    typeof party.id !== "string"
    || typeof party.leaderPlayerId !== "string"
    || typeof party.createdAt !== "string"
    || typeof party.version !== "number"
    || !Array.isArray(party.members)
  ) {
    throw new Error("Redis contains an unsupported party record.");
  }
  return party as PartyState;
}

function parseInvite(raw: string): PartyInvite {
  const invite = JSON.parse(raw) as Partial<PartyInvite>;
  if (
    typeof invite.id !== "string"
    || typeof invite.partyId !== "string"
    || typeof invite.inviterPlayerId !== "string"
    || typeof invite.invitedPlayerId !== "string"
    || typeof invite.createdAt !== "string"
    || typeof invite.expiresAt !== "string"
  ) {
    throw new Error("Redis contains an unsupported party invite.");
  }
  return invite as PartyInvite;
}

function mapPartyError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PARTY_LEADER_REQUIRED")) {
    throw new PartyError(403, "Only the party leader can perform that action.");
  }
  if (message.includes("PARTY_FULL")) throw new PartyError(409, "The party is full.");
  if (message.includes("ALREADY_MEMBER")) {
    throw new PartyError(409, "That player is already in the party.");
  }
  if (message.includes("ALREADY_IN_PARTY")) {
    throw new PartyError(409, "That player is already in another party.");
  }
  if (message.includes("PARTY_QUEUED")) {
    throw new PartyError(409, "Leave the queue before changing the party roster.");
  }
  if (message.includes("INVITE_NOT_FOUND")) {
    throw new PartyError(404, "That party invite is no longer active.");
  }
  if (message.includes("MEMBER_NOT_FOUND")) {
    throw new PartyError(404, "The new leader must be a party member.");
  }
  if (message.includes("PARTY_NOT_FOUND")) {
    throw new PartyError(404, "Create or join a party first.");
  }
  throw error;
}

export class RedisPartyService implements PartyServiceLike {
  private readonly prefix: string;
  private readonly inviteTtlMs: number;

  constructor(
    private readonly client: RedisClient,
    options: RedisPartyServiceOptions = {}
  ) {
    this.prefix = options.prefix ?? "aftertick:";
    this.inviteTtlMs = options.inviteTtlMs ?? 5 * 60_000;
  }

  async getForPlayer(playerId: string): Promise<PartyState | null> {
    const partyId = await this.client.get(this.playerPartyKey(playerId));
    if (!partyId) return null;
    const raw = await this.client.get(this.partyKey(partyId));
    if (!raw) {
      await this.client.del(this.playerPartyKey(playerId));
      return null;
    }
    return parseParty(raw);
  }

  async listInvites(playerId: string): Promise<PartyInvite[]> {
    const indexKey = this.inviteIndexKey(playerId);
    await this.client.zRemRangeByScore(indexKey, 0, Date.now());
    const ids = await this.client.zRange(indexKey, 0, -1);
    if (ids.length === 0) return [];
    const values = await this.client.mGet(ids.map((id) => this.inviteKey(id)));
    const staleIds: string[] = [];
    const invites: PartyInvite[] = [];
    values.forEach((value, index) => {
      if (value) invites.push(parseInvite(value));
      else staleIds.push(ids[index]!);
    });
    if (staleIds.length > 0) await this.client.zRem(indexKey, staleIds);
    return invites;
  }

  async create(playerId: string): Promise<PartyState> {
    const now = new Date().toISOString();
    const party: PartyState = {
      id: randomUUID(),
      leaderPlayerId: playerId,
      members: [{ playerId, ready: true, joinedAt: now }],
      createdAt: now,
      version: 1
    };
    const raw = await this.client.eval(CREATE_SCRIPT, {
      keys: [],
      arguments: [this.prefix, playerId, party.id, JSON.stringify(party)]
    });
    if (typeof raw !== "string") throw new Error("Redis did not return a party.");
    return parseParty(raw);
  }

  async invite(playerId: string, invitedPlayerId: string): Promise<PartyInvite> {
    const now = Date.now();
    const party = await this.getForPlayer(playerId);
    if (!party) throw new PartyError(404, "Create or join a party first.");
    const invite: PartyInvite = {
      id: randomUUID(),
      partyId: party.id,
      inviterPlayerId: playerId,
      invitedPlayerId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.inviteTtlMs).toISOString()
    };
    try {
      const raw = await this.client.eval(INVITE_SCRIPT, {
        keys: [],
        arguments: [
          this.prefix,
          playerId,
          invitedPlayerId,
          invite.id,
          JSON.stringify(invite),
          String(this.inviteTtlMs),
          String(now + this.inviteTtlMs)
        ]
      });
      if (typeof raw !== "string") throw new Error("Redis did not return a party invite.");
      return parseInvite(raw);
    } catch (error) {
      return mapPartyError(error);
    }
  }

  async acceptInvite(playerId: string, inviteId: string): Promise<PartyState> {
    const member = { playerId, ready: false, joinedAt: new Date().toISOString() };
    try {
      const raw = await this.client.eval(ACCEPT_SCRIPT, {
        keys: [],
        arguments: [this.prefix, playerId, inviteId, JSON.stringify(member)]
      });
      if (typeof raw !== "string") throw new Error("Redis did not return a party.");
      return parseParty(raw);
    } catch (error) {
      return mapPartyError(error);
    }
  }

  async setReady(playerId: string, ready: boolean): Promise<PartyState> {
    return this.partyMutation(READY_SCRIPT, [this.prefix, playerId, String(ready)]);
  }

  async transferLeader(playerId: string, nextLeaderPlayerId: string): Promise<PartyState> {
    return this.partyMutation(TRANSFER_SCRIPT, [this.prefix, playerId, nextLeaderPlayerId]);
  }

  async leave(playerId: string): Promise<PartyState | null> {
    try {
      const raw = await this.client.eval(LEAVE_SCRIPT, {
        keys: [],
        arguments: [this.prefix, playerId]
      });
      if (raw === null) return null;
      if (typeof raw !== "string") throw new Error("Redis did not return a party.");
      return parseParty(raw);
    } catch (error) {
      return mapPartyError(error);
    }
  }

  private async partyMutation(script: string, args: string[]): Promise<PartyState> {
    try {
      const raw = await this.client.eval(script, { keys: [], arguments: args });
      if (typeof raw !== "string") throw new Error("Redis did not return a party.");
      return parseParty(raw);
    } catch (error) {
      return mapPartyError(error);
    }
  }

  private partyKey(partyId: string): string {
    return `${this.prefix}party:${partyId}`;
  }

  private playerPartyKey(playerId: string): string {
    return `${this.prefix}player:${playerId}:party`;
  }

  private inviteKey(inviteId: string): string {
    return `${this.prefix}party:invite:${inviteId}`;
  }

  private inviteIndexKey(playerId: string): string {
    return `${this.prefix}player:${playerId}:invites`;
  }
}
