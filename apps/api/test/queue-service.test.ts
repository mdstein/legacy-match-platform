import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueService } from "../src/queue-service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("QueueService", () => {
  it("clears the completed ready check after assigning a server", () => {
    vi.useFakeTimers();
    const service = new QueueService({
      autoMatchDelayMs: 0,
      readyCheckSeconds: 20
    });
    const playerId = "steam:76561198000000000";

    service.join({
      playerId,
      regions: ["NA Central"],
      maps: ["Mirage"]
    });
    vi.advanceTimersByTime(0);

    const activeReadyCheck = service.getQueueRuntime(playerId).readyCheck;
    expect(activeReadyCheck).not.toBeNull();

    const assignment = service.accept(playerId, activeReadyCheck!.matchId);
    const runtime = service.getQueueRuntime(playerId);

    expect("connectUrl" in assignment).toBe(true);
    expect(runtime.queue.phase).toBe("assigned");
    expect(runtime.readyCheck).toBeNull();
    expect(runtime.assignment).toEqual(assignment);
  });

  it("assigns every Deathmatch to the server-owned Dust II pool and preserves the mode", () => {
    vi.useFakeTimers();
    const service = new QueueService({ autoMatchDelayMs: 0, readyCheckSeconds: 20 });
    const playerId = "steam:76561198000000001";

    const queued = service.join({
      playerId,
      regions: ["NA Central"],
      maps: [],
      mode: "deathmatch"
    });
    expect(queued.maps).toEqual(["Dust II"]);
    vi.advanceTimersByTime(0);

    const ready = service.getQueueRuntime(playerId).readyCheck!;
    expect(ready).toMatchObject({ mode: "deathmatch", totalPlayers: 14 });
    expect(ready.mapPool).toEqual(["Dust II"]);
    expect(ready.map).toBe("Dust II");

    const assignment = service.accept(playerId, ready.matchId);
    expect(assignment).toMatchObject({ mode: "deathmatch", map: ready.map });
    expect(service.getQueueRuntime(playerId).queue).toMatchObject({
      mode: "deathmatch",
      phase: "assigned",
      playersFound: 14
    });
  });
});
