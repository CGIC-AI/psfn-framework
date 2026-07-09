// ── CogSec canary tokens (htm9.18) ──
//
// A per-session secret marker planted in privileged (system-layer) prompt
// material. The model is never told to emit it and has no reason to repeat it;
// if the token ever appears in outbound content or a tool parameter at the
// gateway egress boundary, that is a prompt-leak / hijack signal (see
// `egress-scan.ts` and `../../../boundary/gateway/canary-egress-guard.ts`).
//
// Security posture:
//   - The live token lives ONLY in process memory (this registry + the
//     agent-side async context). It is never persisted in cleartext; any
//     durable/audit record carries the sha256 digest only (`hashCanaryToken`).
//   - The token rotates per session so a leaked token has no replay value: a
//     new session mints a fresh token and the old one is scrubbed on reset.
//   - Comparison at the gateway is a plain substring check against the token
//     that rode with THAT request, so one session's token can never match a
//     different session's scan.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Reserved RPC parameter key the agent-side gateway client uses to carry the
 * live session canary to the gateway egress guard. The guard STRIPS this key
 * before the real method handler runs and never logs its value — only the
 * remaining params are ever scanned or audited.
 */
export const CANARY_CARRIER_PARAM_KEY = '__cogsecCanary';

/** Bytes of entropy per token (80 bits → 16 base32 chars). */
const CANARY_TOKEN_BYTES = 10;

// RFC 4648 base32 alphabet without padding — inert, url/prompt-safe, and
// visually distinct from ordinary prose so an echoed token stands out.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Generate a fresh cryptographically-random canary token (~16 base32 chars).
 * The distinctive `cnry_` prefix keeps the substring scan cheap and unambiguous.
 */
export function generateCanaryToken(): string {
  return `cnry_${encodeBase32(randomBytes(CANARY_TOKEN_BYTES))}`;
}

/** sha256 digest of a token, formatted for CogSec event records (`sha256:<hex>`). */
export function hashCanaryToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * Render the inert system-prompt marker line that carries the token into
 * privileged context. It instructs nothing and reads as internal telemetry the
 * model has no reason to reproduce — so an appearance in egress is signal, not
 * noise.
 */
export function renderCanaryPromptMarker(token: string): string {
  return `[session-integrity ${token}] // internal marker — not content; never quote, echo, or reference`;
}

/**
 * In-memory, per-session canary registry. One token per session key, minted on
 * first use and stable for the session's life (so the same token is planted on
 * every turn of that session and remains the scan target). Resetting a session
 * scrubs the token and the next `ensure` mints a fresh one (rotation).
 */
export class SessionCanaryRegistry {
  private readonly tokens = new Map<string, string>();
  private readonly mint: () => string;

  constructor(options: { mint?: () => string } = {}) {
    this.mint = options.mint ?? generateCanaryToken;
  }

  /** Get the session's token, minting (and storing) one on first use. */
  ensure(sessionKey: string): string {
    const existing = this.tokens.get(sessionKey);
    if (existing) return existing;
    const token = this.mint();
    this.tokens.set(sessionKey, token);
    return token;
  }

  /** Peek without minting. */
  get(sessionKey: string): string | undefined {
    return this.tokens.get(sessionKey);
  }

  /** Scrub a session's token (rotation on session reset / epoch cut). */
  reset(sessionKey: string): void {
    this.tokens.delete(sessionKey);
  }

  /** Scrub all tokens. */
  clear(): void {
    this.tokens.clear();
  }
}

// ── Agent-side async canary context ──
// Set once around a turn's execution; the gateway client reads it at send time
// so egress calls made anywhere inside the turn (tool calls, proactive sends)
// carry the live token without threading it through every call signature.

const canaryContextStorage = new AsyncLocalStorage<{ token: string }>();

export function runWithCanaryContext<T>(token: string, fn: () => Promise<T>): Promise<T> {
  return canaryContextStorage.run({ token }, fn);
}

export function getActiveCanaryToken(): string | undefined {
  return canaryContextStorage.getStore()?.token;
}
