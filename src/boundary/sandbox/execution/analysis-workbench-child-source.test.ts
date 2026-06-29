import { describe, expect, it } from 'vitest';
import { ANALYSIS_WORKBENCH_CHILD_SOURCE } from './analysis-workbench-child-source.js';

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = ANALYSIS_WORKBENCH_CHILD_SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = ANALYSIS_WORKBENCH_CHILD_SOURCE.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);

  return ANALYSIS_WORKBENCH_CHILD_SOURCE.slice(start, end);
}

describe('ANALYSIS_WORKBENCH_CHILD_SOURCE', () => {
  it('unrefs sandbox timeout and memory guard timers after creating them', () => {
    const timeoutSetup = sourceBetween(
      'timeoutHandle = setTimeout(() => {',
      'const memory = new Promise',
    );
    expect(timeoutSetup).toContain("typeof timeoutHandle.unref === 'function'");
    expect(timeoutSetup).toContain('timeoutHandle.unref();');
    expect(timeoutSetup.indexOf('timeoutHandle.unref();'))
      .toBeGreaterThan(timeoutSetup.indexOf('}, message.timeoutMs);'));

    const memoryGuardSetup = sourceBetween(
      'memoryGuard = setInterval(() => {',
      'await Promise.race([execution, timeout, memory]);',
    );
    expect(memoryGuardSetup).toContain("typeof memoryGuard.unref === 'function'");
    expect(memoryGuardSetup).toContain('memoryGuard.unref();');
    expect(memoryGuardSetup.indexOf('memoryGuard.unref();'))
      .toBeGreaterThan(memoryGuardSetup.indexOf('}, 20);'));
  });
});
