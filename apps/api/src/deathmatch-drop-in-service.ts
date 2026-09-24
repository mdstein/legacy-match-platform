import type { JoinQueueRequest, QueueState } from "@aftertick/contracts";
import { MatchOrchestrator } from "./match-orchestrator.js";
import { QueueError, type VerifiedQueueParty } from "./queue-service.js";
import { RedisQueueService, type RedisQueueTicket } from "./redis-queue-service.js";

export class DeathmatchDropInService {
  constructor(
    private readonly queue: RedisQueueService,
    private readonly matches: MatchOrchestrator
  ) {}

  async join(request: JoinQueueRequest, party?: VerifiedQueueParty): Promise<QueueState> {
    if ((request.mode ?? "competitive") !== "deathmatch") {
      throw new QueueError(400, "The drop-in allocator only accepts Deathmatch entries.");
    }
    if (party) {
      await this.queue.joinVerifiedParty(request, party);
    } else {
      await this.queue.join(request);
    }
    let assignedQueue: QueueState | null = null;
    let ticket: RedisQueueTicket | null = null;
    try {
      ticket = await this.queue.ticketForPlayer(request.playerId);
      if (!ticket) throw new QueueError(409, "The Deathmatch queue entry was not persisted.");
      if (ticket.queue.phase === "assigned" && ticket.assignment) {
        return { ...ticket.queue, regions: [...ticket.queue.regions], maps: [...ticket.queue.maps] };
      }
      if (ticket.queue.phase !== "searching" || ticket.queue.mode !== "deathmatch") {
        throw new QueueError(409, "That queue entry is no longer available for Deathmatch.");
      }

      const assignment = await this.matches.joinDeathmatch({
        playerIds: ticket.memberPlayerIds,
        regions: ticket.queue.regions
      });
      assignedQueue = await this.queue.assignDeathmatch(ticket, assignment);
      try {
        await this.queue.refreshDeathmatchPopulation(assignment);
      } catch (error) {
        console.error(
          "Deathmatch population fanout failed:",
          error instanceof Error ? error.message : error
        );
      }
      return assignedQueue;
    } catch (error) {
      if (!assignedQueue && ticket) {
        // A slow allocation can finish after cancel/requeue. Only clean up the
        // searching entry this attempt captured, never a newer or assigned one.
        await this.queue.cancelDeathmatchTicket(ticket).catch(() => undefined);
      }
      if (error instanceof QueueError) throw error;
      throw new QueueError(
        503,
        error instanceof Error
          ? `Deathmatch could not start: ${error.message}`
          : "Deathmatch could not start on the game server."
      );
    }
  }
}
