import type { PartyInvite, PartyState, PlayerView } from "@aftertick/contracts";
import { Crown, LogOut, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { RankIcon } from "./RankIcon.js";

interface PartyPanelProps {
  player: PlayerView;
  party: PartyState | null;
  invites: PartyInvite[];
  pending: boolean;
  error: string | null;
  onCreate: () => void;
  onInvite: (playerId: string) => void;
  onAcceptInvite: (inviteId: string) => void;
  onReady: (ready: boolean) => void;
  onTransferLeader: (playerId: string) => void;
  onLeave: () => void;
}

function compactId(playerId: string): string {
  if (playerId.length <= 18) return playerId;
  return `${playerId.slice(0, 8)}…${playerId.slice(-6)}`;
}

export function PartyPanel({
  player,
  party,
  invites,
  pending,
  error,
  onCreate,
  onInvite,
  onAcceptInvite,
  onReady,
  onTransferLeader,
  onLeave
}: PartyPanelProps) {
  const [invitee, setInvitee] = useState("");
  const currentMember = party?.members.find((member) => member.playerId === player.id);
  const isLeader = party?.leaderPlayerId === player.id;

  const submitInvite = (event: FormEvent) => {
    event.preventDefault();
    const target = invitee.trim();
    if (!target) return;
    onInvite(target);
    setInvitee("");
  };

  return (
    <section className="sb-section party-panel" id="party" aria-labelledby="party-title">
      <div className="sb-section-header">
        <strong id="party-title">
          Party <span className="sb-dim">{party?.members.length ?? 0}/5</span>
        </strong>
        {party && (
          <span className={`party-status ${party.members.every((member) => member.ready) ? "is-ready" : ""}`}>
            {party.members.every((member) => member.ready) ? "Ready" : "Forming"}
          </span>
        )}
      </div>

      {!party && (
        <div className="party-empty">
          <p>Create a party, or accept an invite below, before joining as a stack.</p>
          <button className="party-primary" type="button" disabled={pending} onClick={onCreate}>
            <UserPlus size={14} /> {pending ? "Creating…" : "Create party"}
          </button>
        </div>
      )}

      {party && (
        <>
          <ul className="party-members" aria-label="Party members">
            {party.members.map((member) => {
              const self = member.playerId === player.id;
              const leader = member.playerId === party.leaderPlayerId;
              return (
                <li key={member.playerId}>
                  {member.rank ? (
                    <span className="party-member-rank" title={`${member.rank.name}, ${member.rank.rating} Elo`}>
                      <RankIcon rank={member.rank.name} size="sm" />
                    </span>
                  ) : (
                    <span className="party-member-mark" aria-hidden="true">
                      {self ? player.initials : member.initials ?? member.playerId.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="party-member-copy" title={member.playerId}>
                    <strong>{self ? player.displayName : member.displayName ?? compactId(member.playerId)}</strong>
                    <small>
                      {member.rank ? `${member.rank.shortName} · ${member.rank.rating.toLocaleString()} Elo · ` : ""}
                      {leader ? "Leader" : member.ready ? "Ready" : "Not ready"}
                    </small>
                  </span>
                  {leader && <Crown className="party-crown" size={13} aria-label="Party leader" />}
                  {isLeader && !leader && (
                    <button
                      className="party-icon-action"
                      type="button"
                      disabled={pending}
                      onClick={() => onTransferLeader(member.playerId)}
                      title="Make party leader"
                      aria-label={`Make ${compactId(member.playerId)} party leader`}
                    >
                      <Crown size={13} />
                    </button>
                  )}
                  <span className={`party-ready-dot ${member.ready ? "is-ready" : ""}`}>
                    {member.ready ? "Ready" : "Waiting"}
                  </span>
                </li>
              );
            })}
          </ul>

          {isLeader && party.members.length < 5 && (
            <form className="party-invite-form" onSubmit={submitInvite}>
              <label htmlFor="party-player-id">Invite by player ID</label>
              <div>
                <input
                  id="party-player-id"
                  value={invitee}
                  onChange={(event) => setInvitee(event.target.value)}
                  placeholder="Player UUID or test ID"
                  autoComplete="off"
                  disabled={pending}
                  aria-describedby={error ? "party-error" : undefined}
                />
                <button type="submit" disabled={pending || invitee.trim().length === 0}>
                  {pending ? "Sending…" : "Invite"}
                </button>
              </div>
            </form>
          )}

          <div className="party-actions">
            <button
              className="party-primary"
              type="button"
              disabled={pending}
              onClick={() => onReady(!(currentMember?.ready ?? false))}
            >
              {currentMember?.ready ? "Mark not ready" : "Mark ready"}
            </button>
            <button className="party-leave" type="button" disabled={pending} onClick={onLeave}>
              <LogOut size={13} /> Leave
            </button>
          </div>
        </>
      )}

      {invites.length > 0 && !party && (
        <div className="party-invites">
          <strong>Pending invites</strong>
          {invites.map((invite) => (
            <div key={invite.id}>
              <span title={invite.inviterPlayerId}>From {compactId(invite.inviterPlayerId)}</span>
              <button type="button" disabled={pending} onClick={() => onAcceptInvite(invite.id)}>
                Accept
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="party-error" id="party-error" role="alert">{error}</p>}
    </section>
  );
}
