import { describe, expect, it } from 'vitest';
import { buildFleetModelUsagePath } from './fleet-model-usage.js';

describe('fleet model-usage endpoint', () => {
  it('serializes only the fleet aggregate range fields', () => {
    expect(buildFleetModelUsagePath({
      range: 'custom',
      timezone: 'UTC',
      sinceMs: 10,
      untilMs: 20,
      bucket: 'hour',
    })).toBe(
      '/api/admin/fleet-model-usage?range=custom&timezone=UTC&sinceMs=10&untilMs=20&bucket=hour',
    );
  });
});
