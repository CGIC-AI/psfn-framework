import { GATEWAY_RPC_OUTBOUND_BYTES, GATEWAY_RPC_OUTBOUND_FRAMES } from './transport-flow-limits.js';

/** Counts complete accepted writes until their native completion callbacks settle. */
export class GatewayRpcOutputBudget {
  private frames = 0;
  private bytes = 0;
  private closed = false;

  reserve(bytes: number, nativeBufferedBytes: number): (() => void) | undefined {
    if (this.closed || this.frames >= GATEWAY_RPC_OUTBOUND_FRAMES
      || bytes > GATEWAY_RPC_OUTBOUND_BYTES - Math.max(this.bytes, nativeBufferedBytes)) return undefined;
    this.frames++;
    this.bytes += bytes;
    let released = false;
    return () => {
      if (released || this.closed) return;
      released = true;
      this.frames--;
      this.bytes -= bytes;
    };
  }

  close(): void {
    this.closed = true;
    this.frames = 0;
    this.bytes = 0;
  }
}
