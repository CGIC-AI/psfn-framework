import { GATEWAY_RPC_MAX_FRAME_BYTES } from './transport-framing.js';

// Fixed protocol safety limits, independent of runtime configuration and peers.
export const GATEWAY_RPC_INBOUND_FRAMES = 16;
export const GATEWAY_RPC_INBOUND_BYTES = GATEWAY_RPC_MAX_FRAME_BYTES;
export const GATEWAY_RPC_CONTROL_FRAMES = 1;
export const GATEWAY_RPC_CONTROL_BYTES = GATEWAY_RPC_MAX_FRAME_BYTES;
export const GATEWAY_RPC_GLOBAL_WORK_FRAMES = 256;
export const GATEWAY_RPC_GLOBAL_WORK_BYTES = 2 * GATEWAY_RPC_MAX_FRAME_BYTES;
export const GATEWAY_RPC_REQUEST_CONCURRENCY = 4;
export const GATEWAY_RPC_WORK_TIMEOUT_MS = 300_000;
export const GATEWAY_RPC_OUTBOUND_FRAMES = 128;
// Include the largest (masked, 64-bit length) WebSocket framing overhead.
export const GATEWAY_RPC_WIRE_OVERHEAD_BYTES = 14;
export const GATEWAY_RPC_OUTBOUND_BYTES = GATEWAY_RPC_MAX_FRAME_BYTES + GATEWAY_RPC_WIRE_OVERHEAD_BYTES;
