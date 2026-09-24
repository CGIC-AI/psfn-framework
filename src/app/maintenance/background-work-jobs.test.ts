import { describe, expect, it } from 'vitest';
import { parseBackgroundWorkJobsArgs } from './background-work-jobs.js';

describe('background-work jobs CLI args (psfn-framework-gbwpq)', () => {
  it('parses list filters and defaults retire to a dry run', () => {
    expect(parseBackgroundWorkJobsArgs(['list', '--state', 'retry_wait', '--channel-prefix', 'hub-device:']))
      .toMatchObject({ command: 'list', states: ['retry_wait'], channelPrefix: 'hub-device:', apply: false });
    expect(parseBackgroundWorkJobsArgs(['retire', '--job', 'job-1', '--job', 'job-2']))
      .toMatchObject({ command: 'retire', jobIds: ['job-1', 'job-2'], apply: false });
    expect(parseBackgroundWorkJobsArgs(['retire', '--job', 'job-1', '--apply']).apply).toBe(true);
  });

  it('rejects unknown commands, states, and apply on list', () => {
    expect(() => parseBackgroundWorkJobsArgs(['purge'])).toThrow(/list or retire/);
    expect(() => parseBackgroundWorkJobsArgs(['list', '--state', 'zombie'])).toThrow(/--state must be one of/);
    expect(() => parseBackgroundWorkJobsArgs(['list', '--apply'])).toThrow(/only to retire/);
    expect(() => parseBackgroundWorkJobsArgs(['list', '--limit', '0'])).toThrow(/positive integer/);
  });
});
