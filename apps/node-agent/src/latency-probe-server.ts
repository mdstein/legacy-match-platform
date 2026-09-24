import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";

const A2S_INFO_QUERY = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
  Buffer.from("Source Engine Query\0", "ascii")
]);
const A2S_INFO_ACKNOWLEDGEMENT = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]);

export interface LatencyProbeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Keeps latency measurement available while the on-demand SRCDS process is
 * offline. The exact-query gate and five-byte response make this deliberately
 * non-amplifying; match discovery and connection still target the SRCDS port.
 */
export class UdpLatencyProbeServer implements LatencyProbeServer {
  private socket: Socket | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number
  ) {}

  async start(): Promise<void> {
    if (this.socket) return;

    const socket = createSocket("udp4");
    this.socket = socket;
    socket.on("message", (message, remote) => this.respond(socket, message, remote));
    socket.on("error", (error) => {
      console.error("Latency-probe UDP error:", error.message);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          socket.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          socket.off("error", onError);
          resolve();
        };
        socket.once("error", onError);
        socket.once("listening", onListening);
        socket.bind(this.port, this.host);
      });
    } catch (error) {
      this.socket = null;
      socket.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  address(): AddressInfo | null {
    const address = this.socket?.address();
    return address && typeof address !== "string" ? address : null;
  }

  private respond(socket: Socket, message: Buffer, remote: RemoteInfo): void {
    if (!message.equals(A2S_INFO_QUERY)) return;
    socket.send(A2S_INFO_ACKNOWLEDGEMENT, remote.port, remote.address, (error) => {
      if (error) console.error("Latency-probe response error:", error.message);
    });
  }
}
