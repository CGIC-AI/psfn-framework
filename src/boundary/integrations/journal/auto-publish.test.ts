import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetActiveTimezone,
  setActiveTimezone,
} from '../../../shared/time/active-timezone.js';
import { JournalAutoPublisher } from './auto-publish.js';
import type { JournalOperations } from './ops.js';

const ORIGINAL_TZ = process.env.TZ;

function createMockOps(): JournalOperations & { write: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn().mockResolvedValue({ path: 'test.md', mode: 'write', created: true }),
    append: vi.fn(),
    search: vi.fn(),
  };
}

describe('JournalAutoPublisher', () => {
  beforeEach(() => {
    setActiveTimezone('America/New_York');
  });

  afterEach(() => {
    resetActiveTimezone();
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it('uses the active calendar day and local timestamp for late-evening reflections', async () => {
    const ops = createMockOps();
    const publisher = new JournalAutoPublisher(ops);

    await publisher.publishReflection({
      templateId: 'daily-review',
      templateName: 'Daily Review',
      reflection: 'The evening still belongs to Monday.',
      mode: 'agent',
      createdAt: new Date('2026-03-03T04:30:00.000Z'),
    });

    expect(ops.write).toHaveBeenCalledWith(
      'reflections/daily/2026-03-02-23h30-daily-review.md',
      expect.stringContaining('date: 2026-03-02T23:30:00.000-05:00'),
    );
  });

  it('keeps the same calendar day for UTC-daytime reflections', async () => {
    const ops = createMockOps();
    const publisher = new JournalAutoPublisher(ops);

    await publisher.publishReflection({
      templateId: 'musing',
      templateName: 'Musing',
      reflection: 'A daytime thought.',
      mode: 'deliberation',
      createdAt: new Date('2026-03-02T14:30:00.000Z'),
    });

    const [path, content] = ops.write.mock.calls[0];
    expect(path).toBe('reflections/musings/2026-03-02-musing.md');
    expect(content).toContain('date: 2026-03-02T09:30:00.000-05:00');
  });
});
