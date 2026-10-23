/**
 * psfn-rpc-v1 caps each JSON payload at 64 MiB of UTF-8, in either direction.
 * NDJSON CR/LF delimiters and WebSocket framing are excluded. This fixed
 * protocol boundary accommodates a 25 MiB attachment encoded as base64 plus
 * envelope/headroom; aggregate payloads must still fit the same ceiling.
 */
export const GATEWAY_RPC_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class GatewayRpcFrameSizeError extends Error {
  constructor() {
    super('Gateway RPC frame exceeds the UTF-8 byte limit');
    this.name = 'GatewayRpcFrameSizeError';
  }
}

/** Serialize and validate the complete payload before any transport write. */
export function serializeGatewayRpcFrame(data: unknown): { serialized: string; serializedBytes: number } {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(data);
  } catch {
    // A user-provided toJSON may throw a content-bearing error.
    throw new Error('Gateway RPC frame serialization failed');
  }
  if (typeof serialized !== 'string') throw new Error('Gateway RPC frame is not JSON serializable');
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > GATEWAY_RPC_MAX_FRAME_BYTES) throw new GatewayRpcFrameSizeError();
  return { serialized, serializedBytes };
}

/**
 * Count raw bytes before decoding or retaining them. A single growing buffer
 * bounds both payload storage and metadata, even for one-byte chunks. Decode
 * only complete frames so split UTF-8 sequences remain intact. CR, LF and
 * split CRLF preserve the former readline crlfDelay=Infinity framing.
 */
export class GatewayRpcNdjsonFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private length = 0;
  private closed = false;

  push(chunk: Buffer, onFrame: (frame: string) => void): void {
    let offset = 0;
    while (!this.closed && offset < chunk.length) {
      const lf = chunk.indexOf(10, offset);
      const cr = chunk.indexOf(13, offset);
      const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      const segmentEnd = end < 0 ? chunk.length : end;
      this.append(chunk.subarray(offset, segmentEnd));
      if (end < 0) return;
      const frame = this.takeFrame();
      // Empty CRLF halves and blank lines do not enter JSON-RPC.
      if (frame.length > 0) onFrame(frame);
      offset = end + 1;
    }
  }

  end(onFrame: (frame: string) => void): void {
    if (this.closed) return;
    if (this.length > 0) onFrame(this.takeFrame());
    this.close();
  }

  close(): void {
    this.closed = true;
    this.length = 0;
    this.buffer = Buffer.alloc(0);
  }

  private append(segment: Buffer): void {
    const required = this.length + segment.length;
    if (required > GATEWAY_RPC_MAX_FRAME_BYTES) {
      this.close();
      throw new GatewayRpcFrameSizeError();
    }
    if (required > this.buffer.length) {
      const capacity = Math.min(
        GATEWAY_RPC_MAX_FRAME_BYTES,
        Math.max(required, this.buffer.length * 2),
      );
      const grown = Buffer.allocUnsafe(capacity);
      this.buffer.copy(grown, 0, 0, this.length);
      this.buffer = grown;
    }
    segment.copy(this.buffer, this.length);
    this.length = required;
  }

  private takeFrame(): string {
    const frame = this.buffer.toString('utf8', 0, this.length);
    this.length = 0;
    // Do not retain a large completed frame's capacity on an idle connection.
    this.buffer = Buffer.alloc(0);
    return frame;
  }
}
