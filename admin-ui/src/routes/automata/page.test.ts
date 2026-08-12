import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('Automata Garden page', () => {
  it('renders registry, Bus monitor, paging, manual refresh, and truthful states', () => {
    expect(source).toContain('Automata classes');
    expect(source).toContain('Active and recent runs');
    expect(source).toContain('Health and freshness');
    expect(source).toContain('Current findings');
    expect(source).toContain('Events and corrections');
    expect(source).toContain('Apply filters');
    expect(source).toContain("loadData('refresh')");
    expect(source).toContain('Bus reads are unavailable');
    expect(source).toContain('Bus data is stale');
    expect(source).toContain('Bus reads are degraded');
    expect(source).toContain('No retained runs match these filters');
  });

  it('stays read-only and never renders raw references or private prompt fields', () => {
    expect(source).toContain('This surface is read-only.');
    expect(source).toContain('referenceDigest');
    expect(source).not.toContain('taskSummary');
    expect(source).not.toContain('artifactRefs');
    expect(source).not.toContain('evidence.reference}');
    expect(source).not.toMatch(/apiPost|apiPatch|apiDelete|apiPut/);
  });
});
