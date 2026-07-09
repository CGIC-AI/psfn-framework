// ── Gateway inbound contact-block gate (htm9.16) ──
//
// The gateway is where inbound channel messages land before they are forwarded
// across RPC to the isolated agent process. This gate is the guaranteed backstop
// for companion-initiated blocking: it consults the persisted block list and, for
// a blocked DM, the message is dropped here — it never reaches the agent, so no
// context or companion attention is spent. Group messages are downgraded to
// observe-only instead of dropped so the room is not disrupted for everyone else.
//
// SOFT blocks additionally emit a cogsec/quarantine event on each enforcement so
// the operator retains visibility that a blocked contact is still trying. HARD
// blocks stay silent by design.

import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type {
  ContactBlockDecision,
  ContactBlockListStore,
} from '../../core/cogsec/contact-block-list.js';
import type { CogSecEventStore } from '../../core/cogsec/events.js';

export interface ContactBlockGate {
  /** Decide how the gateway should treat an inbound message from a contact. */
  evaluate(
    message: Pick<SubstrateMessage, 'channelType' | 'authorId' | 'isDirectMessage'>,
  ): ContactBlockDecision;
  /**
   * Emit the operator-facing cogsec/quarantine event for a SOFT block. No-op for
   * hard/allow decisions. Errors are surfaced (never swallowed) but must not
   * abort the drop — the message is already blocked regardless.
   */
  recordSoftBlockEnforcement(message: SubstrateMessage, decision: ContactBlockDecision): void;
}

export interface GatewayContactBlockGateLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface GatewayContactBlockGateDeps {
  blockList: Pick<ContactBlockListStore, 'evaluate'>;
  /** Optional: when absent, soft-block enforcement records no operator event. */
  cogSecEvents?: Pick<CogSecEventStore, 'createEvent'>;
  log?: GatewayContactBlockGateLogger;
}

export function createGatewayContactBlockGate(
  deps: GatewayContactBlockGateDeps,
): ContactBlockGate {
  return {
    evaluate(message) {
      return deps.blockList.evaluate({
        channelType: message.channelType,
        contactId: message.authorId,
        isDirectMessage: message.isDirectMessage ?? false,
      });
    },
    recordSoftBlockEnforcement(message, decision) {
      if (decision.mode !== 'soft') return;
      if (decision.action === 'allow') return;
      if (!deps.cogSecEvents) return;
      const disposition = decision.action === 'drop' ? 'dropped' : 'held (observe-only)';
      try {
        deps.cogSecEvents.createEvent({
          type: 'intake_firewall',
          severity: 'low',
          status: 'applied',
          sourceChannelId: message.channelId,
          actor: 'companion:block',
          actions: [],
          safeAgentSummary: `Soft-blocked contact inbound ${disposition} on ${message.channelType}`,
        });
      } catch (error) {
        // The block already happened; a failed audit event must be loud, not
        // fatal to the drop. Surface it rather than swallow it.
        deps.log?.warn('Failed to record soft-block cogsec event', {
          channelType: message.channelType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
