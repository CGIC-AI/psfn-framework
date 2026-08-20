import { describe, expect, it } from 'vitest';
import type { AdminSessionMessagesData, SessionEntry } from '$lib/types';
import { buildIcpTranscriptPresentation } from './icp-transcript';

type Ontology = AdminSessionMessagesData['messageOntologyViews'][number];

const correlation = {
  conversationId: '44444444-4444-4444-8444-444444444444',
  rootInitiationId: '99999999-9999-4999-8999-999999999999',
  turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
};

function message(id: number, role: SessionEntry['role'], content: string): SessionEntry {
  return {
    id,
    channelId: 'companion-dm:a:b',
    role,
    content,
    timestamp: 1_780_000_000_000 + id,
    metadata: JSON.stringify({
      icpCorrelation: correlation,
      icpDelivery: { schemaVersion: 1, status: 'pending' },
    }),
  };
}

function ontology(id: number, promptVisibility: Ontology['promptVisibility']): Ontology {
  return {
    sessionEntryId: id,
    transportRole: id === 1 ? 'system' : 'user',
    promptRole: id === 1 ? 'custom' : 'user',
    semanticType: id === 1 ? 'systemNote' : 'outwardSpeech',
    messageClass: id === 1 ? null : 'outwardSpeech',
    promptVisibility,
    displayLabel: id === 1 ? 'System note' : 'Participant message',
  };
}

describe('ICP transcript presentation', () => {
  it('keeps logical speech visible and collapses correlated operator-only transport nodes', () => {
    const transport = message(1, 'system', '{"large":"transport envelope"}');
    const speech = message(2, 'user', 'Can we keep talking?');

    const presented = buildIcpTranscriptPresentation(
      [transport, speech],
      [ontology(1, 'operator_only'), ontology(2, 'prompt_visible')],
    );

    expect(presented.conversationMessages).toEqual([speech]);
    expect(presented.transportEvidence).toEqual([expect.objectContaining({
      rootInitiationId: correlation.rootInitiationId,
      conversationId: correlation.conversationId,
      entryCount: 1,
      turnCount: 1,
      deliveryStatuses: ['pending'],
      entries: [transport],
    })]);
  });

  it('does not hide uncorrelated, malformed, or prompt-visible entries', () => {
    const uncorrelated = { ...message(1, 'system', 'ordinary note'), metadata: undefined };
    const malformed = { ...message(2, 'system', 'broken evidence'), metadata: '{' };
    const visibleIcp = message(3, 'user', 'ordinary correlated speech');

    const presented = buildIcpTranscriptPresentation(
      [uncorrelated, malformed, visibleIcp],
      [
        ontology(1, 'operator_only'),
        ontology(2, 'operator_only'),
        ontology(3, 'prompt_visible'),
      ],
    );

    expect(presented.conversationMessages).toEqual([uncorrelated, malformed, visibleIcp]);
    expect(presented.transportEvidence).toEqual([]);
  });
});
