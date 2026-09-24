import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createClient } from "redis";
import { RedisQueueService } from "../apps/api/src/redis-queue-service.js";

const redisUrl = process.env["TEST_REDIS_URL"]
  ?? "redis://:aftertick-local-redis@127.0.0.1:6379/0";
const prefix = `aftertick:load:${randomUUID()}:`;
const playerCount = 200;
const firstClient = createClient({ url: redisUrl });
const secondClient = createClient({ url: redisUrl });
const timings = {
  join: [] as number[],
  duplicateJoin: [] as number[],
  readyCheck: [] as number[],
  accept: [] as number[],
  recoveryRead: [] as number[]
};

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1);
  return Math.round(ordered[Math.max(0, index)]! * 10) / 10;
}

async function measured<T>(bucket: number[], operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    bucket.push(performance.now() - startedAt);
  }
}

async function main(): Promise<void> {
  const hardTimeout = setTimeout(() => {
    console.error("Queue load smoke exceeded its 60-second hard timeout.");
    process.exit(1);
  }, 60_000);

  await Promise.all([firstClient.connect(), secondClient.connect()]);
  const [first, second] = await Promise.all([
    RedisQueueService.create(firstClient, { prefix }),
    RedisQueueService.create(secondClient, { prefix })
  ]);

  try {
  const players = Array.from({ length: playerCount }, (_, index) => `load-player-${index}`);
  await Promise.all(players.map((playerId, index) => measured(timings.join, () =>
    (index % 2 ? first : second).join({
      playerId,
      regions: ["NA Central"],
      maps: ["Mirage", "Inferno"]
    })
  )));

  await Promise.all(players.map((playerId, index) => measured(timings.duplicateJoin, () =>
    (index % 2 ? second : first).join({
      playerId,
      regions: ["EU Central"],
      maps: ["Nuke"]
    })
  )));

  const tickets = await first.listSearchingTickets();
  if (tickets.length !== playerCount) {
    throw new Error(`Expected ${playerCount} atomically unique tickets, found ${tickets.length}.`);
  }

  const checks = [];
  for (let offset = 0; offset < tickets.length; offset += 10) {
    const group = tickets.slice(offset, offset + 10);
    checks.push(await measured(timings.readyCheck, () => second.createReadyCheck({
      tickets: group,
      map: "Mirage",
      region: "NA Central",
      durationSeconds: 30,
      assignment: {
        serverLabel: `Queue load server ${offset / 10}`,
        address: "127.0.0.1:27115",
        connectUrl: "steam://connect/127.0.0.1:27115/aftertickLoadPassword123",
        launcherUrl: "b2g://connect?server=127.0.0.1%3A27115&password=aftertickLoadPassword123"
      }
    })));
  }

  if ((await first.listSearchingTickets()).length !== 0) {
    throw new Error("Claimed ready-check tickets remained in the searching index.");
  }

  const accepts = await Promise.all(checks.flatMap((check, checkIndex) => {
    const group = tickets.slice(checkIndex * 10, checkIndex * 10 + 10);
    return group.flatMap((ticket) => ticket.memberPlayerIds.map((playerId, playerIndex) =>
      measured(timings.accept, () =>
        ((checkIndex + playerIndex) % 2 ? first : second).accept(playerId, check.matchId)
      )
    ));
  }));
  const terminalAssignments = accepts.filter((result) => "connectUrl" in result);
  if (terminalAssignments.length !== checks.length) {
    throw new Error(
      `Expected one terminal assignment per ready check; found ${terminalAssignments.length} for ${checks.length}.`
    );
  }

  const runtimes = await Promise.all(players.map((playerId, index) =>
    measured(timings.recoveryRead, () => (index % 2 ? first : second).getQueueRuntime(playerId))
  ));
  if (runtimes.some((runtime) => runtime.queue.phase !== "assigned" || !runtime.assignment)) {
    throw new Error("At least one player could not recover the assigned match.");
  }

  const p95 = Object.fromEntries(
    Object.entries(timings).map(([name, values]) => [name, percentile(values, 0.95)])
  );
  for (const [name, durationMs] of Object.entries(p95)) {
    if (durationMs > 1_000) {
      throw new Error(`${name} p95 exceeded 1000 ms: ${durationMs} ms.`);
    }
  }

  console.log(JSON.stringify({
    players: playerCount,
    readyChecks: checks.length,
    uniqueTickets: tickets.length,
    terminalAssignments: terminalAssignments.length,
    recoveredAssignments: runtimes.length,
    p95Ms: p95
  }, null, 2));
  } finally {
    await Promise.all([first.close(), second.close()]);
    const keys = await firstClient.keys(`${prefix}*`);
    if (keys.length > 0) await firstClient.del(keys);
    await Promise.all([firstClient.quit(), secondClient.quit()]);
    clearTimeout(hardTimeout);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
