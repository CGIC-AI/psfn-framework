/**
 * Small base64 helpers for the browser audio contract. The inbound `audio`
 * frame body is a base64 string; these keep validation and byte accounting in
 * one place so the reassembler can bound a reply without decoding it.
 */

/** Standard (non-URL) base64 with correct padding, matching the wire framing. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * Decoded byte length of a well-formed base64 string. Returns 0 for input that
 * is not valid base64 so callers never over-count an unbounded reply.
 */
export function base64ByteLength(value: string): number {
  if (!isBase64(value) || value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/**
 * Decode a base64 string to bytes using the platform decoder. Throws on
 * malformed input rather than returning a partial buffer (fail closed).
 */
export function decodeBase64ToBytes(value: string): Uint8Array {
  if (!isBase64(value)) throw new Error('Audio frame was not valid base64');
  const decoder = (globalThis as { atob?: (data: string) => string }).atob;
  if (!decoder) throw new Error('No base64 decoder is available in this environment');
  const binary = decoder(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
