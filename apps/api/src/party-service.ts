import { randomUUID } from "node:crypto";
import type { PartyInvite, PartyState } from "@aftertick/contracts";
import type { Awaitable } from "./queue-service.js";

export interface PartyServiceLike {
  getForPlayer(playerId: string): Awaitable<PartyState | null>;
  listInvites(playerId: string): Awaitable<PartyInvite[]>;
  create(playerId: string): Awaitable<PartyState>;
  invite(playerId: string, invitedPlayerId: string): Awaitable<PartyInvite>;
  acceptInvite(playerId: string, inviteId: string): Awaitable<PartyState>;
  setReady(playerId: string, ready: boolean): Awaitable<PartyState>;
  transferLeader(playerId: string, nextLeaderPlayerId: string): Awaitable<PartyState>;
  leave(playerId: string): Awaitable<PartyState | null>;
}

function cloneParty(party: PartyState): PartyState {
  return { ...party, members: party.members.map((member) => ({ ...member })) };
}

export class PartyService implements PartyServiceLike {
  private readonly parties = new Map<string, PartyState>();
  private readonly partyByPlayer = new Map<string, string>();
  private readonly invites = new Map<string, PartyInvite>();

  getForPlayer(playerId: string): PartyState | null {
    const partyId = this.partyByPlayer.get(playerId);
    const party = partyId ? this.parties.get(partyId) : undefined;
    return party ? cloneParty(party) : null;
  }

  listInvites(playerId: string): PartyInvite[] {
    this.expireInvites();
    return [...this.invites.values()]
      .filter((invite) => invite.invitedPlayerId === playerId)
      .map((invite) => ({ ...invite }));
  }

  create(playerId: string): PartyState {
    const existing = this.getForPlayer(playerId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const party: PartyState = {
      id: randomUUID(),
      leaderPlayerId: playerId,
      members: [{ playerId, ready: true, joinedAt: now }],
      createdAt: now,
      version: 1
    };
    this.parties.set(party.id, party);
    this.partyByPlayer.set(playerId, party.id);
    return cloneParty(party);
  }

  invite(playerId: string, invitedPlayerId: string): PartyInvite {
    const party = this.requireParty(playerId);
    if (party.leaderPlayerId !== playerId) {
      throw new PartyError(403, "Only the party leader can invite players.");
    }
    if (party.members.length >= 5) throw new PartyError(409, "The party is full.");
    if (party.members.some((member) => member.playerId === invitedPlayerId)) {
      throw new PartyError(409, "That player is already in the party.");
    }
    if (this.partyByPlayer.has(invitedPlayerId)) {
      throw new PartyError(409, "That player is already in another party.");
    }
    const now = Date.now();
    const invite: PartyInvite = {
      id: randomUUID(),
      partyId: party.id,
      inviterPlayerId: playerId,
      invitedPlayerId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString()
    };
    this.invites.set(invite.id, invite);
    return { ...invite };
  }

  acceptInvite(playerId: string, inviteId: string): PartyState {
    this.expireInvites();
    const invite = this.invites.get(inviteId);
    if (!invite || invite.invitedPlayerId !== playerId) {
      throw new PartyError(404, "That party invite is no longer active.");
    }
    if (this.partyByPlayer.has(playerId)) {
      throw new PartyError(409, "Leave the current party before accepting another invite.");
    }
    const party = this.parties.get(invite.partyId);
    if (!party) throw new PartyError(404, "That party no longer exists.");
    if (party.members.length >= 5) throw new PartyError(409, "The party is full.");
    party.members.push({ playerId, ready: false, joinedAt: new Date().toISOString() });
    party.version += 1;
    this.partyByPlayer.set(playerId, party.id);
    this.invites.delete(inviteId);
    return cloneParty(party);
  }

  setReady(playerId: string, ready: boolean): PartyState {
    const party = this.requireParty(playerId);
    const member = party.members.find((candidate) => candidate.playerId === playerId);
    if (!member) throw new PartyError(404, "Party member not found.");
    member.ready = ready;
    party.version += 1;
    return cloneParty(party);
  }

  transferLeader(playerId: string, nextLeaderPlayerId: string): PartyState {
    const party = this.requireParty(playerId);
    if (party.leaderPlayerId !== playerId) {
      throw new PartyError(403, "Only the party leader can transfer leadership.");
    }
    if (!party.members.some((member) => member.playerId === nextLeaderPlayerId)) {
      throw new PartyError(404, "The new leader must be a party member.");
    }
    party.leaderPlayerId = nextLeaderPlayerId;
    party.version += 1;
    return cloneParty(party);
  }

  leave(playerId: string): PartyState | null {
    const party = this.requireParty(playerId);
    const index = party.members.findIndex((member) => member.playerId === playerId);
    party.members.splice(index, 1);
    this.partyByPlayer.delete(playerId);
    if (party.members.length === 0) {
      this.parties.delete(party.id);
      return null;
    }
    if (party.leaderPlayerId === playerId) {
      party.leaderPlayerId = party.members[0]!.playerId;
    }
    party.version += 1;
    return cloneParty(party);
  }

  private requireParty(playerId: string): PartyState {
    const partyId = this.partyByPlayer.get(playerId);
    const party = partyId ? this.parties.get(partyId) : undefined;
    if (!party) throw new PartyError(404, "Create or join a party first.");
    return party;
  }

  private expireInvites(): void {
    const now = Date.now();
    for (const [id, invite] of this.invites) {
      if (new Date(invite.expiresAt).getTime() <= now) this.invites.delete(id);
    }
  }
}

export class PartyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
