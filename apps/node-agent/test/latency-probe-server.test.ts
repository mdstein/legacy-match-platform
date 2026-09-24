import { createSocket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { UdpLatencyProbeServer } from "../src/latency-probe-server.js";

const servers: UdpLatencyProbeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("latency probe server", () => {
  it("acknowledges an exact Source A2S info query while SRCDS is offline", async () => {
    const server = new UdpLatencyProbeServer("127.0.0.1", 0);
    servers.push(server);
    await server.start();
    const address = server.address();
    expect(address).not.toBeNull();

    const client = createSocket("udp4");
    try {
      const response = new Promise<Buffer>((resolve, reject) => {
        client.once("message", resolve);
        client.once("error", reject);
      });
      const query = Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
        Buffer.from("Source Engine Query\0", "ascii")
      ]);
      client.send(query, address!.port, "127.0.0.1");

      await expect(response).resolves.toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]));
    } finally {
      client.close();
    }
  });
});
