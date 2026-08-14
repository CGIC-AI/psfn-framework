import { describe, expect, it } from 'vitest';
import {
  deriveConcernDueAtHint,
  isExplicitTemporalConcernRequest,
} from './concern-temporal-hints.js';

describe('concern temporal hints', () => {
  it('uses the current weekday when its requested clock time is still ahead', () => {
    expect(deriveConcernDueAtHint(
      'Tuesday at 9 AM, remind me to call the clinic.',
      '2026-08-18T12:00:00.000Z',
      'America/New_York',
    )).toBe('2026-08-18T13:00:00.000Z');
  });

  it('uses the next matching weekday when its requested clock time has passed', () => {
    expect(deriveConcernDueAtHint(
      'Tuesday at 9 AM, remind me to call the clinic.',
      '2026-08-18T14:00:00.000Z',
      'America/New_York',
    )).toBe('2026-08-25T13:00:00.000Z');
  });

  it('rejects an explicitly past same-day clock instead of silently moving it', () => {
    expect(deriveConcernDueAtHint(
      'Today at 9 AM, remind me to call the clinic.',
      '2026-08-18T14:00:00.000Z',
      'America/New_York',
    )).toBeUndefined();
  });

  it('requires both a temporal reference and a request-like directive', () => {
    expect(isExplicitTemporalConcernRequest('At five today, tell me to submit the report.')).toBe(true);
    expect(isExplicitTemporalConcernRequest('We talked about knitting at five today.')).toBe(false);
    expect(isExplicitTemporalConcernRequest('Tell me whether you like this idea.')).toBe(false);
    expect(isExplicitTemporalConcernRequest("Don't remind me at five today.")).toBe(false);
  });

  it.each([
    'On 2026-02-30 at 14:30, remind me to review the release notes.',
    'On 2026-08-20 at 25:30, remind me to review the release notes.',
    "Don't remind me at five today.",
  ])('fails closed instead of manufacturing a due time for: %s', (content) => {
    expect(deriveConcernDueAtHint(
      content,
      '2026-08-14T15:00:00.000Z',
      'America/New_York',
    )).toBeUndefined();
  });
});
