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
}

function resolveSourceChannelId(method: string, params: unknown): string {
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const channelId = (params as Record<string, unknown>).channelId;
    if (typeof channelId === 'string' && channelId.trim().length > 0) {
      return channelId.trim();
    }
  }
  return `egress:${method}`;
}

/** The calm, operator-reviewed message the companion sees for a held action. */
export const CANARY_HELD_NOTICE = INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld;

export function createCanaryEgressGuard(deps: CanaryEgressGuardDeps): CanaryEgressGuard {
  const mode = deps.mode ?? 'enforce';
  const recordLeak = (method: string, token: string, params: unknown, scan: CanaryScanResult): void => {
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
        safeAgentSummary: mode === 'enforce'
          ? `Outbound content on ${method} matched the session integrity marker and was held for review.`
          : `Outbound content on ${method} matched the session integrity marker in shadow mode and was allowed.`,
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
  };
}
