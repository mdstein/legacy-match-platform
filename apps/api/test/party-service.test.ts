import { describe, expect, it } from "vitest";
import { PartyError, PartyService } from "../src/party-service.js";

describe("PartyService", () => {
  it("supports invites, readiness, leadership transfer, and deterministic succession", () => {
    const service = new PartyService();
    const created = service.create("leader");
    const invite = service.invite("leader", "member");
    const joined = service.acceptInvite("member", invite.id);

    expect(joined.id).toBe(created.id);
    expect(joined.members).toHaveLength(2);
    expect(joined.members.find((member) => member.playerId === "member")?.ready).toBe(false);

    expect(service.setReady("member", true).members.every((member) => member.ready)).toBe(true);
    expect(service.transferLeader("leader", "member").leaderPlayerId).toBe("member");
    expect(service.leave("member")?.leaderPlayerId).toBe("leader");
    expect(service.leave("leader")).toBeNull();
  });

  it("enforces leader-only actions and five-player capacity", () => {
    const service = new PartyService();
    service.create("leader");
    for (let index = 1; index <= 4; index += 1) {
      const invite = service.invite("leader", `member-${index}`);
      service.acceptInvite(`member-${index}`, invite.id);
    }

    expect(() => service.invite("member-1", "outsider")).toThrow(PartyError);
    expect(() => service.invite("leader", "outsider")).toThrow("The party is full.");
  });
});
