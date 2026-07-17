import { describe, expect, it } from 'vitest';
import {
  classifyArtifactSensitivity,
  contestArtifactSensitivity,
  parseArtifactSensitivityClassification,
} from './artifact-sensitivity.js';

describe('artifact sensitivity provenance', () => {
  it('inherits the maximum sensitivity and keeps content-free source provenance', () => {
    const classification = classifyArtifactSensitivity([
      { ref: 'memory:public', sensitivity: 'public' },
      { ref: 'memory:intimate', sensitivity: 'intimate' },
      { ref: 'memory:personal', sensitivity: 'personal' },
      { ref: 'memory:intimate', sensitivity: 'confidential' },
    ], new Date('2026-07-16T12:00:00.000Z'));

    expect(classification).toMatchObject({
      schemaVersion: 1,
      sensitivity: 'confidential',
      basis: 'max_input_sensitivity',
      classifiedAt: '2026-07-16T12:00:00.000Z',
      sources: [
        { ref: 'memory:intimate', sensitivity: 'confidential' },
        { ref: 'memory:personal', sensitivity: 'personal' },
        { ref: 'memory:public', sensitivity: 'public' },
      ],
      contests: [],
    });
  });

  it('records a contest without erasing the inherited source evidence', () => {
    const inherited = classifyArtifactSensitivity([
      { ref: 'memory:relationship', sensitivity: 'intimate' },
    ], new Date('2026-07-16T12:00:00.000Z'));
    const contested = contestArtifactSensitivity(inherited, {
      actor: 'subject',
      sensitivity: 'personal',
      reason: 'The subject reviewed the abstraction and approved this boundary.',
      now: new Date('2026-07-16T13:00:00.000Z'),
    });

    expect(parseArtifactSensitivityClassification(contested)).toEqual(contested);
    expect(contested).toMatchObject({
      sensitivity: 'personal',
      basis: 'contested',
      sources: inherited.sources,
      contests: [{
        actor: 'subject',
        previousSensitivity: 'intimate',
        sensitivity: 'personal',
        reason: 'The subject reviewed the abstraction and approved this boundary.',
        contestedAt: '2026-07-16T13:00:00.000Z',
      }],
    });
  });
});
