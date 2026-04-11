import { describe, expect, it } from 'vitest';
import { abstractMemoryText } from './abstraction.js';

describe('abstractMemoryText', () => {
  it('converts sensitive medication event into generalized lesson', () => {
    const result = abstractMemoryText('V missed meds Tuesday at 9am after a 14-hour shift.');
    expect(result.text).toBe('Partner benefits from medication reminders during high workload periods.');
    expect(result.text).not.toContain('V');
    expect(result.text).not.toContain('Tuesday');
    expect(result.text).not.toContain('9am');
  });

  it('redacts direct identifiers in fallback path', () => {
    const result = abstractMemoryText(
      'Ariana shared account id: ACCT-88219 and email ariana@example.com on 2026-01-04.',
    );
    expect(result.text.toLowerCase()).toContain('benefits from support');
    expect(result.text).not.toContain('Ariana');
    expect(result.text).not.toContain('ACCT-88219');
    expect(result.text).not.toContain('ariana@example.com');
    expect(result.text).not.toContain('2026-01-04');
  });
});
