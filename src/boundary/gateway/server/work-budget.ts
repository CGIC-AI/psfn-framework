import { GATEWAY_RPC_GLOBAL_WORK_BYTES, GATEWAY_RPC_GLOBAL_WORK_FRAMES } from '../transport-flow-limits.js';

/** Active handler charges survive disconnect until the actual promise settles. */
export class GatewayRpcWorkBudget {
  private activeCount = 0;
  private retainedBytes = 0;

  reserve(bytes: number): (() => void) | undefined {
    if (this.activeCount >= GATEWAY_RPC_GLOBAL_WORK_FRAMES
      || bytes > GATEWAY_RPC_GLOBAL_WORK_BYTES - this.retainedBytes) return undefined;
    this.activeCount++;
    this.retainedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount--;
      this.retainedBytes -= bytes;
    };
  }
}
