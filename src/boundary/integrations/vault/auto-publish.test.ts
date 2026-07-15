import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  resetActiveTimezone,
  setActiveTimezone,
} from '../../../shared/time/active-timezone.js';
import { VaultAutoPublisher } from './auto-publish.js';
import type { VaultOperations } from './ops.js';

const ORIGINAL_TZ = process.env.TZ;

function createMockOps(): VaultOperations & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockResolvedValue({ name: 'test', mode: 'create' }),
    read: vi.fn(),
    search: vi.fn(),
    daily: vi.fn(),
  };
}

describe('VaultAutoPublisher', () => {
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

  it('publishes a musing reflection with correct frontmatter', async () => {
    const ops = createMockOps();
    const publisher = new VaultAutoPublisher(ops);

    await publisher.publishReflection({
      templateId: 'musing',
      templateName: 'Musing',
      reflection: 'A quiet thought about the day.',
      mode: 'agent',
      createdAt: new Date('2026-03-02T14:30:00Z'),
    });

    expect(ops.write).toHaveBeenCalledOnce();
    const [name, content, opts] = ops.write.mock.calls[0];
    expect(name).toBe('2026-03-02 Musing');
    expect(opts.folder).toBe('Reflections/musings/');
    expect(opts.mode).toBe('create');

    // Verify frontmatter
    expect(content).toContain('---');
    expect(content).toContain('template: musing');
    expect(content).toContain('mode: agent');
    expect(content).toContain('date: 2026-03-02T09:30:00.000-05:00');
    expect(content).toContain('A quiet thought about the day.');
  });

  it('normalizes legacy whisper template ids to musing when publishing', async () => {
    const ops = createMockOps();
    const publisher = new VaultAutoPublisher(ops);

    await publisher.publishReflection({
      templateId: 'whisper',
      templateName: 'Whisper',
      reflection: 'A quiet thought about the day.',
      mode: 'agent',
      createdAt: new Date('2026-03-02T14:30:00Z'),
    });

    const [name, content, opts] = ops.write.mock.calls[0];
    expect(name).toBe('2026-03-02 Musing');
    expect(opts.folder).toBe('Reflections/musings/');
    expect(content).toContain('template: musing');
  });

  it('publishes non-musing templates with time in name', async () => {
    const ops = createMockOps();
    const publisher = new VaultAutoPublisher(ops);

    await publisher.publishReflection({
      templateId: 'emotional-check',
      templateName: 'Emotional Check',
      reflection: 'Feeling centered.',
      mode: 'deliberation',
      createdAt: new Date('2026-03-02T08:15:00Z'),
    });

    const [name, content, opts] = ops.write.mock.calls[0];
    expect(name).toBe('2026-03-02 03h15 Emotional Check');
    expect(opts.folder).toBe('Reflections/emotional/');
    expect(content).toContain('mode: deliberation');
  });

  it('uses the active calendar day and local timestamp for late-evening reflections', async () => {
    const ops = createMockOps();
    const publisher = new VaultAutoPublisher(ops);

    await publisher.publishReflection({
      templateId: 'daily-review',
      templateName: 'Daily Review',
      reflection: 'The evening still belongs to Monday.',
      mode: 'agent',
      createdAt: new Date('2026-03-03T04:30:00.000Z'),
    });

    const [name, content] = ops.write.mock.calls[0];
    expect(name).toBe('2026-03-02 23h30 Daily Review');
    expect(content).toContain('date: 2026-03-02T23:30:00.000-05:00');
  });

  it('maps template IDs to correct folders', async () => {
    const ops = createMockOps();
    const publisher = new VaultAutoPublisher(ops);
    const date = new Date('2026-01-01T12:00:00Z');

    const cases: Array<[string, string]> = [
      ['musing', 'Reflections/musings/'],
      ['daily-review', 'Reflections/daily/'],
      ['emotional-check', 'Reflections/emotional/'],
      ['goal-update', 'Reflections/goals/'],
      ['values-reflection', 'Reflections/values/'],
      ['unknown-template', 'Reflections/'],
    ];

    for (const [templateId, expectedFolder] of cases) {
      ops.write.mockClear();
      await publisher.publishReflection({
        templateId,
        templateName: 'Test',
        reflection: 'content',
        mode: 'agent',
        createdAt: date,
      });
      const [, , opts] = ops.write.mock.calls[0];
      expect(opts.folder, `Template "${templateId}" should map to ${expectedFolder}`).toBe(expectedFolder);
    }
  });
});
