import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = [
  readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8'),
  readFileSync(new URL('../../lib/components/automata/AutomataLessonsPanel.svelte', import.meta.url), 'utf8'),
].join('\n');

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
    expect(source).toContain('Instruction and tool lessons');
    expect(source).toContain('Lesson projection unavailable');
    expect(source).toContain('low support, contradictions, inference-only evidence, or truncated traces');
    expect(source).toContain('Candidate pattern, not verified defect');
  });

  it('keeps diagnostics content-safe and sends proposals only through governed review', () => {
    expect(source).toContain('It never applies this diff.');
    expect(source).toContain('referenceDigest');
    expect(source).toContain('evidenceIds');
    expect(source).not.toContain('taskSummary');
    expect(source).not.toContain('artifactRefs');
    expect(source).not.toContain('evidence.reference}');
    expect(source).not.toMatch(/apiPatch|apiDelete|apiPut/);
    expect(source).toContain('submitAutomataLessonProposal');
  });
});
