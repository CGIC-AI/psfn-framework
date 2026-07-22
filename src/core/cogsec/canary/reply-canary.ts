// ── CogSec canary reply capture (d269) ──
//
// Closes the reverse-RPC seam gap: the MAIN conversational reply returns to
// the gateway as the RESULT of a gateway→agent reverse call
// (voice.handleMessage / voice.transcript.end / api.chat.completion), a path
// the request-direction egress guard never sees. The fix mirrors the request
// path exactly: the agent attaches the live session canary to the reply under
// the reserved carrier key, and the gateway strips the carrier and scans the
// remaining reply strings before anything reaches a channel adapter.
//
// Mechanics: the reverse-RPC dispatch wraps the handler in an AsyncLocalStorage
// capture; turn execution records the session canary into the ambient capture
// when it plants the prompt marker (`turn-execution-runtime.ts`). When the
// handler resolves, the recorded token is attached to the (object) result. No
// call-signature threading, no extra RPC round-trips, and when CogSec mode is
// `off` no token is ever minted so the reply wire format is byte-identical.

import { AsyncLocalStorage } from 'node:async_hooks';
import { CANARY_CARRIER_PARAM_KEY } from './canary-token.js';

interface ReplyCanaryCapture {
  token: string | undefined;
}

const replyCanaryStorage = new AsyncLocalStorage<ReplyCanaryCapture>();

/**
 * Run a reverse-RPC reply handler inside a canary capture. If turn execution
 * records a session canary while the handler runs, the token is attached to
 * the resolved result under the reserved carrier key so the gateway reply
 * guard can scan the reply. Non-object results pass through unchanged (there
 * is nowhere to ride, and nothing string-bearing to scan at the seam).
 */
export async function captureReplyCanary<T>(fn: () => Promise<T>): Promise<T> {
  const capture: ReplyCanaryCapture = { token: undefined };
  const result = await replyCanaryStorage.run(capture, fn);
  return attachReplyCanaryCarrier(result, capture.token);
}

/**
 * Record the live session canary into the ambient reply capture, if one is
 * active. Called by turn execution at the point the canary is planted into the
 * prompt; a turn initiated outside a reply-bearing reverse call (e.g. a
 * notification-driven Discord turn whose reply egresses via `discord.send`)
 * has no active capture and this is a no-op.
 */
export function recordReplyCanaryToken(token: string): void {
  const capture = replyCanaryStorage.getStore();
  if (capture) {
    capture.token = token;
  }
}

/** Read the token recorded into the ambient reply capture, if any. */
export function getReplyCanaryCaptureToken(): string | undefined {
  return replyCanaryStorage.getStore()?.token;
}

function attachReplyCanaryCarrier<T>(result: T, token: string | undefined): T {
  if (!token) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return {
    ...(result as Record<string, unknown>),
    [CANARY_CARRIER_PARAM_KEY]: token,
  } as T;
}
