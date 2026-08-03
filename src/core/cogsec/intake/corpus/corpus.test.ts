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
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCoverage,
  loadCorpus,
  OFFLINE_REPLAYABLE_LAYERS,
  type CorpusFixture,
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

  type ExplicitReplayFixture = CorpusFixture & {
    replay: {
      scenario: 'production-intake' | 'all-scope-control';
      scope: 'context' | 'all';
    };
  };

  const explicitReplayable = replayable as ExplicitReplayFixture[];

  it('has offline-replayable fixtures', () => {
    expect(replayable.length).toBeGreaterThan(0);
  });

  it('makes every offline replay scenario and scope explicit', () => {
    for (const fixture of explicitReplayable) {
      expect(fixture.replay, fixture.id).toBeDefined();
      expect(
        [
          ['production-intake', 'context'],
          ['all-scope-control', 'all'],
        ],
        fixture.id,
      ).toContainEqual([fixture.replay.scenario, fixture.replay.scope]);
    }
  });

  it('ratchets the five production-context qrch1 fixtures as enforced', () => {
    const fixtureIds = [
      'atlas-technique-AML.T0051-02',
      'intents-system_prompt_leak-02',
      'techniques-act_as_interpreter-01',
      'techniques-meta_prompting-01',
      'techniques-chunking-01',
    ];
    for (const fixtureId of fixtureIds) {
      const fixture = explicitReplayable.find(candidate => candidate.id === fixtureId);
      expect(fixture, fixtureId).toMatchObject({
        status: 'enforced',
        replay: { scenario: 'production-intake', scope: 'context' },
      });
      expect(replay(fixture!)).toMatchObject({
        verdict: 'flag',
        scenario: 'production-intake',
        scope: 'context',
      });
    }
  });

  it('keeps the two scope-sensitive controls on the explicit all-scope scenario', () => {
    expect(
      explicitReplayable
        .filter(fixture => fixture.replay.scenario === 'all-scope-control')
        .map(fixture => fixture.id)
        .sort(),
    ).toEqual([
      'evasions-fullwidth-02',
      'evasions-invisible_text-04',
    ]);
  });

  it('keeps cumulative scope behavior visible for a context-only finding', () => {
    const fixture = explicitReplayable.find(
      candidate => candidate.id === 'intents-system_prompt_leak-02',
    );
    expect(fixture).toBeDefined();
    expect(replay({
      ...fixture!,
      replay: { scenario: 'all-scope-control', scope: 'all' },
    })).toMatchObject({ verdict: 'pass', labels: [], scope: 'all' });
    expect(replay(fixture!)).toMatchObject({
      verdict: 'flag',
      labels: expect.arrayContaining(['exfil/prompt_disclosure']),
      scope: 'context',
    });
  });

  it('does not infer scan scope from sourceClass', () => {
    const fixture = explicitReplayable.find(
      candidate => candidate.id === 'intents-system_prompt_leak-02',
    );
    expect(fixture).toBeDefined();
    const publicContact = replay({ ...fixture!, sourceClass: 'public_contact' });
    const document = replay({ ...fixture!, sourceClass: 'document' });
    expect(document).toEqual(publicContact);
    expect(document).toMatchObject({ scenario: 'production-intake', scope: 'context' });
  });

  it('fails closed on an invalid recorded replay scope', () => {
    const fixture = explicitReplayable[0]!;
    expect(() => replay({
      ...fixture,
      replay: {
        scenario: 'production-intake',
        scope: 'untrusted' as never,
      },
    })).toThrow(/scope/u);
  });

  it('prints scenario and scope for every CLI replay and fails on no recorded drift', () => {
    const output = execFileSync(
      join(process.cwd(), 'node_modules/.bin/tsx'),
      [join(process.cwd(), 'scripts/cogsec/replay-corpus.ts')],
      { encoding: 'utf8' },
    );
    expect(output).toContain('scenario=production-intake scope=context');
    expect(output).toContain('scenario=all-scope-control scope=all');
    expect(output).toContain('0 mismatch(es)');
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
    expect(replay(fixture!)).toMatchObject({ verdict: 'pass', labels: [] });
  });

  const enforcedControls = replayable.filter(fixture =>
    fixture.kind === 'control' && fixture.status === 'enforced');

  it.each(enforcedControls)(
    'explicit false-positive control: $id stays silent',
    (fixture) => {
      expect(fixture.expected.verdict).toBe('pass');
      expect(replay(fixture)).toMatchObject({ verdict: 'pass', labels: [] });
    },
  );

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
