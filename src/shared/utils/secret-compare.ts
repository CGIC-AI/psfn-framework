import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time equality check for secret strings (admin tokens, auth cookies).
 *
 * Both inputs are first reduced to fixed-length SHA-256 digests, then compared
 * with `crypto.timingSafeEqual`. Digest-then-compare keeps the comparison
 * constant-time regardless of input length, avoids the length-mismatch throw
 * that `timingSafeEqual` raises on unequal-length buffers, and does not leak the
 * length of the expected secret through either timing or an early return.
 *
 * Use this for every secret comparison instead of `===`, which short-circuits
 * on the first differing byte and is therefore timing-observable.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
