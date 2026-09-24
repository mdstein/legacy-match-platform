import type {
  BootstrapResponse,
  MapVetoState,
  MatchAssignment,
  QueueState,
  ReadyCheck,
  ServerEvent
} from "@aftertick/contracts";

function assignedQueue(queue: QueueState, assignment?: MatchAssignment): QueueState {
  return {
    ...queue,
    phase: "assigned",
    playersFound: queue.mode === "deathmatch"
      ? assignment?.humanPlayers ?? queue.playersFound
      : 10
  };
}

export function applyServerEvent(
  state: BootstrapResponse,
  event: ServerEvent
): BootstrapResponse {
  switch (event.type) {
    case "queue.updated":
      return {
        ...state,
        queue: event.payload,
        readyCheck: event.payload.phase === "ready-check" ? state.readyCheck : null,
        mapVeto: event.payload.phase === "map-veto" ? state.mapVeto : null
      };
    case "queue.cancelled":
      return {
        ...state,
        queue: event.payload,
        readyCheck: null,
        mapVeto: null,
        assignment: null
      };
    case "match.found":
    case "match.accepted":
      return { ...state, readyCheck: event.payload, mapVeto: null };
    case "match.veto.updated":
      return {
        ...state,
        queue: { ...state.queue, phase: "map-veto", playersFound: 10 },
        readyCheck: null,
        mapVeto: event.payload,
        assignment: null
      };
    case "match.assigned":
      return {
        ...state,
        queue: assignedQueue(state.queue, event.payload),
        readyCheck: null,
        mapVeto: null,
        assignment: event.payload
      };
  }
}

export function applyAcceptResult(
  state: BootstrapResponse,
  result: ReadyCheck | MapVetoState | MatchAssignment
): BootstrapResponse {
  if ("connectUrl" in result) {
    return {
      ...state,
      queue: assignedQueue(state.queue, result),
      readyCheck: null,
      mapVeto: null,
      assignment: result
    };
  }

  if ("remainingMaps" in result) {
    return {
      ...state,
      queue: { ...state.queue, phase: "map-veto", playersFound: 10 },
      readyCheck: null,
      mapVeto: result,
      assignment: null
    };
  }

  return { ...state, readyCheck: result };
}

export function hasPlayerAccepted(
  readyCheck: ReadyCheck,
  playerId: string
): boolean {
  return readyCheck.acceptedPlayerIds.includes(playerId);
}
