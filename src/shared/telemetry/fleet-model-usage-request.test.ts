import { describe, expect, it } from 'vitest';
import {
  parseFleetModelUsageResourceQuery,
  resolveFleetModelUsageInternalRequestTarget,
} from './fleet-model-usage-request.js';

describe('fleet model-usage request bounds', () => {
  it('rejects explicit and implicit all-time resource queries', () => {
    expect(() => parseFleetModelUsageResourceQuery({ range: ['all'] }))
      .toThrow('does not support all-time');
    expect(() => parseFleetModelUsageResourceQuery({}))
      .toThrow('does not support all-time');
  });

  it('rejects all-time target resolution before it can collapse to one millisecond', () => {
    expect(() => resolveFleetModelUsageInternalRequestTarget(
      { range: 'all', timezone: 'UTC' },
      1_000,
    )).toThrow('does not support all-time');
    expect(() => resolveFleetModelUsageInternalRequestTarget({}, 1_000))
      .toThrow('does not support all-time');
  });
});
