import { describe, it, expect, vi } from 'vitest';
import { VaultAutoPublisher } from './auto-publish.js';
import type { VaultOperations } from './ops.js';

function createMockOps(): VaultOperations & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockResolvedValue({ name: 'test', mode: 'create' }),
    read: vi.fn(),
    search: vi.fn(),
    daily: vi.fn(),
  };
}

describe('VaultAutoPublisher', () => {
  it('publishes a whisper reflection with correct frontmatter', async () => {
    const ops = createMockOps();
    const publisher = new VaultAutoPublisher(ops);

    await publisher.publishReflection({
      templateId: 'whisper',
      templateName: 'Whisper',
      reflection: 'A quiet thought about the day.',
      mode: 'agent',
      createdAt: new Date('2026-03-02T14:30:00Z'),
    });

    expect(ops.write).toHaveBeenCalledOnce();
    const [name, content, opts] = ops.write.mock.calls[0];
    expect(name).toBe('2026-03-02 Whisper');
    expect(opts.folder).toBe('Reflections/whisper/');
    expect(opts.mode).toBe('create');

    // Verify frontmatter
    expect(content).toContain('---');
    expect(content).toContain('template: whisper');
    expect(content).toContain('mode: agent');
    expect(content).toContain('date: 2026-03-02T14:30:00.000Z');
    expect(content).toContain('A quiet thought about the day.');
  });

  it('publishes non-whisper templates with time in name', async () => {
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
    expect(name).toBe('2026-03-02 08h15 Emotional Check');
    expect(opts.folder).toBe('Reflections/emotional/');
    expect(content).toContain('mode: deliberation');
  });

  it('maps template IDs to correct folders', async () => {
    const ops = createMockOps();
    const publisher = new VaultAutoPublisher(ops);
    const date = new Date('2026-01-01T12:00:00Z');

    const cases: Array<[string, string]> = [
      ['whisper', 'Reflections/whisper/'],
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
