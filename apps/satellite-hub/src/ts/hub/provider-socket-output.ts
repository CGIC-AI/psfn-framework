import type { HubResourceLimits } from "./transport-resources.js";

interface ProviderOutputSocket {
  readonly bufferedAmount: number;
  send(data: string | Buffer, callback: (error?: Error) => void): void;
  pong?(data: Buffer, mask: boolean | undefined, callback: (error?: Error) => void): void;
  terminate(): void;
}

type OutputLimits = Pick<HubResourceLimits, "maxFrameBytes" | "maxBufferedBytes" | "maxQueuedMessages" | "providerTimeoutMs">;

/** Socket-owned admission. Context cancellation never releases a socket write. */
export class ProviderSocketOutput {
  private readonly writes = new Set<() => void>();
  private bytes = 0;
  private stopped = false;

  constructor(private readonly socket: ProviderOutputSocket, private readonly limits: OutputLimits,
    private readonly onFailure: (error: Error) => void) {}

  send(data: string | Buffer): void {
    this.write(data, callback => this.socket.send(data, callback));
  }

  pong(data: Buffer): void {
    this.write(data, callback => {
      if (!this.socket.pong) throw new Error("Hub provider control output unavailable");
      this.socket.pong(data, undefined, callback);
    });
  }

  private write(data: string | Buffer, write: (callback: (error?: Error) => void) => void): void {
    if (this.stopped) throw new Error("Hub provider output is closed");
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    // ws invokes a send callback only after that write leaves its native queue.
    // Native bytes therefore overlap callback-pending writes: use the larger
    // charge, rather than adding the same payload twice. Also retain callbacks
    // whose native write has drained but whose completion has not run yet.
    const retainedBytes = Math.max(this.bytes, this.socket.bufferedAmount);
    if (bytes > this.limits.maxFrameBytes || retainedBytes + bytes > this.limits.maxBufferedBytes
      || this.writes.size >= this.limits.maxQueuedMessages) {
      const error = new Error("Hub provider output buffer exceeded");
      this.fail(error);
      throw error;
    }
    this.bytes += bytes;
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.bytes -= bytes;
      this.writes.delete(release);
    };
    const timer = setTimeout(() => this.fail(new Error("Hub provider output timed out")), this.limits.providerTimeoutMs);
    timer.unref();
    this.writes.add(release);
    try {
      write(error => {
        if (settled) return;
        release();
        if (error) this.fail(new Error("Hub provider output send failed"));
      });
    } catch {
      release();
      const error = new Error("Hub provider output send failed");
      this.fail(error);
      throw error;
    }
  }

  /** Only terminal socket close releases writes whose callbacks never arrived. */
  closed(): void {
    this.stopped = true;
    for (const release of this.writes) release();
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.socket.terminate(); }
    catch {
      // A failed transport teardown is terminal for this owner as well. It can
      // never admit another write, even if a broken connector never closes.
      this.closed();
    }
    try { this.onFailure(error); }
    catch { /* Transport failure must not escape an asynchronous send callback. */ }
  }
}
