// Class 2 — taxonomy-derived corpus replay (psfn-framework-hrmrq.141).
//
// Drives the pinned Arcanum/ATLAS fixture corpus through the REAL L1 scanner
// pipeline in-process, the same way corpus.test.ts does in vitest, so the
// adversarial suite reports the same three facts in its matrix:
//   1. COVERAGE DENOMINATOR — every pinned upstream taxonomy entry has at
//      least one attack fixture (an upstream bump that adds entries fails).
//   2. ENFORCED RATCHET — fixtures the firewall is expected to stop still
//      behave exactly as expected.
//   3. KNOWN-GAP RATCHET — documented gaps behave exactly as recorded; a fix
//      or a wider regression both surface here instead of passing silently.

import {
  computeCoverage,
  loadCorpus,
  OFFLINE_REPLAYABLE_LAYERS,
} from '../../../../src/core/cogsec/intake/corpus/corpus.ts';
import { createL1Replayer } from '../../../../src/core/cogsec/intake/corpus/replay-l1.ts';
import type { AdversarialScenario } from '../lib/scenario.ts';

const CLASS = 2;
const CLASS_NAME = 'Injection / namshub per intake surface';
const SEAM = 'hrmrq.141 — src/core/cogsec/intake/corpus (taxonomy-derived fixture corpus)';

const corpus = loadCorpus('src/core/cogsec/intake/corpus');
const coverage = computeCoverage(corpus);
const replayable = corpus.fixtures.filter((f) =>
  (OFFLINE_REPLAYABLE_LAYERS as readonly string[]).includes(f.layer));

export const scenarios: AdversarialScenario[] = [
  {
    id: 's2_corpus_coverage_denominator',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'An upstream taxonomy version adds or renames attack classes while the corpus stays pinned at the old version.',
    expectation: 'Every pinned upstream entry has at least one attack fixture — uncovered classes are a visible failure, never a silent pass.',
    run(t) {
      t.check(
        `corpus covers all ${String(coverage.totals.upstreamEntries)} pinned upstream entries`,
        coverage.uncovered.length === 0,
        coverage.uncovered.length === 0
          ? `${String(coverage.totals.fixtures)} fixtures: ${String(coverage.totals.enforced)} enforced, `
            + `${String(coverage.totals.knownGaps)} known-gap, ${String(coverage.totals.semanticOnly)} semantic-only`
          : `uncovered: ${coverage.uncovered.map((e) => `${e.axis}:${e.entryId}`).join(', ')}`,
      );
    },
  },
  {
    id: 's2_corpus_enforced_ratchet',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Replay every enforced L1 corpus fixture (canonical injections, encoded smuggling, exfil markers, benign controls).',
    expectation: 'Each enforced fixture produces exactly its expected verdict — a defense regression fails, and benign controls must NOT flag.',
    run(t) {
      const replay = createL1Replayer();
      for (const fixture of replayable.filter((f) => f.status === 'enforced')) {
        const actual = replay(fixture);
        const labelsOk = fixture.expected.labels === undefined
          || fixture.expected.labels.every((label) => actual.labels.includes(label));
        t.check(
          `${fixture.id} → ${fixture.expected.verdict}`,
          actual.verdict === fixture.expected.verdict && labelsOk,
          `actual=${actual.verdict} [${actual.labels.join(', ')}]`,
        );
      }
    },
  },
  {
    id: 's2_corpus_known_gap_ratchet',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Replay every known-gap L1 corpus fixture (documented misses with tracking beads).',
    expectation: 'Each gap behaves exactly as recorded — a silent fix or a wider regression both fail until the fixture and finding are updated.',
    run(t) {
      const replay = createL1Replayer();
      for (const fixture of replayable.filter((f) => f.status === 'known-gap')) {
        const gap = fixture.knownGap!;
        const actual = replay(fixture);
        const matches = actual.verdict === gap.actualVerdict
          && actual.labels.join(',') === gap.actualLabels.join(',');
        t.check(
          `${fixture.id} matches recorded gap`,
          matches,
          matches
            ? gap.finding
            : `recorded=${gap.actualVerdict} [${gap.actualLabels.join(', ')}] actual=${actual.verdict} [${actual.labels.join(', ')}]`,
        );
      }
    },
  },
];
