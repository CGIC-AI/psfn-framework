import {
  GATEWAY_RPC_CONTROL_BYTES,
  GATEWAY_RPC_CONTROL_FRAMES,
  GATEWAY_RPC_INBOUND_BYTES,
  GATEWAY_RPC_INBOUND_FRAMES,
  GATEWAY_RPC_REQUEST_CONCURRENCY,
  GATEWAY_RPC_WORK_TIMEOUT_MS,
} from '../transport-flow-limits.js';
import { withGatewayRpcWorkLifetime } from '../rpc-work-lifetime.js';
import type { GatewayRpcWorkBudget } from './work-budget.js';

interface PendingFrame {
  message: unknown;
  bytes: number;
  control: boolean;
  release: () => void;
}

/** One owner for all admitted parsed frames, workers, deadlines and health leases. */
export class GatewayConnectionWork {
  private readonly queue: PendingFrame[] = [];
  private readonly active = new Map<PendingFrame, () => void>();
  private retainedRequestBytes = 0;
  private retainedControlBytes = 0;
  private retainedRequests = 0;
  private retainedControls = 0;
  private requestCount = 0;
  private controlCount = 0;
  private closed = false;
  private pendingPump: NodeJS.Immediate | undefined;

  constructor(
    private readonly budget: GatewayRpcWorkBudget,
    private readonly dispatch: (message: unknown) => Promise<void>,
    private readonly beginHealthcheck: () => () => void,
    private readonly fail: () => void,
  ) {}

  accept(message: unknown, bytes: number, control: boolean): void {
    if (this.closed) return;
    const overBudget = control
      ? this.retainedControls >= GATEWAY_RPC_CONTROL_FRAMES
        || bytes > GATEWAY_RPC_CONTROL_BYTES - this.retainedControlBytes
      : this.retainedRequests >= GATEWAY_RPC_INBOUND_FRAMES
        || bytes > GATEWAY_RPC_INBOUND_BYTES - this.retainedRequestBytes;
    if (overBudget) {
      this.reject();
      return;
    }
    const release = this.budget.reserve(bytes);
    if (!release) {
      this.reject();
      return;
    }
    if (control) { this.retainedControlBytes += bytes; this.retainedControls++; }
    else { this.retainedRequestBytes += bytes; this.retainedRequests++; }
    this.queue.push({ message, bytes, control, release });
    this.pump();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearImmediate(this.pendingPump);
    this.pendingPump = undefined;
    for (const frame of this.queue) this.releaseRetained(frame);
    this.queue.length = 0;
    // Stop timers/health leases immediately. Actual handler charges remain until
    // settlement: a peer cannot free orphan work by disconnecting and retrying.
    for (const stop of this.active.values()) stop();
  }

  private reject(): void {
    if (this.closed) return;
    this.close();
    this.fail();
  }

  private pump(): void {
    while (!this.closed) {
      // A response must be able to unblock reverse RPC made by a busy handler.
      const index = this.queue.findIndex(frame => frame.control
        ? this.controlCount === 0 : this.requestCount < GATEWAY_RPC_REQUEST_CONCURRENCY);
      if (index < 0) return;
      const frame = this.queue.splice(index, 1)[0]!;
      if (frame.control) this.controlCount++;
      else this.requestCount++;
      const releaseHealth = this.beginHealthcheck();
      const timer = setTimeout(() => this.reject(), GATEWAY_RPC_WORK_TIMEOUT_MS);
      timer.unref();
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        releaseHealth();
      };
      this.active.set(frame, stop);
      const message = frame.message;
      frame.message = undefined;
      void withGatewayRpcWorkLifetime(() => this.dispatch(message)).then(() => this.finish(frame), () => {
        this.finish(frame);
        this.reject();
      });
    }
  }

  private releaseRetained(frame: PendingFrame): void {
    frame.release();
    if (frame.control) { this.retainedControlBytes -= frame.bytes; this.retainedControls--; }
    else { this.retainedRequestBytes -= frame.bytes; this.retainedRequests--; }
  }

  private finish(frame: PendingFrame): void {
    const stop = this.active.get(frame);
    if (!stop) return;
    stop();
    this.active.delete(frame);
    this.releaseRetained(frame);
    if (frame.control) this.controlCount--;
    else this.requestCount--;
    if (this.closed) return;
    // Yield between batches even when every handler settles immediately.
    if (!this.pendingPump) this.pendingPump = setImmediate(() => {
      this.pendingPump = undefined;
      this.pump();
    });
  }
}
