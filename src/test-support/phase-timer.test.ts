import { describe, expect, it } from 'vitest';
import { PhaseTimer } from './phase-timer.js';

function capturingTimer(emitOnSuccess: boolean) {
  const lines: string[] = [];
  const timer = new PhaseTimer('unit', { emitOnSuccess, sink: line => lines.push(line) });
  return { timer, lines };
}

describe('PhaseTimer', () => {
  it('records spans via measure() and preserves order and total', async () => {
    const { timer } = capturingTimer(true);
    await timer.measure('a', async () => { await Promise.resolve(); });
    await timer.measure('b', async () => { await Promise.resolve(); });
    const entries = timer.entries();
    expect(entries.map(entry => entry.name)).toEqual(['a', 'b']);
    expect(entries.every(entry => entry.durationMs >= 0)).toBe(true);
    expect(timer.totalMs()).toBeCloseTo(entries[0].durationMs + entries[1].durationMs, 5);
  });

  it('records a span even when the measured work throws, and re-throws', async () => {
    const { timer } = capturingTimer(true);
    await expect(timer.measure('boom', async () => {
      throw new Error('kaboom');
    })).rejects.toThrow('kaboom');
    expect(timer.entries().map(entry => entry.name)).toEqual(['boom']);
  });

  it('begin() closes exactly once', () => {
    const { timer } = capturingTimer(true);
    const end = timer.begin('phase');
    end();
    end();
    expect(timer.entries()).toHaveLength(1);
  });

  it('prints on failure regardless of the success flag', () => {
    const { timer, lines } = capturingTimer(false);
    timer.begin('phase')();
    timer.report({ failed: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[phase-timings] unit');
  });

  it('stays silent on success when the flag is off', () => {
    const { timer, lines } = capturingTimer(false);
    timer.begin('phase')();
    timer.report({ failed: false });
    expect(lines).toEqual([]);
  });

  it('prints on success when the flag is on', () => {
    const { timer, lines } = capturingTimer(true);
    timer.begin('phase')();
    timer.report({ failed: false });
    expect(lines).toHaveLength(1);
  });

  it('is a no-op when no spans were recorded', () => {
    const { timer, lines } = capturingTimer(true);
    timer.report({ failed: true });
    expect(lines).toEqual([]);
  });

  it('surfaces a still-open begin() span as an in-progress entry alongside closed spans', () => {
    const { timer, lines } = capturingTimer(true);
    timer.begin('completed')();
    timer.begin('failing'); // never closed — simulates a throw between begin and end
    timer.report({ failed: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('completed');
    expect(lines[0]).toContain('failing');
    expect(lines[0]).toContain('(in progress at report)');
  });

  it('does not mark closed spans as in progress', () => {
    const { timer, lines } = capturingTimer(true);
    timer.begin('done')();
    timer.report({ failed: true });
    expect(lines[0]).toContain('done');
    expect(lines[0]).not.toContain('(in progress at report)');
  });

  it('reports even when only an open span exists (first phase threw before recording)', () => {
    const { timer, lines } = capturingTimer(true);
    timer.begin('first'); // never closed and nothing else recorded
    timer.report({ failed: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('first');
    expect(lines[0]).toContain('(in progress at report)');
  });
});
