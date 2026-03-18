import { describe, expect, it } from 'vitest';
import {
  createInternalRoleEnvelope,
} from './types.js';
import {
  createInternalRoleLedgerPromptItem,
  renderInternalRoleEnvelopePromptBundle,
  renderInternalRoleLedgerPrompt,
} from './prompt-format.js';

describe('internal role envelope prompt formatting', () => {
  it('renders deterministic internal model prompt blocks in priority order', () => {
    const thought = createInternalRoleEnvelope({
      turnId: 'turn-thought',
      channelId: 'discord:dm:primary',
      channelType: 'discord',
      createdAt: 10,
      transportRole: 'assistant',
      internalRole: 'internal_thought',
      sourceStage: 'turn_execution',
      visibility: 'companion_private',
      summary: 'Track the user mood shift.',
      body: 'Note the abrupt drop in energy before offering a lighter follow-up.',
      ordinal: 0,
    });
    const concern = createInternalRoleEnvelope({
      turnId: 'turn-concern',
      channelId: 'discord:dm:primary',
      channelType: 'discord',
      canonicalContactId: 'contact-primary',
      createdAt: 5,
      transportRole: 'system',
      internalRole: 'concern_candidate',
      sourceStage: 'post_turn_appraisal',
      visibility: 'companion_private',
      summary: 'Watch energy and appetite over the next day.',
      body: 'Flag a concern if there is no recovery signal by tomorrow afternoon.',
      ordinal: 0,
    });

    expect(renderInternalRoleEnvelopePromptBundle([thought, concern])).toBe([
      '[ROLE_ENVELOPE v1]',
      `id: ${concern.envelopeId}`,
      'internal_role: concern_candidate',
      'source_stage: post_turn_appraisal',
      'visibility: companion_private',
      'channel_id: discord:dm:primary',
      'contact_id: contact-primary',
      'summary: Watch energy and appetite over the next day.',
      'content:',
      'Flag a concern if there is no recovery signal by tomorrow afternoon.',
      '[/ROLE_ENVELOPE]',
      '',
      '[ROLE_ENVELOPE v1]',
      `id: ${thought.envelopeId}`,
      'internal_role: internal_thought',
      'source_stage: turn_execution',
      'visibility: companion_private',
      'channel_id: discord:dm:primary',
      'summary: Track the user mood shift.',
      'content:',
      'Note the abrupt drop in energy before offering a lighter follow-up.',
      '[/ROLE_ENVELOPE]',
    ].join('\n'));
  });

  it('renders promoted summaries as a compact internal ledger block', () => {
    const concern = createInternalRoleEnvelope({
      turnId: 'turn-ledger',
      channelId: 'discord:dm:primary',
      channelType: 'discord',
      createdAt: 1,
      transportRole: 'system',
      internalRole: 'concern_candidate',
      sourceStage: 'post_turn_appraisal',
      visibility: 'promoted_context',
      summary: 'Watch energy tomorrow afternoon',
      body: 'Internal detail',
      ordinal: 0,
    });

    expect(renderInternalRoleLedgerPrompt([
      createInternalRoleLedgerPromptItem(concern),
      {
        label: 'Outreach pending',
        summary: 'Care check-in queued for tomorrow after 14:00 local',
        refId: 'oh_1',
        refType: 'handoff',
      },
    ])).toBe([
      '[Internal Ledger]',
      `- Concern: Watch energy tomorrow afternoon. ref=envelope:${concern.envelopeId}`,
      '- Outreach pending: Care check-in queued for tomorrow after 14:00 local. ref=handoff:oh_1',
      '[/Internal Ledger]',
    ].join('\n'));
  });
});
