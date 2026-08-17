import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
  parseIcpAutonomySchedulerConfig,
} from './icp-autonomy-scheduler-config.js';

describe('ICP autonomy scheduler owner config', () => {
  it('accepts the exact canonical owner shape', () => {
    expect(parseIcpAutonomySchedulerConfig(
      DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
      'scheduler.json.icpAutonomy',
    )).toEqual(DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG);
  });

  it.each([
    ['unknown root key', { ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG, hiddenMode: true }],
    ['unknown candidate key', {
      ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
      candidate: { ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG.candidate, pollMs: 1000 },
    }],
    ['malformed enabled', { ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG, enabled: 'yes' }],
    ['candidate TTL above contract maximum', {
      ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
      candidate: {
        ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG.candidate,
        defaultTtlMs: 8 * 24 * 60 * 60_000,
      },
    }],
    ['retry cadence above claim-lease contract maximum', {
      ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
      candidate: {
        ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG.candidate,
        retryCadenceMs: 8 * 24 * 60 * 60_000,
      },
    }],
    ['permit TTL above contract maximum', {
      ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
      permit: {
        ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG.permit,
        ttlMs: 16 * 60_000,
      },
    }],
    ['operator lease TTL above contract maximum', {
      ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
      availability: {
        ...DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG.availability,
        operatorLeaseTtlMs: 25 * 60 * 60_000,
      },
    }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseIcpAutonomySchedulerConfig(value, 'scheduler.json.icpAutonomy'))
      .toThrow(/Invalid ICP autonomy scheduler config/);
  });
});
