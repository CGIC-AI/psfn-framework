import type {
  InternalRoleEnvelope,
  InternalRoleEnvelopeKind,
} from './types.js';

export interface InternalRoleLedgerPromptItem {
  label?: string;
  summary: string;
  refId: string;
  refType?: 'envelope' | 'handoff';
}

const INTERNAL_ROLE_PROMPT_PRIORITY: Readonly<Record<InternalRoleEnvelopeKind, number>> = Object.freeze({
  concern_candidate: 0,
  outreach_candidate: 1,
  self_reflection: 2,
  values_reflection: 3,
  internal_thought: 4,
  outreach_handoff: 5,
  outreach_result: 6,
});

const INTERNAL_ROLE_PROMPT_LABELS: Readonly<Record<InternalRoleEnvelopeKind, string>> = Object.freeze({
  concern_candidate: 'Concern',
  outreach_candidate: 'Outreach pending',
  self_reflection: 'Self reflection',
  values_reflection: 'Values reflection',
  internal_thought: 'Thought',
  outreach_handoff: 'Outreach handoff',
  outreach_result: 'Outreach result',
});

function normalizePromptLine(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Internal role prompt ${field} must be non-empty`);
  }
  return normalized;
}

export function compareInternalRoleEnvelopePromptOrder(
  left: InternalRoleEnvelope,
  right: InternalRoleEnvelope,
): number {
  const priorityDelta = INTERNAL_ROLE_PROMPT_PRIORITY[left.internalRole]
    - INTERNAL_ROLE_PROMPT_PRIORITY[right.internalRole];
  if (priorityDelta !== 0) return priorityDelta;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.envelopeId.localeCompare(right.envelopeId);
}

export function renderInternalRoleEnvelopePrompt(envelope: InternalRoleEnvelope): string {
  const lines = [
    '[ROLE_ENVELOPE v1]',
    `id: ${envelope.envelopeId}`,
    `internal_role: ${envelope.internalRole}`,
    `source_stage: ${envelope.sourceStage}`,
    `visibility: ${envelope.visibility}`,
    `channel_id: ${envelope.channelId}`,
  ];
  if (envelope.canonicalContactId) {
    lines.push(`contact_id: ${envelope.canonicalContactId}`);
  }
  lines.push(`summary: ${normalizePromptLine(envelope.summary, 'summary')}`);
  lines.push('content:');
  lines.push(envelope.body);
  lines.push('[/ROLE_ENVELOPE]');
  return lines.join('\n');
}

export function renderInternalRoleEnvelopePromptBundle(
  envelopes: readonly InternalRoleEnvelope[],
): string {
  return [...envelopes]
    .sort(compareInternalRoleEnvelopePromptOrder)
    .map(renderInternalRoleEnvelopePrompt)
    .join('\n\n');
}

export function renderInternalRoleLedgerPrompt(
  items: readonly InternalRoleLedgerPromptItem[],
): string {
  if (items.length === 0) return '';
  const lines = ['[Internal Ledger]'];
  for (const item of items) {
    const label = normalizePromptLine(
      item.label ?? INTERNAL_ROLE_PROMPT_LABELS.concern_candidate,
      'label',
    );
    const summary = normalizePromptLine(item.summary, 'summary');
    const refId = normalizePromptLine(item.refId, 'refId');
    const refType = item.refType ?? 'envelope';
    lines.push(`- ${label}: ${summary}. ref=${refType}:${refId}`);
  }
  lines.push('[/Internal Ledger]');
  return lines.join('\n');
}

export function createInternalRoleLedgerPromptItem(
  envelope: InternalRoleEnvelope,
): InternalRoleLedgerPromptItem {
  return {
    label: INTERNAL_ROLE_PROMPT_LABELS[envelope.internalRole],
    summary: envelope.summary,
    refId: envelope.envelopeId,
    refType: 'envelope',
  };
}
