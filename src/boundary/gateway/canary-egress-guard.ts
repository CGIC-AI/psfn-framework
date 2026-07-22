// ── Gateway canary egress guard (htm9.18) ──
//
// The egress tripwire. Every outbound gateway method that carries free text
// passes through here. The agent-side gateway client attaches the live session
// canary to the request; this guard scans the OTHER params for it. A hit means
// privileged prompt material has leaked into egress (prompt leak / hijack), so
// the action is HELD: the handler never runs, a durable CogSecEvent is written
// (token sha256 only — never the raw token), and the companion sees the calm,
// operator-reviewed soft notice instead of a scary error.
//
// Hold semantics: this build HOLDS by REFUSING the action (a CogSecEvent +
// audit + calm companion notice). Held egress actions are NOT enqueued into the
// Garden quarantine/approvals queue — that store's envelope state machine is
// shaped for INBOUND intake content (sourceClass / release-raw-or-sanitized),
// not outbound actions, so wiring it here would be a semantic stretch, not the
// "cheap" path the bead allows. The CogSecEvent is the operator-visible record.
//
// Cost: for the overwhelming benign majority the guard does one substring scan
// over the outbound strings and returns the (carrier-stripped) params. Scanner
// errors fail CLOSED — a scan we cannot complete holds the action.

import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors, type PolicyDecision } from './protocol.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../core/cogsec/intake-firewall-notice-templates.js';
import { hashCanaryToken } from '../../core/cogsec/canary/canary-token.js';
import {
  isEgressCanaryMethod,
  readCanaryCarrier,
  scanEgressParamsForCanary,
  stripCanaryCarrier,
  type CanaryScanResult,
} from '../../core/cogsec/canary/egress-scan.js';
import type { CogSecEventStore } from '../../core/cogsec/events.js';
import type { IntakeFirewallMode } from '../../system/config/intake-policy-config.js';

export interface CanaryEgressGuardLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface CanaryEgressGuardDeps {
  /** Shadow records would-hold findings but never blocks; enforce holds. */
  mode?: Exclude<IntakeFirewallMode, 'off'>;
  /** Absent ⇒ the guard still HOLDS leaks, but records no durable CogSec event. */
  cogSecEvents?: Pick<CogSecEventStore, 'createEvent'>;
  log?: CanaryEgressGuardLogger;
  /** Optional audit hook (records a HELD decision alongside the normal trail). */
  recordAudit?: (entry: {
    method: string;
    decision: PolicyDecision;
    params?: Record<string, unknown>;
  }) => void;
}

export interface CanaryEgressGuard {
  /**
   * Inspect an outbound method call. Returns the params to hand to the real
   * handler (carrier key stripped). THROWS a HELD error when the session canary
   * leaked into egress. Non-egress methods pass through untouched.
   */
  inspect(method: string, params: unknown): unknown;
  /**
   * d269: inspect a reverse-RPC REPLY result (the main conversational reply
   * returning from the agent as the result of voice.handleMessage /
   * voice.transcript.end / api.chat.completion / shard-action calls). The
   * agent attaches the session canary under the reserved carrier key; this
   * strips the carrier and scans the remaining reply strings. Returns the
   * carrier-free result; THROWS a HELD error in enforce mode when the canary
   * (or a fail-closed scan condition) is found. Results without a carrier
   * pass through with only the defensive strip.
   */
  inspectReply(method: string, result: unknown): unknown;
  /**
   * d269: inspect one streamed reply frame (api.stream.delta). Scans the frame
   * text against the carried token over a rolling per-request tail window so a
   * token split across frame boundaries is still caught before the fragment
   * that completes it egresses. In enforce mode a hit poisons the requestId —
   * this and all later frames of the stream are dropped (and the final
   * completion result is independently held by `inspectReply`). Returns
   * whether the frame may be forwarded to stream listeners.
   */
  inspectApiStreamDelta(input: {
    requestId: string;
    text: string;
    token: string | undefined;
  }): { forward: boolean };
}

function resolveSourceChannelId(method: string, params: unknown): string {
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const record = params as Record<string, unknown>;
    const channelId = record.channelId;
    if (typeof channelId === 'string' && channelId.trim().length > 0) {
      return channelId.trim();
    }
    // Reply results (api.chat.completion) nest the channel under `response`.
    const response = record.response;
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      const nested = (response as Record<string, unknown>).channelId;
      if (typeof nested === 'string' && nested.trim().length > 0) {
        return nested.trim();
      }
    }
  }
  return `egress:${method}`;
}

/**
 * Bounds on the per-request streamed-reply scan state. FIFO eviction: an
 * evicted tail only weakens split-frame detection for the evicted stream (a
 * whole-frame token is still caught, and the final completion result is
 * independently scanned), so a hostile flood cannot grow memory unboundedly.
 */
const MAX_TRACKED_STREAM_STATES = 512;

/** The calm, operator-reviewed message the companion sees for a held action. */
export const CANARY_HELD_NOTICE = INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld;

export function createCanaryEgressGuard(deps: CanaryEgressGuardDeps): CanaryEgressGuard {
  const mode = deps.mode ?? 'enforce';
  type LeakSurface = 'request' | 'reply' | 'stream';
  const surfaceSummary = (surface: LeakSurface, method: string): string => {
    const subject = surface === 'request'
      ? `Outbound content on ${method}`
      : surface === 'reply'
        ? `The conversational reply returning over ${method}`
        : `A streamed reply frame on ${method}`;
    return mode === 'enforce'
      ? `${subject} matched the session integrity marker and was held for review.`
      : `${subject} matched the session integrity marker in shadow mode and was allowed.`;
  };
  const recordLeak = (
    method: string,
    token: string,
    params: unknown,
    scan: CanaryScanResult,
    surface: LeakSurface = 'request',
  ): void => {
    if (scan.leaked !== true) return;
    // The raw token NEVER enters an event, audit row, or log line — only its
    // sha256 digest and a calm, blocklist-clean summary.
    const tokenHash = hashCanaryToken(token);
    deps.recordAudit?.({
      method,
      decision: mode === 'enforce' ? 'DENY' : 'ALLOW',
      params: mode === 'enforce'
        ? { canaryEgressHeld: true, reason: scan.reason }
        : { canaryEgressWouldHold: true, reason: scan.reason },
    });
    if (!deps.cogSecEvents) return;
    try {
      deps.cogSecEvents.createEvent({
        type: 'prompt_injection',
        severity: 'high',
        status: 'open',
        sourceChannelId: resolveSourceChannelId(method, params),
        actor: 'cogsec:canary-egress',
        actions: [],
        sealedForensicPayloadHashes: [tokenHash],
        safeAgentSummary: surfaceSummary(surface, method),
      });
    } catch (error) {
      // Holding the action is what matters; a failed audit event is loud, not
      // fatal to the hold.
      deps.log?.warn('Failed to record canary egress CogSec event', {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // d269: per-request streamed-reply scan state. `tail` keeps the last
  // (token.length - 1) chars already forwarded for the request so a token
  // split across frames is caught on the frame that completes it; `flagged`
  // requests recorded a leak already (enforce additionally stops forwarding).
  // Enforce-mode flagged entries are never evicted: otherwise a requestId
  // flood could reopen a poisoned stream. If every bounded slot is poisoned,
  // unseen streams receive an ephemeral flagged state and fail closed.
  const streamStates = new Map<string, { tail: string; flagged: boolean }>();
  const ensureStreamState = (requestId: string): { tail: string; flagged: boolean } => {
    const existing = streamStates.get(requestId);
    if (existing) return existing;
    if (streamStates.size >= MAX_TRACKED_STREAM_STATES) {
      for (const [candidateId, candidate] of streamStates) {
        if (mode === 'enforce' && candidate.flagged) continue;
        streamStates.delete(candidateId);
        break;
      }
      if (streamStates.size >= MAX_TRACKED_STREAM_STATES) {
        return { tail: '', flagged: true };
      }
    }
    const state = { tail: '', flagged: false };
    streamStates.set(requestId, state);
    return state;
  };

  return {
    inspect(method, params) {
      if (!isEgressCanaryMethod(method)) return params;
      const token = readCanaryCarrier(params);
      const cleaned = stripCanaryCarrier(params);
      // No token rode with this request (e.g. an out-of-turn proactive send):
      // nothing to compare against, so there is nothing to hold on. The carrier
      // is still stripped so no stray field reaches the handler.
      if (!token) return cleaned;

      const scan = scanEgressParamsForCanary(cleaned, token);
      if (scan.leaked) {
        recordLeak(method, token, cleaned, scan);
        deps.log?.warn(mode === 'enforce'
          ? 'Canary egress tripwire held an outbound action'
          : 'Canary egress tripwire observed a would-hold action in shadow mode', {
          method,
          reason: scan.reason,
        });
        if (mode === 'enforce') {
          throw new JSONRPCErrorException(CANARY_HELD_NOTICE, GatewayErrors.EGRESS_HELD);
        }
      }
      return cleaned;
    },

    inspectReply(method, result) {
      const token = readCanaryCarrier(result);
      const cleaned = stripCanaryCarrier(result);
      // No carrier rode back with this reply (CogSec off on the agent, a
      // non-turn result, or a turn that never planted a canary): nothing to
      // compare against. The carrier is still stripped so the reserved key
      // never reaches a channel adapter.
      if (!token) return cleaned;

      const scan = scanEgressParamsForCanary(cleaned, token);
      if (scan.leaked) {
        recordLeak(method, token, cleaned, scan, 'reply');
        deps.log?.warn(mode === 'enforce'
          ? 'Canary egress tripwire held a conversational reply'
          : 'Canary egress tripwire observed a would-hold reply in shadow mode', {
          method,
          reason: scan.reason,
        });
        if (mode === 'enforce') {
          throw new JSONRPCErrorException(CANARY_HELD_NOTICE, GatewayErrors.EGRESS_HELD);
        }
      }
      return cleaned;
    },

    inspectApiStreamDelta({ requestId, text, token }) {
      // No carrier on the frame ⇒ no live canary to compare against (CogSec
      // off or a non-canary turn); forward untouched.
      if (!token) return { forward: true };
      const state = ensureStreamState(requestId);
      if (state.flagged && mode === 'enforce') {
        // The stream already leaked: keep the tap closed for its remainder.
        return { forward: false };
      }
      let scan: CanaryScanResult;
      try {
        const window = state.tail + text;
        scan = window.includes(token)
          ? { leaked: true, reason: 'token_present' }
          : { leaked: false };
        // Keep strictly less than one full token so the tail alone can never
        // re-match; the next frame completes any straddling occurrence.
        state.tail = window.slice(-(Math.max(1, token.length - 1)));
      } catch (error) {
        void error;
        scan = { leaked: true, reason: 'scan_error' };
      }
      if (!scan.leaked) return { forward: true };
      if (!state.flagged) {
        state.flagged = true;
        recordLeak('api.stream.delta', token, { requestId }, scan, 'stream');
        deps.log?.warn(mode === 'enforce'
          ? 'Canary egress tripwire held a streamed reply frame'
          : 'Canary egress tripwire observed a would-hold streamed reply frame in shadow mode', {
          requestId,
          reason: scan.reason,
        });
      }
      return { forward: mode !== 'enforce' };
    },
  };
}
