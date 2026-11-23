// ── Agent cognition intake firewall & quarantine wiring ──
//
// Extracted from app/agent/main.ts (Phase 4.3 decomposition): owns agent-side
// L1 intake screening, content-addressed admission receipts, durable quarantine
// holds, and human-escalation hooks for holds and expiries.

import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { maybeCreateIntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import { createIntakeQuarantineStore } from '../../../core/cogsec/intake/quarantine-store.js';
import {
  createQuarantineDecisionEscalationObserver,
  createQuarantineHoldEscalationObserver,
} from '../../../core/cogsec/intake/quarantine-escalation-producer.js';
import { resolveIntakeQuarantinePath } from '../../../persistence/layout.js';
import type { AgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';
import { COGSEC_INTAKE_FIREWALL_ISSUER_ID } from '../../../shared/contracts/cogsec-receipt.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { HumanEscalationLedgerPort } from '../../../shared/escalation/contracts.js';
import { emitGardenQueueChanged } from '../../../shared/garden-queue-change.js';
import {
  intakeReceiptTtlMs,
  loadIntakePolicyConfig,
  type IntakePolicyConfig,
} from '../../../system/config/intake-policy-config.js';

interface AgentCognitionIntakeLogger {
  info(message: string, payload?: Record<string, unknown>): void;
  error(message: string, payload?: Record<string, unknown>): void;
}

interface AgentCognitionIntakeDeps {
  systemDataDir: string;
  companionDataDir: string;
  companionId?: string;
  eventBus: EventBus;
  humanEscalationControlPlane: Parameters<typeof createQuarantineHoldEscalationObserver>[0]['plane'];
  humanEscalationStore: HumanEscalationLedgerPort;
  fleetSystemHumanEscalationStore?: HumanEscalationLedgerPort | null;
  cogSecReceiptStore: AgentPersistenceRuntime['cogSecReceiptStore'];
  sessionManager: SessionManager;
  agentLoop: SubstrateAgent;
  log: AgentCognitionIntakeLogger;
}

interface AgentCognitionIntakeRuntime {
  intakePolicy: IntakePolicyConfig;
  intakeScreening: ReturnType<typeof maybeCreateIntakeScreeningService>;
}

export function wireAgentCognitionIntake(
  deps: AgentCognitionIntakeDeps,
): AgentCognitionIntakeRuntime {
  const {
    systemDataDir,
    companionDataDir,
    companionId,
    eventBus,
    humanEscalationControlPlane,
    humanEscalationStore,
    fleetSystemHumanEscalationStore,
    cogSecReceiptStore,
    sessionManager,
    agentLoop,
    log,
  } = deps;

  const intakePolicy = loadIntakePolicyConfig(systemDataDir);
  const quarantineHoldEscalation = createQuarantineHoldEscalationObserver({
    plane: humanEscalationControlPlane,
    ...(companionId ? { companionId } : {}),
    renderNotice: entry => ({
      sender: {
        kind: 'system' as const,
        provenance: 'system.cogsec.quarantine_escalation',
      },
      title: 'Quarantined item awaiting an operator',
      message: `Garden: /cognitive-security, item ${entry.id}`,
    }),
  });
  const quarantineExpiryEscalation = createQuarantineDecisionEscalationObserver({
    ledgers: [
      humanEscalationStore,
      ...(fleetSystemHumanEscalationStore ? [fleetSystemHumanEscalationStore] : []),
    ],
  });
  const intakeQuarantineWriter = createIntakeQuarantineStore(
    resolveIntakeQuarantinePath(companionDataDir),
    {
      itemTtlHours: intakePolicy.quarantine.itemTtlHours,
      maxHeldItems: intakePolicy.quarantine.maxHeldItems,
      onHeld: entry => quarantineHoldEscalation(entry),
      onExpired: ({ entry, expiredAtMs, reason }) => {
        quarantineExpiryEscalation(entry);
        void eventBus.emit('intake.quarantine.expired', {
          envelopeId: entry.id,
          ...(entry.sourceChannelId ? { sourceChannelId: entry.sourceChannelId } : {}),
          heldAtMs: entry.heldAtMs,
          expiredAtMs,
          reason,
        }).catch((error: unknown) => {
          log.error('Failed to emit intake quarantine expiry alert event', {
            envelopeId: entry.id,
            error: String(error),
          });
        });
      },
    },
  );
  const intakeScreening = maybeCreateIntakeScreeningService({
    policy: intakePolicy,
    actor: 'agent:intake-screening',
    onFailClosed: (event) => {
      void eventBus.emit('intake.screening.fail_closed', event).catch((error: unknown) => {
        log.error('Failed to emit fail-closed intake screening alert event', {
          stage: event.stage,
          error: String(error),
        });
      });
    },
    receipts: {
      store: cogSecReceiptStore,
      issuerId: COGSEC_INTAKE_FIREWALL_ISSUER_ID,
      ttlMs: intakeReceiptTtlMs(intakePolicy.receipts),
    },
    quarantine: {
      hold: (input: Parameters<typeof intakeQuarantineWriter.hold>[0]) => {
        const entry = intakeQuarantineWriter.hold(input);
        emitGardenQueueChanged(eventBus, 'intake-quarantine');
        return entry;
      },
    },
  });
  sessionManager.intakeScreening = intakeScreening;
  agentLoop.cogSecMode = intakePolicy.mode;
  if (sessionManager.intakeScreening) {
    log.info('Intake screening wired to session tool observations', {
      mode: sessionManager.intakeScreening.mode,
    });
  }
  return { intakePolicy, intakeScreening };
}
