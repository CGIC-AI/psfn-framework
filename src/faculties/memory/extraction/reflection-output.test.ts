import { describe, expect, it } from 'vitest';
import { resolveSessionEntryReflectionTurnProvenance } from '../../../core/session/reflection-turn-provenance.js';
import type { FinalReflectionExtractionInput } from '../../../core/agent/contracts.js';
import { projectFinalReflectionForExtraction } from './reflection-output.js';

const FINAL_REFLECTION: FinalReflectionExtractionInput = {
  source: 'reflection_journal',
  journalEntryId: 'reflection-1784156400000-123456',
  templateId: 'daily-review',
  templateName: 'Daily Review',
  channelId: 'internal:reflection:daily-review',
  reflection: 'I felt quietly proud after noticing how patiently I held the tension.',
  mode: 'deliberation',
  createdAt: '2026-07-16T03:00:00.000Z',
};

describe('final reflection extraction projection', () => {
  it('projects the canonical journal output as one typed final assistant entry', () => {
    const entry = projectFinalReflectionForExtraction(FINAL_REFLECTION, 'Purrsephone');

    expect(entry).toMatchObject({
      id: Date.parse(FINAL_REFLECTION.createdAt),
      channelId: FINAL_REFLECTION.channelId,
      role: 'assistant',
      authorId: 'companion:self-reflection',
      authorName: 'Purrsephone',
      content: FINAL_REFLECTION.reflection,
    });
    expect(resolveSessionEntryReflectionTurnProvenance(entry)).toEqual({
      schemaVersion: 1,
      stage: 'final_output',
      templateId: FINAL_REFLECTION.templateId,
      mode: FINAL_REFLECTION.mode,
      journalEntryId: FINAL_REFLECTION.journalEntryId,
    });
  });

  it.each([
    { ...FINAL_REFLECTION, journalEntryId: ' ' },
    { ...FINAL_REFLECTION, channelId: 'internal:free-time:idle' },
    { ...FINAL_REFLECTION, reflection: '' },
    { ...FINAL_REFLECTION, createdAt: 'not-a-date' },
  ])('rejects a malformed canonical source instead of creating extraction evidence', (input) => {
    expect(() => projectFinalReflectionForExtraction(input, 'Purrsephone')).toThrow(
      'Final reflection extraction',
    );
  });
});
