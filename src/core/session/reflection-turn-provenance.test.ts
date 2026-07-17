import { describe, expect, it } from 'vitest';
import {
  buildSessionMetadataWithReflectionTurn,
  resolveSessionEntryReflectionTurnProvenance,
} from './reflection-turn-provenance.js';

describe('reflection turn session provenance', () => {
  it('round-trips a final output while preserving existing session metadata', () => {
    const metadata = buildSessionMetadataWithReflectionTurn(
      JSON.stringify({ turn: { schemaVersion: 1, requestId: 'request-1' } }),
      {
        schemaVersion: 1,
        stage: 'final_output',
        templateId: ' daily-review ',
        mode: 'deliberation',
        journalEntryId: ' reflection-1 ',
      },
    );

    expect(resolveSessionEntryReflectionTurnProvenance({ metadata })).toEqual({
      schemaVersion: 1,
      stage: 'final_output',
      templateId: 'daily-review',
      mode: 'deliberation',
      journalEntryId: 'reflection-1',
    });
    expect(JSON.parse(metadata)).toMatchObject({
      turn: { schemaVersion: 1, requestId: 'request-1' },
    });
  });

  it('treats an unmarked entry as ineligible rather than guessing its stage', () => {
    expect(resolveSessionEntryReflectionTurnProvenance({ metadata: undefined })).toBeNull();
    expect(resolveSessionEntryReflectionTurnProvenance({ metadata: '{}' })).toBeNull();
  });

  it.each([
    { schemaVersion: 2, stage: 'final_output', templateId: 'daily-review', mode: 'agent' },
    { schemaVersion: 1, stage: 'analysis', templateId: 'daily-review', mode: 'agent' },
    { schemaVersion: 1, stage: 'final_output', templateId: '', mode: 'agent' },
    { schemaVersion: 1, stage: 'final_output', templateId: 'daily-review', mode: 'agent', journalEntryId: '' },
    { schemaVersion: 1, stage: 'tool_grounding', templateId: 'daily-review', mode: 'deliberation', journalEntryId: 'reflection-1' },
    { schemaVersion: 1, stage: 'final_output', templateId: 'daily-review', mode: 'worker' },
    {
      schemaVersion: 1,
      stage: 'final_output',
      templateId: 'daily-review',
      mode: 'agent',
      untrustedOverride: true,
    },
  ])('rejects malformed or expanded provenance instead of coercing it', (reflectionTurn) => {
    expect(() => resolveSessionEntryReflectionTurnProvenance({
      metadata: JSON.stringify({ reflectionTurn }),
    })).toThrow('reflectionTurn');
  });
});
