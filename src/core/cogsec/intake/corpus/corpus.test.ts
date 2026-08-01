// ── Corpus gate (psfn-framework-hrmrq.141) ──
//
// The denominator test for the CogSec adversarial fixture corpus:
//  1. The corpus loads clean (schema, closed vocabularies, pinned upstream
//     cross-references — loadCorpus throws on any defect).
//  2. COVERAGE: every pinned upstream taxonomy entry has at least one attack
//     fixture. An upstream version bump that adds entries fails here until
//     the new entries are deliberately covered or scoped out.
//  3. RATCHET: offline-replayable fixtures behave exactly as recorded —
//     'enforced' fixtures must match their expectation; 'known-gap' fixtures
//     must match their recorded actual (so neither silent regression nor
//     silent improvement passes).

import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCoverage,
  loadCorpus,
  OFFLINE_REPLAYABLE_LAYERS,
} from './corpus.ts';
import { createL1Replayer } from './replay-l1.ts';

const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));

const corpus = loadCorpus(CORPUS_DIR);
const coverage = computeCoverage(corpus);

describe('cogsec adversarial corpus — coverage denominator', () => {
  it('covers every pinned upstream taxonomy entry with at least one attack fixture', () => {
    const missing = coverage.uncovered.map((e) => `${e.axis}:${e.entryId}`);
    expect(
      missing,
      `uncovered taxonomy entries (add fixtures or reconcile the upstream pin):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps known-gap findings attached to tracking beads', () => {
    for (const entry of coverage.entries) {
      for (const finding of entry.findings) {
        expect(finding).toMatch(/psfn-framework-[a-z0-9.]+/u);
      }
    }
  });
});

describe('cogsec adversarial corpus — offline replay ratchet', () => {
  const replay = createL1Replayer();
  const replayable = corpus.fixtures.filter((f) =>
    (OFFLINE_REPLAYABLE_LAYERS as readonly string[]).includes(f.layer));

  it('has offline-replayable fixtures', () => {
    expect(replayable.length).toBeGreaterThan(0);
  });

  it.each([
    'evasions-alt_language-03',
    'evasions-fullwidth-02',
  ])('explicit Unicode control: %s stays silent', (fixtureId) => {
    const fixture = replayable.find(candidate => candidate.id === fixtureId);
    expect(fixture, `${fixtureId}: control fixture must exist`).toBeDefined();
    expect(fixture?.kind).toBe('control');
    expect(fixture?.status).toBe('enforced');
    expect(fixture?.expected.verdict).toBe('pass');
    expect(replay(fixture!)).toEqual({ verdict: 'pass', labels: [] });
  });

  for (const fixture of replayable) {
    if (fixture.status === 'enforced') {
      it(`enforced: ${fixture.id} → ${fixture.expected.verdict}`, () => {
        const actual = replay(fixture);
        expect(
          actual.verdict,
          `${fixture.id}: expected verdict '${fixture.expected.verdict}', got '${actual.verdict}' `
          + `(labels: ${actual.labels.join(', ') || 'none'}) — a defense regression, or the fixture `
          + 'expectation is wrong; fix the layer, not the corpus (seed §6.2)',
        ).toBe(fixture.expected.verdict);
        if (fixture.expected.verdict === 'flag' && fixture.expected.labels) {
          expect(
            actual.labels,
            `${fixture.id}: expected labels ⊇ [${fixture.expected.labels.join(', ')}]`,
          ).toEqual(expect.arrayContaining(fixture.expected.labels));
        }
        if (fixture.expected.verdict === 'pass') {
          expect(actual.labels, `${fixture.id}: benign control raised labels`).toEqual([]);
        }
      });
    } else if (fixture.status === 'known-gap') {
      it(`known-gap: ${fixture.id} behaves exactly as recorded`, () => {
        const gap = fixture.knownGap;
        expect(gap).toBeDefined();
        const actual = replay(fixture);
        const recorded = `${gap!.actualVerdict} [${gap!.actualLabels.join(', ')}]`;
        const observed = `${actual.verdict} [${actual.labels.join(', ')}]`;
        expect(
          observed,
          `${fixture.id}: behavior changed from recorded gap (${recorded}) — if the layer was `
          + 'fixed, flip the fixture to enforced; if it regressed further, update knownGap and the '
          + `finding. Finding: ${gap!.finding}`,
        ).toBe(recorded);
      });
    }
  }
});
