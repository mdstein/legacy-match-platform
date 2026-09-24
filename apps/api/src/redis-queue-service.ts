import { randomUUID } from "node:crypto";
import type {
  BootstrapResponse,
  GameMode,
  JoinQueueRequest,
  MapVetoState,
  MatchAssignment,
  QueueState,
  ReadyCheck,
  ServerEvent
} from "@aftertick/contracts";
import { getRank } from "@aftertick/rating";
import { createClient } from "redis";
import { DEATHMATCH_MAP, MAP_POOL, REGIONS } from "./catalog.js";
import {
  idleQueue,
  QueueError,
  type QueueRuntime,
  type QueueServiceLike,
  type PlatformPopulation,
  type VerifiedQueueParty,
  type QueueSubscriber,
  type QueueUnsubscribe
} from "./queue-service.js";

export interface RedisQueueTicket {
  version: 1;
  id: string;
  fencingToken: number;
  partyId: string | null;
  leaderPlayerId: string;
  memberPlayerIds: string[];
  queue: QueueState;
  readyCheck: ReadyCheck | null;
  mapVeto: MapVetoState | null;
  assignment: MatchAssignment | null;
}

interface RedisReadyRecord extends ReadyCheck {
  expiresAtMs: number;
  ticketIds: string[];
  memberPlayerIds: string[];
  assignment: MatchAssignment | null;
  veto: MapVetoSeed | null;
}

export interface MapVetoSeed {
  captains: MapVetoState["captains"];
  mapPool: string[];
  turnSeconds: number;
}

interface RedisMapVetoRecord extends MapVetoState {
  expiresAtMs: number | null;
  turnSeconds: number;
  ticketIds: string[];
  memberPlayerIds: string[];
}

type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3, {}>>;

export interface RedisQueueServiceOptions {
  prefix?: string | undefined;
}

export interface ReadyCheckPlan {
  matchId?: string | undefined;
  mode?: GameMode | undefined;
  tickets: RedisQueueTicket[];
  map: string;
  mapPool?: string[] | undefined;
  region: string;
  durationSeconds: number;
  assignment?: Omit<MatchAssignment, "matchId"> | undefined;
  veto?: MapVetoSeed | undefined;
}

export interface MapVetoFinalization {
  state: MapVetoState;
}

export interface ReadyCheckCancellation {
  matchId: string;
  reason: "decline" | "expiry";
}

const JOIN_SCRIPT = String.raw`
local prefix = ARGV[1]
local requester = ARGV[2]
local ticketId = ARGV[3]
local ticket = cjson.decode(ARGV[4])
local verifiedPartyRaw = ARGV[6]
local requesterTicketKey = prefix .. 'player:' .. requester .. ':ticket'
local existingId = redis.call('GET', requesterTicketKey)

if existingId then
  local existing = redis.call('GET', prefix .. 'queue:ticket:' .. existingId)
  if existing then
    return {'existing', existing}
  end
  redis.call('DEL', requesterTicketKey)
end

local partyId = redis.call('GET', prefix .. 'player:' .. requester .. ':party')
local leader = requester
local members = {requester}

if verifiedPartyRaw and verifiedPartyRaw ~= '' then
  local verifiedParty = cjson.decode(verifiedPartyRaw)
  partyId = verifiedParty.partyId
  leader = verifiedParty.leaderPlayerId
  members = verifiedParty.memberPlayerIds
elseif partyId then
  local partyRaw = redis.call('GET', prefix .. 'party:' .. partyId)
  if not partyRaw then
    redis.call('DEL', prefix .. 'player:' .. requester .. ':party')
    partyId = false
  else
    local party = cjson.decode(partyRaw)
    leader = party.leaderPlayerId
    if leader ~= requester then
      return redis.error_reply('PARTY_LEADER_REQUIRED')
    end
    members = {}
    for index, member in ipairs(party.members) do
      if not member.ready then
        return redis.error_reply('PARTY_NOT_READY:' .. member.playerId)
      end
      members[index] = member.playerId
    end
  end
end

for _, memberId in ipairs(members) do
  local cooldown = redis.call('PTTL', prefix .. 'player:' .. memberId .. ':queue-cooldown')
  if cooldown and cooldown > 0 then
    return redis.error_reply('QUEUE_COOLDOWN:' .. memberId .. ':' .. cooldown)
  end
  local memberTicketId = redis.call('GET', prefix .. 'player:' .. memberId .. ':ticket')
  if memberTicketId then
    local memberTicket = redis.call('GET', prefix .. 'queue:ticket:' .. memberTicketId)
    if memberTicket then
      return redis.error_reply('MEMBER_ALREADY_QUEUED:' .. memberId)
    end
    redis.call('DEL', prefix .. 'player:' .. memberId .. ':ticket')
  end
end

ticket.fencingToken = tonumber(redis.call('INCR', prefix .. 'queue:fence'))
ticket.partyId = partyId or cjson.null
ticket.leaderPlayerId = leader
ticket.memberPlayerIds = members
local encoded = cjson.encode(ticket)

redis.call('SET', prefix .. 'queue:ticket:' .. ticketId, encoded)
redis.call('ZADD', prefix .. 'queue:tickets', ARGV[5], ticketId)
for _, memberId in ipairs(members) do
  redis.call('SET', prefix .. 'player:' .. memberId .. ':ticket', ticketId)
  redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({
    type = 'queue.updated',
    payload = ticket.queue
  }))
end
if partyId then
  redis.call('SET', prefix .. 'party:' .. partyId .. ':ticket', ticketId)
end

return {'created', encoded}
`;

const ASSIGN_DEATHMATCH_SCRIPT = String.raw`
local prefix = ARGV[1]
local ticketId = ARGV[2]
local fencingToken = tonumber(ARGV[3])
local assignment = cjson.decode(ARGV[4])
local ticketKey = prefix .. 'queue:ticket:' .. ticketId
local raw = redis.call('GET', ticketKey)
if not raw then return redis.error_reply('TICKET_STALE:' .. ticketId) end
local ticket = cjson.decode(raw)
if ticket.fencingToken ~= fencingToken
  or ticket.queue.phase ~= 'searching'
  or ticket.queue.mode ~= 'deathmatch' then
  return redis.error_reply('TICKET_STALE:' .. ticketId)
end

ticket.queue.phase = 'assigned'
ticket.queue.playersFound = assignment.humanPlayers or #ticket.memberPlayerIds
ticket.queue.estimatedWaitSeconds = 0
ticket.readyCheck = cjson.null
ticket.mapVeto = cjson.null
ticket.assignment = assignment
redis.call('SET', ticketKey, cjson.encode(ticket))
redis.call('ZREM', prefix .. 'queue:tickets', ticketId)
for _, memberId in ipairs(ticket.memberPlayerIds) do
  redis.call('SADD', prefix .. 'deathmatch:' .. assignment.matchId .. ':players', memberId)
  redis.call('PUBLISH', prefix .. 'events:' .. memberId,
    cjson.encode({type='queue.updated', payload=ticket.queue}))
  redis.call('PUBLISH', prefix .. 'events:' .. memberId,
    cjson.encode({type='match.assigned', payload=assignment}))
end
redis.call('EXPIRE', prefix .. 'deathmatch:' .. assignment.matchId .. ':players', 14400)
return cjson.encode(ticket)
`;

const COMPLETE_DEATHMATCH_SCRIPT = String.raw`
local prefix = ARGV[1]
local matchId = ARGV[2]
local event = ARGV[3]
local populationKey = prefix .. 'deathmatch:' .. matchId .. ':players'
local playerIds = redis.call('SMEMBERS', populationKey)
local seenTickets = {}
local cleared = 0

for _, playerId in ipairs(playerIds) do
  local ticketId = redis.call('GET', prefix .. 'player:' .. playerId .. ':ticket')
  if ticketId and not seenTickets[ticketId] then
    seenTickets[ticketId] = true
    local ticketKey = prefix .. 'queue:ticket:' .. ticketId
    local raw = redis.call('GET', ticketKey)
    if raw then
      local ticket = cjson.decode(raw)
      if ticket.queue.phase == 'assigned'
        and ticket.assignment
        and ticket.assignment ~= cjson.null
        and ticket.assignment.matchId == matchId then
        redis.call('DEL', ticketKey)
        redis.call('ZREM', prefix .. 'queue:tickets', ticketId)
        for _, memberId in ipairs(ticket.memberPlayerIds) do
          local memberTicketKey = prefix .. 'player:' .. memberId .. ':ticket'
          if redis.call('GET', memberTicketKey) == ticketId then
            redis.call('DEL', memberTicketKey)
          end
          redis.call('PUBLISH', prefix .. 'events:' .. memberId, event)
        end
        if ticket.partyId and ticket.partyId ~= cjson.null then
          local partyTicketKey = prefix .. 'party:' .. ticket.partyId .. ':ticket'
          if redis.call('GET', partyTicketKey) == ticketId then
            redis.call('DEL', partyTicketKey)
          end
        end
        cleared = cleared + 1
      end
    end
  end
end
redis.call('DEL', populationKey)
return cleared
`;

const LEAVE_SCRIPT = String.raw`
local prefix = ARGV[1]
local requester = ARGV[2]
local expectedTicketId = ARGV[4]
local sessionEnded = ARGV[6] == 'session-ended'
local requesterTicketKey = prefix .. 'player:' .. requester .. ':ticket'
local ticketId = redis.call('GET', requesterTicketKey)
if not ticketId then
  return nil
end
if expectedTicketId and ticketId ~= expectedTicketId then
  return nil
end

local ticketKey = prefix .. 'queue:ticket:' .. ticketId
local ticketRaw = redis.call('GET', ticketKey)
if not ticketRaw then
  redis.call('DEL', requesterTicketKey)
  return nil
end

local ticket = cjson.decode(ticketRaw)
if expectedTicketId and (ticket.queue.phase ~= 'searching'
    or (not sessionEnded and (tostring(ticket.fencingToken) ~= ARGV[5] or ticket.queue.mode ~= 'deathmatch'))) then
  return nil
end
if ticket.partyId and ticket.partyId ~= cjson.null and ticket.leaderPlayerId ~= requester and not sessionEnded then
  return redis.error_reply('PARTY_LEADER_REQUIRED')
end

redis.call('DEL', ticketKey)
redis.call('ZREM', prefix .. 'queue:tickets', ticketId)
for _, memberId in ipairs(ticket.memberPlayerIds) do
  local memberTicketKey = prefix .. 'player:' .. memberId .. ':ticket'
  if redis.call('GET', memberTicketKey) == ticketId then
    redis.call('DEL', memberTicketKey)
  end
  redis.call('PUBLISH', prefix .. 'events:' .. memberId, ARGV[3])
end
if ticket.partyId and ticket.partyId ~= cjson.null then
  local partyTicketKey = prefix .. 'party:' .. ticket.partyId .. ':ticket'
  if redis.call('GET', partyTicketKey) == ticketId then
    redis.call('DEL', partyTicketKey)
  end
end
return ticketRaw
`;

const CREATE_READY_CHECK_SCRIPT = String.raw`
local prefix = ARGV[1]
local matchId = ARGV[2]
local ticketClaims = cjson.decode(ARGV[3])
local ready = cjson.decode(ARGV[4])
local publicReady = {
  mode = ready.mode,
  matchId = ready.matchId,
  expiresAt = ready.expiresAt,
  acceptedPlayerIds = ready.acceptedPlayerIds,
  totalPlayers = ready.totalPlayers,
  map = ready.map,
  mapPool = ready.mapPool,
  region = ready.region
}
if #ready.acceptedPlayerIds == 0 then
  publicReady.acceptedPlayerIds = cjson.empty_array
end
local seen = {}
local total = 0

for _, claim in ipairs(ticketClaims) do
  local raw = redis.call('GET', prefix .. 'queue:ticket:' .. claim.id)
  if not raw then return redis.error_reply('TICKET_STALE:' .. claim.id) end
  local ticket = cjson.decode(raw)
  if ticket.fencingToken ~= claim.fencingToken or ticket.queue.phase ~= 'searching' then
    return redis.error_reply('TICKET_STALE:' .. claim.id)
  end
  for _, memberId in ipairs(ticket.memberPlayerIds) do
    if seen[memberId] then return redis.error_reply('DUPLICATE_PLAYER:' .. memberId) end
    seen[memberId] = true
    total = total + 1
  end
end
if total ~= ready.totalPlayers then return redis.error_reply('READY_CHECK_SIZE:' .. total .. ':' .. ready.totalPlayers) end

redis.call('SET', prefix .. 'queue:ready:' .. matchId, ARGV[4])
redis.call('ZADD', prefix .. 'queue:ready:deadlines', ARGV[5], matchId)
for _, claim in ipairs(ticketClaims) do
  local key = prefix .. 'queue:ticket:' .. claim.id
  local ticket = cjson.decode(redis.call('GET', key))
  ticket.queue.phase = 'ready-check'
  ticket.queue.playersFound = ready.totalPlayers
  ticket.readyCheck = publicReady
  redis.call('SET', key, cjson.encode(ticket))
  redis.call('ZREM', prefix .. 'queue:tickets', claim.id)
  for _, memberId in ipairs(ticket.memberPlayerIds) do
    redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({type='queue.updated', payload=ticket.queue}))
    redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({type='match.found', payload=publicReady}))
  end
end
return cjson.encode(publicReady)
`;

const ACCEPT_SCRIPT = String.raw`
local prefix = ARGV[1]
local playerId = ARGV[2]
local matchId = ARGV[3]
local now = tonumber(ARGV[4])
local vetoExpiresAt = ARGV[5]
local readyKey = prefix .. 'queue:ready:' .. matchId
local readyRaw = redis.call('GET', readyKey)
if not readyRaw then return {'missing', ''} end
local ready = cjson.decode(readyRaw)
local expiresAt = tonumber(ready.expiresAtMs)
if expiresAt <= now then return {'expired', ''} end
local isMember = false
for _, memberId in ipairs(ready.memberPlayerIds) do
  if memberId == playerId then isMember = true end
end
if not isMember then return {'missing', ''} end
local alreadyAccepted = false
for _, acceptedId in ipairs(ready.acceptedPlayerIds) do
  if acceptedId == playerId then alreadyAccepted = true end
end
if not alreadyAccepted then table.insert(ready.acceptedPlayerIds, playerId) end

local publicReady = {
  mode = ready.mode,
  matchId = ready.matchId,
  expiresAt = ready.expiresAt,
  acceptedPlayerIds = ready.acceptedPlayerIds,
  totalPlayers = ready.totalPlayers,
  map = ready.map,
  mapPool = ready.mapPool,
  region = ready.region
}
local complete = #ready.acceptedPlayerIds == ready.totalPlayers

for _, memberId in ipairs(ready.memberPlayerIds) do
  redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({type='match.accepted', payload=publicReady}))
end

if complete and ready.veto and ready.veto ~= cjson.null then
  local remainingMaps = ready.veto.mapPool
  local allocating = #remainingMaps == 1
  local publicVeto = {
    version = 1,
    matchId = ready.matchId,
    region = ready.region,
    captains = ready.veto.captains,
    actingTeam = 'alpha',
    remainingMaps = remainingMaps,
    bans = {},
    status = allocating and 'allocating' or 'active',
    selectedMap = allocating and remainingMaps[1] or cjson.null,
    expiresAt = allocating and cjson.null or vetoExpiresAt
  }
  local veto = {
    version = publicVeto.version,
    matchId = publicVeto.matchId,
    region = publicVeto.region,
    captains = publicVeto.captains,
    actingTeam = publicVeto.actingTeam,
    remainingMaps = publicVeto.remainingMaps,
    bans = publicVeto.bans,
    status = publicVeto.status,
    selectedMap = publicVeto.selectedMap,
    expiresAt = publicVeto.expiresAt,
    expiresAtMs = allocating and cjson.null or (now + ready.veto.turnSeconds * 1000),
    turnSeconds = ready.veto.turnSeconds,
    ticketIds = ready.ticketIds,
    memberPlayerIds = ready.memberPlayerIds
  }
  redis.call('SET', prefix .. 'queue:veto:' .. matchId, cjson.encode(veto))
  if allocating then
    redis.call('ZADD', prefix .. 'queue:veto:finalizations', now, matchId)
  else
    redis.call('ZADD', prefix .. 'queue:veto:deadlines', veto.expiresAtMs, matchId)
  end
  for _, ticketId in ipairs(ready.ticketIds) do
    local ticketKey = prefix .. 'queue:ticket:' .. ticketId
    local ticketRaw = redis.call('GET', ticketKey)
    if ticketRaw then
      local ticket = cjson.decode(ticketRaw)
      ticket.queue.phase = 'map-veto'
      ticket.queue.playersFound = ready.totalPlayers
      ticket.readyCheck = cjson.null
      ticket.mapVeto = publicVeto
      ticket.assignment = cjson.null
      redis.call('SET', ticketKey, cjson.encode(ticket))
    end
  end
  for _, memberId in ipairs(ready.memberPlayerIds) do
    local ticketId = redis.call('GET', prefix .. 'player:' .. memberId .. ':ticket')
    local ticketRaw = ticketId and redis.call('GET', prefix .. 'queue:ticket:' .. ticketId)
    if ticketRaw then
      local ticket = cjson.decode(ticketRaw)
      redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({type='queue.updated', payload=ticket.queue}))
    end
    redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({type='match.veto.updated', payload=publicVeto}))
  end
  redis.call('DEL', readyKey)
  redis.call('ZREM', prefix .. 'queue:ready:deadlines', matchId)
  return {'veto', cjson.encode(publicVeto)}
end

for _, ticketId in ipairs(ready.ticketIds) do
  local ticketKey = prefix .. 'queue:ticket:' .. ticketId
  local ticketRaw = redis.call('GET', ticketKey)
  if ticketRaw then
    local ticket = cjson.decode(ticketRaw)
    if complete then
      ticket.queue.phase = 'assigned'
      ticket.queue.playersFound = ready.totalPlayers
      ticket.readyCheck = cjson.null
      ticket.assignment = ready.assignment
    else
      ticket.readyCheck = publicReady
    end
    redis.call('SET', ticketKey, cjson.encode(ticket))
  end
end

for _, memberId in ipairs(ready.memberPlayerIds) do
  if complete then
    local ticketId = redis.call('GET', prefix .. 'player:' .. memberId .. ':ticket')
    local ticketRaw = ticketId and redis.call('GET', prefix .. 'queue:ticket:' .. ticketId)
    if ticketRaw then
      local ticket = cjson.decode(ticketRaw)
      redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({type='queue.updated', payload=ticket.queue}))
    end
    redis.call('PUBLISH', prefix .. 'events:' .. memberId, cjson.encode({type='match.assigned', payload=ready.assignment}))
  end
end

if complete then
  redis.call('DEL', readyKey)
  redis.call('ZREM', prefix .. 'queue:ready:deadlines', matchId)
  return {'assigned', cjson.encode(ready.assignment)}
end
redis.call('SET', readyKey, cjson.encode(ready))
return {'ready', cjson.encode(publicReady)}
`;

const BAN_VETO_MAP_SCRIPT = String.raw`
local prefix = ARGV[1]
local matchId = ARGV[2]
local playerId = ARGV[3]
local requestedMap = ARGV[4]
local now = tonumber(ARGV[5])
local nowIso = ARGV[6]
local nextExpiresIso = ARGV[7]
local mode = ARGV[8]
local vetoKey = prefix .. 'queue:veto:' .. matchId
local raw = redis.call('GET', vetoKey)
if not raw then return {'missing', ''} end
local veto = cjson.decode(raw)
if veto.status ~= 'active' or #veto.remainingMaps <= 1 then
  return {'not_active', ''}
end

local captainId = veto.captains[veto.actingTeam]
local map = requestedMap
local automated = false
local expired = veto.expiresAtMs ~= cjson.null and tonumber(veto.expiresAtMs) <= now
if mode == 'system' or expired then
  if veto.expiresAtMs == cjson.null or tonumber(veto.expiresAtMs) > now then
    return {'active', ''}
  end
  map = veto.remainingMaps[#veto.remainingMaps]
  playerId = captainId
  automated = true
elseif playerId ~= captainId then
  return {'forbidden', ''}
end

local remaining = {}
local found = false
for _, candidate in ipairs(veto.remainingMaps) do
  if candidate == map and not found then
    found = true
  else
    table.insert(remaining, candidate)
  end
end
if not found then return {'invalid_map', ''} end

table.insert(veto.bans, {
  sequence = #veto.bans + 1,
  map = map,
  team = veto.actingTeam,
  captainPlayerId = captainId,
  automated = automated,
  createdAt = nowIso
})
veto.remainingMaps = remaining
local final = #remaining == 1
if final then
  veto.status = 'allocating'
  veto.selectedMap = remaining[1]
  veto.expiresAt = cjson.null
  veto.expiresAtMs = cjson.null
  redis.call('ZREM', prefix .. 'queue:veto:deadlines', matchId)
  redis.call('ZADD', prefix .. 'queue:veto:finalizations', now, matchId)
else
  veto.actingTeam = veto.actingTeam == 'alpha' and 'bravo' or 'alpha'
  veto.expiresAtMs = now + veto.turnSeconds * 1000
  veto.expiresAt = nextExpiresIso
  redis.call('ZADD', prefix .. 'queue:veto:deadlines', veto.expiresAtMs, matchId)
end
redis.call('SET', vetoKey, cjson.encode(veto))

local publicVeto = {
  version = veto.version,
  matchId = veto.matchId,
  region = veto.region,
  captains = veto.captains,
  actingTeam = veto.actingTeam,
  remainingMaps = veto.remainingMaps,
  bans = veto.bans,
  status = veto.status,
  selectedMap = veto.selectedMap,
  expiresAt = veto.expiresAt
}
for _, ticketId in ipairs(veto.ticketIds) do
  local ticketKey = prefix .. 'queue:ticket:' .. ticketId
  local ticketRaw = redis.call('GET', ticketKey)
  if ticketRaw then
    local ticket = cjson.decode(ticketRaw)
    ticket.mapVeto = publicVeto
    redis.call('SET', ticketKey, cjson.encode(ticket))
  end
end
for _, memberId in ipairs(veto.memberPlayerIds) do
  redis.call('PUBLISH', prefix .. 'events:' .. memberId,
    cjson.encode({type='match.veto.updated', payload=publicVeto}))
end
return {final and 'finalize' or 'updated', cjson.encode(publicVeto)}
`;

const COMPLETE_VETO_SCRIPT = String.raw`
local prefix = ARGV[1]
local matchId = ARGV[2]
local assignment = cjson.decode(ARGV[3])
local vetoKey = prefix .. 'queue:veto:' .. matchId
local raw = redis.call('GET', vetoKey)
if not raw then return -1 end
local veto = cjson.decode(raw)
if veto.status ~= 'allocating' or veto.selectedMap == cjson.null
  or veto.selectedMap ~= assignment.map then
  return -2
end
local delivered = 0
for _, ticketId in ipairs(veto.ticketIds) do
  local ticketKey = prefix .. 'queue:ticket:' .. ticketId
  local ticketRaw = redis.call('GET', ticketKey)
  if ticketRaw then
    local ticket = cjson.decode(ticketRaw)
    if ticket.queue.phase == 'map-veto' then
      ticket.queue.phase = 'assigned'
      ticket.queue.playersFound = 10
      ticket.readyCheck = cjson.null
      ticket.mapVeto = cjson.null
      ticket.assignment = assignment
      redis.call('SET', ticketKey, cjson.encode(ticket))
      for _, memberId in ipairs(ticket.memberPlayerIds) do
        delivered = delivered + 1
        redis.call('PUBLISH', prefix .. 'events:' .. memberId,
          cjson.encode({type='queue.updated', payload=ticket.queue}))
        redis.call('PUBLISH', prefix .. 'events:' .. memberId,
          cjson.encode({type='match.assigned', payload=assignment}))
      end
    end
  end
end
redis.call('DEL', vetoKey)
redis.call('ZREM', prefix .. 'queue:veto:deadlines', matchId)
redis.call('ZREM', prefix .. 'queue:veto:finalizations', matchId)
return delivered
`;

const CANCEL_READY_CHECK_SCRIPT = String.raw`
local prefix = ARGV[1]
local matchId = ARGV[2]
local requester = ARGV[3]
local now = tonumber(ARGV[4])
local mode = ARGV[5]
local cancelledEvent = ARGV[6]
local readyKey = prefix .. 'queue:ready:' .. matchId
local readyRaw = redis.call('GET', readyKey)
if not readyRaw then return 'missing' end
local ready = cjson.decode(readyRaw)
if mode == 'expiry' and tonumber(ready.expiresAtMs) > now then return 'active' end

local accepted = {}
for _, acceptedId in ipairs(ready.acceptedPlayerIds) do accepted[acceptedId] = true end
local nativePartyFollowers = {}
for _, ticketId in ipairs(ready.ticketIds) do
  local ticketRaw = redis.call('GET', prefix .. 'queue:ticket:' .. ticketId)
  if ticketRaw then
    local ticket = cjson.decode(ticketRaw)
    if type(ticket.partyId) == 'string'
      and string.sub(ticket.partyId, 1, 12) == 'steam-lobby:' then
      for _, memberId in ipairs(ticket.memberPlayerIds) do
        if memberId ~= ticket.leaderPlayerId then nativePartyFollowers[memberId] = true end
      end
    end
  end
end
for _, memberId in ipairs(ready.memberPlayerIds) do
  local penalize = (mode == 'decline' and memberId == requester)
    or (mode == 'expiry' and not accepted[memberId])
  if nativePartyFollowers[memberId] then penalize = false end
  if penalize then
    local countKey = prefix .. 'player:' .. memberId .. ':ready-failures'
    local count = redis.call('INCR', countKey)
    redis.call('EXPIRE', countKey, 2592000)
    local seconds = 30
    if count == 2 then seconds = 120 end
    if count == 3 then seconds = 600 end
    if count >= 4 then seconds = 1800 end
    redis.call('SET', prefix .. 'player:' .. memberId .. ':queue-cooldown', mode, 'EX', seconds)
  end
end

for _, ticketId in ipairs(ready.ticketIds) do
  local ticketKey = prefix .. 'queue:ticket:' .. ticketId
  local ticketRaw = redis.call('GET', ticketKey)
  if ticketRaw then
    local ticket = cjson.decode(ticketRaw)
    redis.call('DEL', ticketKey)
    redis.call('ZREM', prefix .. 'queue:tickets', ticketId)
    if ticket.partyId and ticket.partyId ~= cjson.null then
      local partyTicketKey = prefix .. 'party:' .. ticket.partyId .. ':ticket'
      if redis.call('GET', partyTicketKey) == ticketId then redis.call('DEL', partyTicketKey) end
    end
    for _, memberId in ipairs(ticket.memberPlayerIds) do
      local pointerKey = prefix .. 'player:' .. memberId .. ':ticket'
      if redis.call('GET', pointerKey) == ticketId then redis.call('DEL', pointerKey) end
      redis.call('PUBLISH', prefix .. 'events:' .. memberId, cancelledEvent)
    end
  end
end
redis.call('DEL', readyKey)
redis.call('ZREM', prefix .. 'queue:ready:deadlines', matchId)
redis.call('HSET', prefix .. 'queue:ready:cancellation-reasons', matchId, mode)
redis.call('ZADD', prefix .. 'queue:ready:cancellations', now, matchId)
return 'cancelled'
`;

const REASSIGN_MATCH_SCRIPT = String.raw`
local prefix = ARGV[1]
local oldMatchId = ARGV[2]
local assignment = cjson.decode(ARGV[3])
local playerIds = cjson.decode(ARGV[4])
local seenTickets = {}
local updatedPlayers = 0
local updatedTickets = 0

for _, playerId in ipairs(playerIds) do
  local ticketId = redis.call('GET', prefix .. 'player:' .. playerId .. ':ticket')
  if ticketId and not seenTickets[ticketId] then
    seenTickets[ticketId] = true
    local ticketKey = prefix .. 'queue:ticket:' .. ticketId
    local ticketRaw = redis.call('GET', ticketKey)
    if ticketRaw then
      local ticket = cjson.decode(ticketRaw)
      if ticket.assignment
        and ticket.assignment ~= cjson.null
        and ticket.assignment.matchId == oldMatchId
        and ticket.queue.phase == 'assigned' then
        ticket.assignment = assignment
        ticket.readyCheck = cjson.null
        redis.call('SET', ticketKey, cjson.encode(ticket))
        updatedTickets = updatedTickets + 1
        for _, memberId in ipairs(ticket.memberPlayerIds) do
          updatedPlayers = updatedPlayers + 1
          redis.call('PUBLISH', prefix .. 'events:' .. memberId,
            cjson.encode({type='queue.updated', payload=ticket.queue}))
          redis.call('PUBLISH', prefix .. 'events:' .. memberId,
            cjson.encode({type='match.assigned', payload=assignment}))
        end
      end
    end
  end
end

return cjson.encode({players=updatedPlayers, tickets=updatedTickets})
`;

const RELEASE_LOCK_SCRIPT = String.raw`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function asScriptResult(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Redis returned an invalid queue script response.");
  }
  const [status, payload] = value;
  if (typeof status !== "string" || typeof payload !== "string") {
    throw new Error("Redis returned an invalid queue script payload.");
  }
  return [status, payload];
}

function parseTicket(value: string): RedisQueueTicket {
  const ticket = JSON.parse(value) as Partial<RedisQueueTicket>;
  if (
    ticket.version !== 1
    || typeof ticket.id !== "string"
    || typeof ticket.fencingToken !== "number"
    || typeof ticket.leaderPlayerId !== "string"
    || !Array.isArray(ticket.memberPlayerIds)
    || !ticket.queue
  ) {
    throw new Error("Redis contains an unsupported queue ticket.");
  }
  if (ticket.readyCheck) {
    ticket.readyCheck = normalizeReadyCheck(ticket.readyCheck);
  }
  ticket.mapVeto = ticket.mapVeto ? normalizeMapVeto(ticket.mapVeto) : null;
  return ticket as RedisQueueTicket;
}

function normalizeReadyCheck(value: ReadyCheck): ReadyCheck {
  const accepted = value.acceptedPlayerIds;
  const withMapPool = (ready: ReadyCheck): ReadyCheck => ({
    ...ready,
    mapPool: Array.isArray(ready.mapPool) && ready.mapPool.length > 0
      ? [...ready.mapPool]
      : [ready.map]
  });
  if (Array.isArray(accepted)) return withMapPool(value);
  if (accepted === undefined || accepted === null) {
    return withMapPool({ ...value, acceptedPlayerIds: [] });
  }
  if (accepted && typeof accepted === "object" && Object.keys(accepted).length === 0) {
    return withMapPool({ ...value, acceptedPlayerIds: [] });
  }
  throw new Error("Redis contains an invalid ready-check acceptance list.");
}

function normalizeMapVeto(value: MapVetoState): MapVetoState {
  const rawBans = (value as MapVetoState & { bans?: unknown }).bans;
  const normalized = (
    rawBans === undefined
    || rawBans === null
    || (typeof rawBans === "object" && !Array.isArray(rawBans) && Object.keys(rawBans).length === 0)
  )
    ? { ...value, bans: [] }
    : value;
  if (
    normalized.version !== 1
    || !Array.isArray(normalized.remainingMaps)
    || normalized.remainingMaps.length === 0
    || !Array.isArray(normalized.bans)
    || (normalized.status !== "active" && normalized.status !== "allocating")
  ) {
    throw new Error(`Redis contains an unsupported map-veto state: ${JSON.stringify(value)}`);
  }
  return {
    version: 1,
    matchId: normalized.matchId,
    region: normalized.region,
    captains: structuredClone(normalized.captains),
    actingTeam: normalized.actingTeam,
    remainingMaps: [...normalized.remainingMaps],
    bans: structuredClone(normalized.bans),
    status: normalized.status,
    selectedMap: normalized.selectedMap ?? null,
    expiresAt: normalized.expiresAt ?? null
  };
}

function queueError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PARTY_LEADER_REQUIRED")) {
    throw new QueueError(403, "Only the party leader can control the queue ticket.");
  }
  if (message.includes("PARTY_NOT_READY")) {
    throw new QueueError(409, "Every party member must be ready before queueing.");
  }
  if (message.includes("MEMBER_ALREADY_QUEUED")) {
    throw new QueueError(409, "A party member already has another queue ticket.");
  }
  if (message.includes("QUEUE_COOLDOWN")) {
    const remainingMs = Number(message.match(/QUEUE_COOLDOWN:[^:]+:(\d+)/)?.[1] ?? 0);
    throw new QueueError(
      429,
      `A party member is on a ready-check cooldown for ${Math.max(1, Math.ceil(remainingMs / 1000))} seconds.`
    );
  }
  if (message.includes("TICKET_STALE")) {
    throw new QueueError(409, "The queue changed while forming this match; retry matchmaking.");
  }
  if (message.includes("READY_CHECK_SIZE")) {
    throw new QueueError(409, "The ready check roster does not match the selected game mode.");
  }
  throw error;
}

export class RedisQueueService implements QueueServiceLike {
  private readonly prefix: string;
  private readonly subscribers = new Map<string, Set<QueueSubscriber>>();

  private constructor(
    private readonly client: RedisClient,
    private readonly subscriptionClient: RedisClient,
    options: RedisQueueServiceOptions
  ) {
    this.prefix = options.prefix ?? "aftertick:";
  }

  static async create(
    client: RedisClient,
    options: RedisQueueServiceOptions = {}
  ): Promise<RedisQueueService> {
    const subscriptionClient = client.duplicate();
    subscriptionClient.on("error", (error) => {
      console.error(
        "Redis queue subscription error:",
        error instanceof Error ? error.message : "Unknown error"
      );
    });
    await subscriptionClient.connect();
    const service = new RedisQueueService(client, subscriptionClient, options);
    await subscriptionClient.pSubscribe(`${service.prefix}events:*`, (message, channel) => {
      const playerId = channel.slice(`${service.prefix}events:`.length);
      try {
        const event = JSON.parse(message) as ServerEvent;
        service.subscribers.get(playerId)?.forEach((subscriber) => subscriber(event));
      } catch (error) {
        console.error("Ignored malformed Redis queue event:", error);
      }
    });
    return service;
  }

  async getQueueRuntime(playerId: string): Promise<QueueRuntime> {
    const ticketId = await this.client.get(this.playerTicketKey(playerId));
    if (!ticketId) return this.idleRuntime();

    const raw = await this.client.get(this.ticketKey(ticketId));
    if (!raw) {
      await this.client.del(this.playerTicketKey(playerId));
      return this.idleRuntime();
    }

    const ticket = parseTicket(raw);
    if (
      ticket.readyCheck
      && new Date(ticket.readyCheck.expiresAt).getTime() <= Date.now()
    ) {
      await this.cancelReadyCheck(ticket.readyCheck.matchId, playerId, "expiry");
      return this.idleRuntime();
    }
    const population = ticket.queue.phase === "searching"
      ? await this.getPlatformPopulation()
      : null;
    const playersFound = population
      ? (ticket.queue.mode ?? "competitive") === "deathmatch"
        ? population.deathmatchQueuePlayers
        : population.competitiveQueuePlayers
      : ticket.queue.playersFound;
    return {
      queue: {
        ...ticket.queue,
        ticketId: ticket.id,
        playersFound,
        regions: [...ticket.queue.regions],
        maps: [...ticket.queue.maps]
      },
      readyCheck: ticket.readyCheck
        ? { ...ticket.readyCheck, acceptedPlayerIds: [...ticket.readyCheck.acceptedPlayerIds] }
        : null,
      mapVeto: ticket.mapVeto ? normalizeMapVeto(ticket.mapVeto) : null,
      assignment: ticket.assignment ? { ...ticket.assignment } : null
    };
  }

  async getBootstrapFallback(playerId: string): Promise<BootstrapResponse> {
    const runtime = await this.getQueueRuntime(playerId);
    const population = await this.getPlatformPopulation();
    const rating = 1000;
    const rank = getRank(rating);
    return {
      player: {
        id: playerId,
        displayName: "New Player",
        initials: "NP",
        region: "NA Central",
        rank: {
          name: rank.name,
          shortName: rank.shortName,
          rating,
          nextRank: rank.nextRank,
          nextRankFloor: rank.ceiling === null ? null : rank.ceiling + 1,
          progress: rank.progress
        },
        matchesPlayed: 0,
        winRate: 0,
        recentMatches: []
      },
      ...runtime,
      platform: {
        onlinePlayers: population.onlinePlayers,
        activeMatches: 0,
        competitiveQueuePlayers: population.competitiveQueuePlayers,
        deathmatchQueuePlayers: population.deathmatchQueuePlayers,
        deathmatchHumans: 0,
        deathmatchBots: 0,
        deathmatchCapacity: 0,
        season: "Founders Season"
      }
    };
  }

  async join(request: JoinQueueRequest): Promise<QueueState> {
    return this.joinWithParty(request, null);
  }

  async joinVerifiedParty(
    request: JoinQueueRequest,
    party: VerifiedQueueParty
  ): Promise<QueueState> {
    const members = [...new Set(party.memberPlayerIds)];
    if (
      !/^steam-lobby:\d{17,20}$/.test(party.partyId)
      || party.leaderPlayerId !== request.playerId
      || members.length < 2
      || members.length > 5
      || members.length !== party.memberPlayerIds.length
      || !members.includes(request.playerId)
      || members.some((playerId) => playerId.length === 0)
    ) {
      throw new QueueError(400, "The verified Steam party is invalid.");
    }
    return this.joinWithParty(request, {
      ...party,
      memberPlayerIds: members
    });
  }

  private async joinWithParty(
    request: JoinQueueRequest,
    party: VerifiedQueueParty | null
  ): Promise<QueueState> {
    this.validateSelections(request);
    const joinedAt = new Date();
    const mode = request.mode ?? "competitive";
    const maps = mode === "deathmatch" ? [DEATHMATCH_MAP] : [...request.maps];
    const ticket: RedisQueueTicket = {
      version: 1,
      id: randomUUID(),
      fencingToken: 0,
      partyId: null,
      leaderPlayerId: request.playerId,
      memberPlayerIds: [request.playerId],
      queue: {
        mode,
        phase: "searching",
        joinedAt: joinedAt.toISOString(),
        regions: [...request.regions],
        maps,
        playersFound: 0,
        estimatedWaitSeconds: 0,
        ratingWindow: 50
      },
      readyCheck: null,
      mapVeto: null,
      assignment: null
    };

    try {
      const result = await this.client.eval(JOIN_SCRIPT, {
        keys: [],
        arguments: [
          this.prefix,
          request.playerId,
          ticket.id,
          JSON.stringify(ticket),
          String(joinedAt.getTime()),
          party ? JSON.stringify(party) : ""
        ]
      });
      const [, raw] = asScriptResult(result);
      const persisted = parseTicket(raw);
      const population = await this.getPlatformPopulation();
      const actualPlayers = mode === "deathmatch"
        ? population.deathmatchQueuePlayers
        : population.competitiveQueuePlayers;
      return {
        ...persisted.queue,
        ticketId: persisted.id,
        playersFound: actualPlayers,
        regions: [...persisted.queue.regions],
        maps: [...persisted.queue.maps]
      };
    } catch (error) {
      return queueError(error);
    }
  }

  async ticketForPlayer(playerId: string): Promise<RedisQueueTicket | null> {
    const ticketId = await this.client.get(this.playerTicketKey(playerId));
    if (!ticketId) return null;
    const raw = await this.client.get(this.ticketKey(ticketId));
    return raw ? parseTicket(raw) : null;
  }

  async assignDeathmatch(
    ticket: RedisQueueTicket,
    assignment: MatchAssignment
  ): Promise<QueueState> {
    try {
      const raw = await this.client.eval(ASSIGN_DEATHMATCH_SCRIPT, {
        keys: [],
        arguments: [
          this.prefix,
          ticket.id,
          String(ticket.fencingToken),
          JSON.stringify(assignment)
        ]
      });
      if (typeof raw !== "string") throw new Error("Redis did not return an assigned Deathmatch ticket.");
      const assigned = parseTicket(raw);
      return { ...assigned.queue, regions: [...assigned.queue.regions], maps: [...assigned.queue.maps] };
    } catch (error) {
      return queueError(error);
    }
  }

  async refreshDeathmatchPopulation(assignment: MatchAssignment): Promise<void> {
    const playerIds = await this.client.sMembers(
      `${this.prefix}deathmatch:${assignment.matchId}:players`
    );
    if (playerIds.length === 0) return;
    const ticketIds = [...new Set((await this.client.mGet(
      playerIds.map((playerId) => this.playerTicketKey(playerId))
    )).filter((value): value is string => Boolean(value)))];
    for (const ticketId of ticketIds) {
      const key = this.ticketKey(ticketId);
      const raw = await this.client.get(key);
      if (!raw) continue;
      const ticket = parseTicket(raw);
      if (ticket.assignment?.matchId !== assignment.matchId || ticket.queue.phase !== "assigned") continue;
      ticket.assignment = { ...assignment };
      ticket.queue = {
        ...ticket.queue,
        playersFound: assignment.humanPlayers ?? ticket.memberPlayerIds.length,
        estimatedWaitSeconds: 0
      };
      await this.client.set(key, JSON.stringify(ticket));
      await Promise.all(ticket.memberPlayerIds.flatMap((memberId) => [
        this.client.publish(`${this.prefix}events:${memberId}`, JSON.stringify({
          type: "queue.updated",
          payload: ticket.queue
        } satisfies ServerEvent)),
        this.client.publish(`${this.prefix}events:${memberId}`, JSON.stringify({
          type: "match.assigned",
          payload: assignment
        } satisfies ServerEvent))
      ]));
    }
  }

  async completeDeathmatch(matchId: string): Promise<number> {
    const event: ServerEvent = { type: "queue.cancelled", payload: idleQueue() };
    const result = await this.client.eval(COMPLETE_DEATHMATCH_SCRIPT, {
      keys: [],
      arguments: [this.prefix, matchId, JSON.stringify(event)]
    });
    if (typeof result !== "number") throw new Error("Redis returned an invalid Deathmatch completion result.");
    return result;
  }

  async touchPresence(playerId: string): Promise<void> {
    const now = Date.now();
    const key = `${this.prefix}presence:players`;
    await this.client.multi()
      .zAdd(key, { score: now, value: playerId })
      .zRemRangeByScore(key, 0, now - 120_000)
      .exec();
  }

  async getPlatformPopulation(): Promise<PlatformPopulation> {
    const now = Date.now();
    const presenceKey = `${this.prefix}presence:players`;
    await this.client.zRemRangeByScore(presenceKey, 0, now - 120_000);
    const tickets = await this.listSearchingTickets();
    let competitiveQueuePlayers = 0;
    let deathmatchQueuePlayers = 0;
    for (const ticket of tickets) {
      if ((ticket.queue.mode ?? "competitive") === "deathmatch") {
        deathmatchQueuePlayers += ticket.memberPlayerIds.length;
      } else {
        competitiveQueuePlayers += ticket.memberPlayerIds.length;
      }
    }
    return {
      onlinePlayers: await this.client.zCard(presenceKey),
      competitiveQueuePlayers,
      deathmatchQueuePlayers
    };
  }

  async cancelDeathmatchTicket(ticket: RedisQueueTicket): Promise<boolean> {
    const event: ServerEvent = { type: "queue.cancelled", payload: idleQueue() };
    const removed = await this.client.eval(LEAVE_SCRIPT, {
      keys: [],
      arguments: [
        this.prefix, ticket.leaderPlayerId, JSON.stringify(event),
        ticket.id, String(ticket.fencingToken)
      ]
    });
    return typeof removed === "string";
  }

  async releaseSearch(playerId: string, ticketId: string): Promise<boolean> {
    // Atomic identity + phase checks preserve replacements and committed matches.
    // Any party member whose game has closed can release its searching group.
    const event: ServerEvent = { type: "queue.cancelled", payload: idleQueue() };
    const removed = await this.client.eval(LEAVE_SCRIPT, {
      keys: [],
      arguments: [this.prefix, playerId, JSON.stringify(event), ticketId, "", "session-ended"]
    });
    return typeof removed === "string";
  }

  async leave(playerId: string): Promise<QueueState> {
    const idle = idleQueue();
    const event: ServerEvent = { type: "queue.cancelled", payload: idle };
    try {
      const runtime = await this.getQueueRuntime(playerId);
      if (runtime.readyCheck) {
        await this.cancelReadyCheck(runtime.readyCheck.matchId, playerId, "decline");
        return idle;
      }
      if (runtime.mapVeto) {
        throw new QueueError(409, "The accepted match is committed while map veto and server allocation complete.");
      }
      await this.client.eval(LEAVE_SCRIPT, {
        keys: [],
        arguments: [this.prefix, playerId, JSON.stringify(event)]
      });
      return idle;
    } catch (error) {
      return queueError(error);
    }
  }

  async accept(playerId: string, matchId: string): Promise<ReadyCheck | MapVetoState | MatchAssignment> {
    const now = Date.now();
    const result = asScriptResult(await this.client.eval(ACCEPT_SCRIPT, {
      keys: [],
      arguments: [
        this.prefix,
        playerId,
        matchId,
        String(now),
        new Date(now + 30_000).toISOString()
      ]
    }));
    if (result[0] === "missing") {
      throw new QueueError(404, "That ready check is no longer active.");
    }
    if (result[0] === "expired") {
      await this.cancelReadyCheck(matchId, playerId, "expiry");
      throw new QueueError(409, "The ready check expired.");
    }
    if (result[0] === "assigned") {
      return JSON.parse(result[1]) as MatchAssignment;
    }
    if (result[0] === "veto") {
      return normalizeMapVeto(JSON.parse(result[1]) as MapVetoState);
    }
    return JSON.parse(result[1]) as ReadyCheck;
  }

  async banMap(playerId: string, matchId: string, map: string): Promise<MapVetoState> {
    const now = Date.now();
    const result = asScriptResult(await this.client.eval(BAN_VETO_MAP_SCRIPT, {
      keys: [],
      arguments: [
        this.prefix,
        matchId,
        playerId,
        map,
        String(now),
        new Date(now).toISOString(),
        new Date(now + 30_000).toISOString(),
        "manual"
      ]
    }));
    if (result[0] === "missing") throw new QueueError(404, "That map-veto room no longer exists.");
    if (result[0] === "not_active") throw new QueueError(409, "Map veto is already complete.");
    if (result[0] === "forbidden") throw new QueueError(403, "Only the acting captain can ban the next map.");
    if (result[0] === "invalid_map") throw new QueueError(409, "That map is no longer available.");
    return normalizeMapVeto(JSON.parse(result[1]) as MapVetoState);
  }

  async listSearchingTickets(): Promise<RedisQueueTicket[]> {
    const ids = await this.client.zRange(`${this.prefix}queue:tickets`, 0, -1);
    if (ids.length === 0) return [];
    const values = await this.client.mGet(ids.map((id) => this.ticketKey(id)));
    const staleIds: string[] = [];
    const tickets: RedisQueueTicket[] = [];
    values.forEach((value, index) => {
      if (!value) {
        staleIds.push(ids[index]!);
        return;
      }
      const ticket = parseTicket(value);
      if (ticket.queue.phase === "searching") tickets.push(ticket);
    });
    if (staleIds.length > 0) {
      await this.client.zRem(`${this.prefix}queue:tickets`, staleIds);
    }
    return tickets;
  }

  async createReadyCheck(plan: ReadyCheckPlan): Promise<ReadyCheck> {
    if ((plan.assignment ? 1 : 0) + (plan.veto ? 1 : 0) !== 1) {
      throw new Error("A ready check requires exactly one direct assignment or map-veto seed.");
    }
    const mapPool = [...new Set(plan.mapPool ?? [plan.map])];
    if (mapPool.length === 0 || !mapPool.includes(plan.map)) {
      throw new Error("A ready check requires its provisional map in a non-empty map pool.");
    }
    const matchId = plan.matchId ?? randomUUID();
    const expiresAtMs = Date.now() + plan.durationSeconds * 1000;
    const mode = plan.mode ?? "competitive";
    if (plan.tickets.some((ticket) => (ticket.queue.mode ?? "competitive") !== mode)) {
      throw new Error("A ready check cannot mix game modes.");
    }
    if (mode === "deathmatch" && plan.veto) {
      throw new Error("Deathmatch ready checks cannot open map veto.");
    }
    const totalPlayers = plan.tickets.reduce(
      (total, ticket) => total + ticket.memberPlayerIds.length,
      0
    );
    const expectedPlayers = mode === "deathmatch" ? 14 : 10;
    if (totalPlayers !== expectedPlayers) {
      throw new Error(`${mode} ready checks require exactly ${expectedPlayers} players.`);
    }
    const ready: RedisReadyRecord = {
      mode,
      matchId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      acceptedPlayerIds: [],
      totalPlayers,
      map: plan.map,
      mapPool,
      region: plan.region,
      ticketIds: plan.tickets.map((ticket) => ticket.id),
      memberPlayerIds: plan.tickets.flatMap((ticket) => ticket.memberPlayerIds),
      assignment: plan.assignment ? { matchId, ...plan.assignment } : null,
      veto: plan.veto ? { ...plan.veto, mapPool } : null
    };
    const claims = plan.tickets.map((ticket) => ({
      id: ticket.id,
      fencingToken: ticket.fencingToken
    }));
    try {
      const raw = await this.client.eval(CREATE_READY_CHECK_SCRIPT, {
        keys: [],
        arguments: [
          this.prefix,
          matchId,
          JSON.stringify(claims),
          JSON.stringify(ready),
          String(expiresAtMs)
        ]
      });
      if (typeof raw !== "string") throw new Error("Redis did not return a ready check.");
      return normalizeReadyCheck(JSON.parse(raw) as ReadyCheck);
    } catch (error) {
      return queueError(error);
    }
  }

  async sweepExpiredReadyChecks(limit = 100): Promise<number> {
    const expired = (
      await this.client.zRangeByScore(`${this.prefix}queue:ready:deadlines`, 0, Date.now())
    ).slice(0, limit);
    let swept = 0;
    for (const matchId of expired) {
      const result = await this.cancelReadyCheck(matchId, "system", "expiry");
      if (result === "cancelled") swept += 1;
    }
    return swept;
  }

  async sweepExpiredMapVetos(limit = 100): Promise<number> {
    const now = Date.now();
    const expired = (
      await this.client.zRangeByScore(`${this.prefix}queue:veto:deadlines`, 0, now)
    ).slice(0, limit);
    let swept = 0;
    for (const matchId of expired) {
      const result = asScriptResult(await this.client.eval(BAN_VETO_MAP_SCRIPT, {
        keys: [],
        arguments: [
          this.prefix,
          matchId,
          "system",
          "",
          String(now),
          new Date(now).toISOString(),
          new Date(now + 30_000).toISOString(),
          "system"
        ]
      }));
      if (result[0] === "updated" || result[0] === "finalize") swept += 1;
      if (result[0] === "missing" || result[0] === "not_active") {
        await this.client.zRem(`${this.prefix}queue:veto:deadlines`, matchId);
      }
    }
    return swept;
  }

  async listPendingVetoFinalizations(limit = 100): Promise<MapVetoFinalization[]> {
    const matchIds = await this.client.zRange(
      `${this.prefix}queue:veto:finalizations`,
      0,
      Math.max(0, limit - 1)
    );
    if (matchIds.length === 0) return [];
    const values = await this.client.mGet(
      matchIds.map((matchId) => `${this.prefix}queue:veto:${matchId}`)
    );
    const stale: string[] = [];
    const pending: MapVetoFinalization[] = [];
    values.forEach((value, index) => {
      if (!value) {
        stale.push(matchIds[index]!);
        return;
      }
      const record = JSON.parse(value) as RedisMapVetoRecord;
      const state = normalizeMapVeto(record);
      if (state.status === "allocating" && state.selectedMap) pending.push({ state });
    });
    if (stale.length > 0) {
      await this.client.zRem(`${this.prefix}queue:veto:finalizations`, stale);
    }
    return pending;
  }

  async completeMapVeto(matchId: string, assignment: MatchAssignment): Promise<number> {
    const result = await this.client.eval(COMPLETE_VETO_SCRIPT, {
      keys: [],
      arguments: [this.prefix, matchId, JSON.stringify(assignment)]
    });
    if (typeof result !== "number") throw new Error("Redis returned an invalid veto completion result.");
    if (result === -1) return 0;
    if (result === -2) throw new Error("The finalized server assignment does not match the veto result.");
    return result;
  }

  async listReadyCheckCancellations(limit = 100): Promise<ReadyCheckCancellation[]> {
    const matchIds = await this.client.zRange(
      `${this.prefix}queue:ready:cancellations`,
      0,
      Math.max(0, limit - 1)
    );
    if (matchIds.length === 0) return [];
    const reasons = await this.client.hmGet(
      `${this.prefix}queue:ready:cancellation-reasons`,
      matchIds
    );
    return matchIds.map((matchId, index) => ({
      matchId,
      reason: reasons[index] === "decline" ? "decline" : "expiry"
    }));
  }

  async acknowledgeReadyCheckCancellation(matchId: string): Promise<void> {
    await this.client
      .multi()
      .zRem(`${this.prefix}queue:ready:cancellations`, matchId)
      .hDel(`${this.prefix}queue:ready:cancellation-reasons`, matchId)
      .exec();
  }

  async reassignMatch(
    oldMatchId: string,
    assignment: MatchAssignment,
    playerIds: string[]
  ): Promise<{ players: number; tickets: number }> {
    const raw = await this.client.eval(REASSIGN_MATCH_SCRIPT, {
      keys: [],
      arguments: [
        this.prefix,
        oldMatchId,
        JSON.stringify(assignment),
        JSON.stringify([...new Set(playerIds)])
      ]
    });
    if (typeof raw !== "string") {
      throw new Error("Redis returned an invalid match reassignment response.");
    }
    const parsed = JSON.parse(raw) as { players?: unknown; tickets?: unknown };
    if (typeof parsed.players !== "number" || typeof parsed.tickets !== "number") {
      throw new Error("Redis returned invalid match reassignment counts.");
    }
    return { players: parsed.players, tickets: parsed.tickets };
  }

  async runCancellationExclusive<T>(
    matchId: string,
    task: () => Promise<T>
  ): Promise<T | null> {
    const key = `${this.prefix}queue:ready:cancellation-lock:${matchId}`;
    const token = randomUUID();
    const acquired = await this.client.set(key, token, { NX: true, PX: 10_000 });
    if (!acquired) return null;
    try {
      return await task();
    } finally {
      await this.client.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [token] });
    }
  }

  async runVetoFinalizationExclusive<T>(
    matchId: string,
    task: () => Promise<T>
  ): Promise<T | null> {
    const key = `${this.prefix}queue:veto:finalization-lock:${matchId}`;
    const token = randomUUID();
    const acquired = await this.client.set(key, token, { NX: true, PX: 30_000 });
    if (!acquired) return null;
    try {
      return await task();
    } finally {
      await this.client.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [token] });
    }
  }

  async runMatchmakerExclusive<T>(task: () => Promise<T>): Promise<T | null> {
    const key = `${this.prefix}queue:matchmaker-lock`;
    const token = randomUUID();
    const acquired = await this.client.set(key, token, { NX: true, PX: 10_000 });
    if (!acquired) return null;
    try {
      return await task();
    } finally {
      await this.client.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [token] });
    }
  }

  subscribe(playerId: string, subscriber: QueueSubscriber): QueueUnsubscribe {
    const current = this.subscribers.get(playerId) ?? new Set<QueueSubscriber>();
    current.add(subscriber);
    this.subscribers.set(playerId, current);
    return () => {
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(playerId);
    };
  }

  async reset(playerId: string): Promise<BootstrapResponse> {
    await this.leave(playerId);
    return this.getBootstrapFallback(playerId);
  }

  async close(): Promise<void> {
    if (this.subscriptionClient.isOpen) {
      await this.subscriptionClient.pUnsubscribe(`${this.prefix}events:*`);
      await this.subscriptionClient.quit();
    }
  }

  private idleRuntime(): QueueRuntime {
    return { queue: idleQueue(), readyCheck: null, mapVeto: null, assignment: null };
  }

  private playerTicketKey(playerId: string): string {
    return `${this.prefix}player:${playerId}:ticket`;
  }

  private ticketKey(ticketId: string): string {
    return `${this.prefix}queue:ticket:${ticketId}`;
  }

  private validateSelections(request: JoinQueueRequest): void {
    const mode = request.mode ?? "competitive";
    if (request.regions.length === 0 || (mode === "competitive" && request.maps.length === 0)) {
      throw new QueueError(
        400,
        mode === "competitive" ? "Choose at least one region and one map." : "Choose at least one region."
      );
    }
    if (request.regions.some((region) => !(REGIONS as readonly string[]).includes(region))) {
      throw new QueueError(400, "Unknown region.");
    }
    if (mode === "competitive" && request.maps.some((map) => !(MAP_POOL as readonly string[]).includes(map))) {
      throw new QueueError(400, "Unknown map.");
    }
  }

  private async cancelReadyCheck(
    matchId: string,
    requester: string,
    mode: "decline" | "expiry"
  ): Promise<string> {
    const event: ServerEvent = { type: "queue.cancelled", payload: idleQueue() };
    const result = await this.client.eval(CANCEL_READY_CHECK_SCRIPT, {
      keys: [],
      arguments: [
        this.prefix,
        matchId,
        requester,
        String(Date.now()),
        mode,
        JSON.stringify(event)
      ]
    });
    return typeof result === "string" ? result : "missing";
  }
}
