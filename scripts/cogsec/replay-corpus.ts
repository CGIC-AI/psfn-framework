// ── Corpus replay CLI (hrmrq.141) ──
//
// Authoring aid for corpus fixtures: replays every L1-layer fixture in a
// JSONL file (or the whole corpus) through the REAL L1 scanner and prints
// the actual verdict + labels per fixture id. Fixture authors use this to
// classify each fixture as 'enforced' (actual == expected) or 'known-gap'
// (record the actual verbatim) — never to relax an expectation.
//
// Usage:
//   node_modules/.bin/tsx scripts/cogsec/replay-corpus.ts [fixtures-file.jsonl]

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  loadCorpus,
  OFFLINE_REPLAYABLE_LAYERS,
  type CorpusFixture,
} from '../../src/core/cogsec/intake/corpus/corpus.ts';
import { createL1Replayer } from '../../src/core/cogsec/intake/corpus/replay-l1.ts';

const CORPUS_DIR = join(process.cwd(), 'src/core/cogsec/intake/corpus');

function loadFixtures(path: string): CorpusFixture[] {
  const corpus = loadCorpus(CORPUS_DIR);
  if (!path) return corpus.fixtures;
  // Validate the file's fixtures against the same pinned upstream by parsing
  // them alongside the corpus: replace the fixtures dir content in-memory is
  // overkill — instead match ids against the loaded corpus for cross-checks.
  const byId = new Map(corpus.fixtures.map((f) => [f.id, f]));
  const fixtures: CorpusFixture[] = [];
  for (const [index, line] of readFileSync(path, 'utf-8').split('\n').entries()) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${String(index + 1)}: invalid JSON line`);
    }
    const id = (raw as { id?: string }).id;
    const known = id === undefined ? undefined : byId.get(id);
    if (known) {
      fixtures.push(known);
    } else {
      // Not yet part of the corpus (new file): replay without upstream
      // cross-validation — the corpus gate validates on merge.
      fixtures.push(raw as CorpusFixture);
    }
  }
  return fixtures;
}

const target = process.argv[2] ?? '';
const replay = createL1Replayer();
let mismatches = 0;
for (const fixture of loadFixtures(target)) {
  if (!(OFFLINE_REPLAYABLE_LAYERS as readonly string[]).includes(fixture.layer)) {
    console.log(`SKIP  ${fixture.id} (layer ${fixture.layer} — no offline oracle)`);
    continue;
  }
  const actual = replay(fixture);
  const expected = fixture.status === 'known-gap'
    ? `${fixture.knownGap!.actualVerdict} [${fixture.knownGap!.actualLabels.join(', ')}]`
    : `${fixture.expected.verdict}${fixture.expected.labels ? ` ⊇[${fixture.expected.labels.join(', ')}]` : ''}`;
  const observed = `${actual.verdict} [${actual.labels.join(', ')}]`;
  const ok = fixture.status === 'known-gap'
    ? actual.verdict === fixture.knownGap!.actualVerdict
      && actual.labels.join(',') === fixture.knownGap!.actualLabels.join(',')
    : actual.verdict === fixture.expected.verdict
      && (fixture.expected.labels ?? []).every((l) => actual.labels.includes(l));
  if (!ok) mismatches += 1;
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${fixture.id}  expected=${expected}  actual=${observed}`);
}
console.log(`\n${String(mismatches)} mismatch(es)`);
process.exit(mismatches === 0 ? 0 : 1);
