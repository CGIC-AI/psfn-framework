import { describe, expect, it } from 'vitest';
import { REFLECTION_SILENT_TOKEN } from '../../../core/scheduler/reflection-policy.js';
import { buildTemporalWakeTurnPrompt } from './temporal-wakeup-lane.js';

describe('buildTemporalWakeTurnPrompt', () => {
  it('describes the frame available to the model without claiming it was already persisted', () => {
    const prompt = buildTemporalWakeTurnPrompt('It is Monday morning.');

    expect(prompt).toContain('Here is the current temporal frame for this morning wake turn:');
    expect(prompt).toContain('It is Monday morning.');
    expect(prompt).toContain(REFLECTION_SILENT_TOKEN);
    expect(prompt).not.toContain('just placed');
    expect(prompt).not.toContain('active session');
  });
});
