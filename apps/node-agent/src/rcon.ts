import net from "node:net";

function packet(id: number, type: number, body: string): Buffer {
  const bodyBuffer = Buffer.from(body, "utf8");
  const result = Buffer.alloc(14 + bodyBuffer.length);
  result.writeInt32LE(10 + bodyBuffer.length, 0);
  result.writeInt32LE(id, 4);
  result.writeInt32LE(type, 8);
  bodyBuffer.copy(result, 12);
  result.writeInt16LE(0, 12 + bodyBuffer.length);
  return result;
}

export async function sendRcon(input: {
  host: string;
  port: number;
  password: string;
  command: string;
  timeoutMs?: number | undefined;
}): Promise<string> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  const socket = net.createConnection({ host: input.host, port: input.port });
  socket.setTimeout(timeoutMs);
  let pending = Buffer.alloc(0);
  const frames: Array<{ id: number; type: number; body: string }> = [];
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readInt32LE(0);
      if (length < 10 || pending.length < length + 4) break;
      frames.push({
        id: pending.readInt32LE(4),
        type: pending.readInt32LE(8),
        body: pending.toString("utf8", 12, length + 2)
      });
      pending = pending.subarray(length + 4);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("RCON connection timed out.")));
    });
    socket.write(packet(1, 3, input.password));
    const authDeadline = Date.now() + timeoutMs;
    while (!frames.some((frame) => frame.type === 2)) {
      if (Date.now() >= authDeadline) throw new Error("RCON authentication timed out.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (frames.find((frame) => frame.type === 2)?.id === -1) {
      throw new Error("RCON authentication failed.");
    }
    frames.length = 0;
    socket.write(packet(2, 2, input.command));
    const responseDeadline = Date.now() + Math.min(timeoutMs, 2_000);
    while (frames.length === 0 && Date.now() < responseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return frames.filter((frame) => frame.id === 2).map((frame) => frame.body).join("");
  } finally {
    socket.end();
  }
}
