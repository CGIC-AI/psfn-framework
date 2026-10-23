import type { HubResourceLimits } from "./transport-resources.js";

interface OutputSocket {
  readonly bufferedAmount: number;
  send(data: string | Buffer, callback: (error?: Error) => void): void;
  pong?(data: Buffer, mask: boolean | undefined, callback: (error?: Error) => void): void;
  close?(code?: number, reason?: string | Buffer): void;
  terminate(): void;
}

type OutputLimits = Pick<HubResourceLimits, "maxFrameBytes" | "maxBufferedBytes" | "maxQueuedMessages" | "providerTimeoutMs">;

/** Socket-owned admission. Context cancellation never releases a socket write. */
export class SocketOutput {
  private readonly writes = new Map<() => void, (error?: Error) => void>();
  private bytes = 0;
  private stopped = false;
  private closing = false;

  constructor(private readonly socket: OutputSocket, private readonly limits: OutputLimits,
    private readonly onFailure: (error: Error) => void, private readonly label = "Hub provider",
    private readonly serverFrameHeaders = false) {}

  send(data: string | Buffer): void {
    this.write(data, callback => this.socket.send(data, callback));
  }

  sendAndWait(data: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.write(data, callback => this.socket.send(data, callback), error => error ? reject(error) : resolve());
    });
  }

  pong(data: Buffer): void {
    this.write(data, callback => {
      if (!this.socket.pong) throw new Error("Hub provider control output unavailable");
      this.socket.pong(data, undefined, callback);
    });
  }

  /** ws close has no send callback; retain its charge until terminal close. */
  close(code?: number, reason?: string | Buffer): void {
    if (this.closing || this.stopped) return;
    const bytes = code === undefined ? 0 : 2 + (typeof reason === "string" ? Buffer.byteLength(reason) : reason?.byteLength ?? 0);
    this.write(bytes, () => {
      if (!this.socket.close) throw new Error("Close output unavailable");
      this.closing = true;
      this.socket.close(code, reason);
    });
  }

  private write(data: string | Buffer | number, write: (callback: (error?: Error) => void) => void,
    completion?: (error?: Error) => void): void {
    if (this.stopped || this.closing) throw new Error(`${this.label} output is closed`);
    const bytes = typeof data === "number" ? data : typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    // ws invokes a send callback only after that write leaves its native queue.
    // Native bytes therefore overlap callback-pending writes: use the larger
    // charge, rather than adding the same payload twice. Also retain callbacks
    // whose native write has drained but whose completion has not run yet.
    const retainedBytes = Math.max(this.bytes, this.socket.bufferedAmount);
    // Accepted listeners are unmasked and uncompressed. Reserve the actual ws
    // header before enqueue as well: native bufferedAmount includes wire bytes,
    // including the header of a write that first encounters TCP backpressure.
    const nativeBytes = bytes + (this.serverFrameHeaders ? bytes < 126 ? 2 : bytes <= 65_535 ? 4 : 10 : 0);
    if (bytes > this.limits.maxFrameBytes || retainedBytes + bytes > this.limits.maxBufferedBytes
      || this.socket.bufferedAmount + nativeBytes > this.limits.maxBufferedBytes
      || this.writes.size >= this.limits.maxQueuedMessages) {
      const error = new Error(`${this.label} output buffer exceeded`);
      this.fail(error);
      throw error;
    }
    this.bytes += bytes;
    let settled = false;
    const settle = (error?: Error): void => {
      const callback = completion;
      completion = undefined;
      callback?.(error);
    };
    const release = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.bytes -= bytes;
      this.writes.delete(release);
      settle();
    };
    const timer = setTimeout(() => this.fail(new Error(`${this.label} output timed out`)), this.limits.providerTimeoutMs);
    timer.unref();
    this.writes.set(release, settle);
    try {
      write(error => {
        if (settled) return;
        if (error) this.fail(new Error(`${this.label} output send failed`));
        else release();
      });
    } catch {
      const error = new Error(`${this.label} output send failed`);
      this.fail(error);
      throw error;
    }
  }

  /** Only terminal socket close releases writes whose callbacks never arrived. */
  closed(): void {
    this.stopped = true;
    for (const [release, settle] of this.writes) {
      settle(new Error(`${this.label} output is closed`));
      release();
    }
  }

  terminate(): void {
    this.fail(new Error(`${this.label} output is closed`));
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    // Logical completion never releases transport reservations.
    for (const settle of this.writes.values()) settle(error);
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
