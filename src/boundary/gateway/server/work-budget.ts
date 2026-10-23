import { GATEWAY_RPC_GLOBAL_WORK_BYTES, GATEWAY_RPC_GLOBAL_WORK_FRAMES } from '../transport-flow-limits.js';

/**
 * Every retained queued/active frame is charged before admission. Active
 * handler charges survive disconnect until the actual promise settles.
 */
export class GatewayRpcWorkBudget {
  private retainedCount = 0;
  private retainedBytes = 0;

  reserve(bytes: number): (() => void) | undefined {
    if (this.retainedCount >= GATEWAY_RPC_GLOBAL_WORK_FRAMES
      || bytes > GATEWAY_RPC_GLOBAL_WORK_BYTES - this.retainedBytes) return undefined;
    this.retainedCount++;
    this.retainedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retainedCount--;
      this.retainedBytes -= bytes;
    };
  }
}
