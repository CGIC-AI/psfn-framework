import type {
  IntakeDecisionAction,
  IntakeEnvelopeSnapshot,
  IntakeSink,
  IntakeSourceClass,
} from '../../../shared/contracts/intake-envelope.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../intake-firewall-notice-templates.js';
import type { IntakeScreeningService } from './screening.js';
import type { IntakeSinkGate, IntakeSinkGateDecision } from './sink-gates.js';

export interface DerivedContentIntakeDisposition {
  sourceClass: Extract<IntakeSourceClass, 'subagent_output' | 'shard_foldback'>;
  mode: 'shadow' | 'enforce';
  action: IntakeDecisionAction;
  withheld: boolean;
  envelopes: IntakeEnvelopeSnapshot[];
  sink: IntakeSinkGateDecision;
}

export interface ScreenDerivedContentResult {
  effectiveText: string;
  intake?: DerivedContentIntakeDisposition;
}

/**
 * Screen text produced from earlier inputs, retaining every parent snapshot.
 * The new output envelope and all ingested envelopes participate in the same
 * sink decision, so summarization cannot launder a denied source (CaMeL).
 */
export async function screenDerivedContent(input: {
  text: string;
  sourceClass: Extract<IntakeSourceClass, 'subagent_output' | 'shard_foldback'>;
  origin: string;
  sink: IntakeSink;
  ingestedEnvelopes?: readonly IntakeEnvelopeSnapshot[];
  screening?: IntakeScreeningService | null;
  sinkGate?: IntakeSinkGate | null;
  auditContext?: Readonly<Record<string, unknown>>;
}): Promise<ScreenDerivedContentResult> {
  const screening = input.screening ?? null;
  const sinkGate = input.sinkGate ?? null;
  if (!screening && !sinkGate) {
    return { effectiveText: input.text };
  }
  if (!screening || !sinkGate) {
    throw new Error('Derived-content intake requires both screening and sink-gate services');
  }
  if (screening.mode !== sinkGate.mode) {
    throw new Error('Derived-content intake screening and sink-gate modes must match');
  }

  const screened = await screening.screen(input.text, {
    sourceClass: input.sourceClass,
    origin: { ref: input.origin },
    scope: 'context',
  });
  if (screened.mode !== screening.mode) {
    throw new Error('Derived-content screening returned a mismatched firewall mode');
  }
  const envelopes = dedupeSnapshots([
    screened.snapshot,
    ...(input.ingestedEnvelopes ?? []),
  ]);
  const sink = sinkGate.evaluate(input.sink, envelopes, {
    sourceClass: input.sourceClass,
    origin: input.origin,
    ...(input.auditContext ?? {}),
  });
  if (sink.mode !== sinkGate.mode || sink.sink !== input.sink) {
    throw new Error('Derived-content sink gate returned a mismatched decision');
  }
  const withheld = screened.withheld || !sink.allowed;
  return {
    effectiveText: withheld
      ? INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent
      : screened.effectiveText,
    intake: {
      sourceClass: input.sourceClass,
      mode: screened.mode,
      action: screened.action,
      withheld,
      envelopes,
      sink,
    },
  };
}

export function cloneIntakeSnapshots(
  snapshots: readonly IntakeEnvelopeSnapshot[] | undefined,
): IntakeEnvelopeSnapshot[] {
  return (snapshots ?? []).map(snapshot => ({
    ...snapshot,
    riskLabels: [...snapshot.riskLabels],
    subject: snapshot.subject.kind === 'body'
      ? { kind: 'body' }
      : { kind: 'attachment', index: snapshot.subject.index },
  }));
}

function dedupeSnapshots(snapshots: readonly IntakeEnvelopeSnapshot[]): IntakeEnvelopeSnapshot[] {
  const seen = new Map<string, IntakeEnvelopeSnapshot>();
  return cloneIntakeSnapshots(snapshots).filter(snapshot => {
    const existing = seen.get(snapshot.envelopeId);
    if (existing) {
      if (!sameSnapshot(existing, snapshot)) {
        throw new Error(`Conflicting intake snapshots share envelope id '${snapshot.envelopeId}'`);
      }
      return false;
    }
    seen.set(snapshot.envelopeId, snapshot);
    return true;
  });
}

function sameSnapshot(left: IntakeEnvelopeSnapshot, right: IntakeEnvelopeSnapshot): boolean {
  return left.sourceClass === right.sourceClass
    && left.sourceRiskTier === right.sourceRiskTier
    && left.state === right.state
    && left.subject.kind === right.subject.kind
    && (left.subject.kind === 'body'
      || (right.subject.kind === 'attachment' && left.subject.index === right.subject.index))
    && left.riskLabels.length === right.riskLabels.length
    && left.riskLabels.every((label, index) => label === right.riskLabels[index]);
}
