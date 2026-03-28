import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearVadLexiconCache,
  loadVadLexicon,
  parseVadLexicon,
  resolveVadLexiconPath,
  scoreText,
  scoreVadTokens,
  tokenizeVadText,
} from './vad-lexicon.js';

const SAMPLE_LEXICON = [
  '# NRC VAD sample',
  'term\tvalence\tarousal\tdominance',
  'happy\t0.90\t0.70\t0.80',
  'calm\t0.80\t0.20\t0.70',
  'sad\t0.20\t0.60\t0.30',
  're-enter\t0.40\t0.50\t0.45',
].join('\n');

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-vad-'));
  tempDirs.push(dir);
  return dir;
}

function writeLexicon(path: string, body = SAMPLE_LEXICON): void {
  mkdirSync(join(path, 'emotion'), { recursive: true });
  writeFileSync(join(path, 'emotion', 'nrc-vad-lexicon-v2.tsv'), `${body}\n`, 'utf-8');
}

afterEach(() => {
  clearVadLexiconCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('vad-lexicon path resolution', () => {
  it('prefers explicit NRC_VAD_LEXICON_PATH override', () => {
    const path = resolveVadLexiconPath({
      env: { NRC_VAD_LEXICON_PATH: ' /tmp/custom-vad.tsv ' } as NodeJS.ProcessEnv,
    });

    expect(path).toBe('/tmp/custom-vad.tsv');
  });

  it('derives path from configured system data roots', () => {
    const path = resolveVadLexiconPath({
      env: {
        SYSTEM_DATA_DIR: '/srv/system-data',
        COMPANION_DATA_DIR: '/srv/companion-data',
      } as NodeJS.ProcessEnv,
    });

    expect(path).toBe('/srv/system-data/emotion/nrc-vad-lexicon-v2.tsv');
  });

  it('falls back to DATA_DIR when split roots are not configured', () => {
    const path = resolveVadLexiconPath({
      env: { DATA_DIR: '/srv/data' } as NodeJS.ProcessEnv,
    });

    expect(path).toBe('/srv/data/emotion/nrc-vad-lexicon-v2.tsv');
  });
});

describe('vad-lexicon loading and scoring', () => {
  it('loads a lexicon file from the resolved data path', () => {
    const dataDir = createTempDir();
    writeLexicon(dataDir);

    const lexicon = loadVadLexicon({
      env: { DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      cache: false,
    });

    expect(lexicon.size).toBe(4);
    expect(lexicon.get('happy')?.valence).toBeCloseTo(0.9, 5);
    expect(lexicon.get('sad')?.dominance).toBeCloseTo(0.3, 5);
  });

  it('tokenizes text and averages scores over matched terms only', () => {
    const lexicon = parseVadLexicon(SAMPLE_LEXICON, 'fixture');
    const score = scoreText('Happy, calm... and happy again!', lexicon);

    expect(score.valence).toBeCloseTo((0.9 + 0.8 + 0.9) / 3, 6);
    expect(score.arousal).toBeCloseTo((0.7 + 0.2 + 0.7) / 3, 6);
    expect(score.dominance).toBeCloseTo((0.8 + 0.7 + 0.8) / 3, 6);
  });

  it('returns neutral VAD when no tokens match the lexicon', () => {
    const lexicon = parseVadLexicon(SAMPLE_LEXICON, 'fixture');
    const scored = scoreVadTokens(['unknown', 'term'], lexicon);

    expect(scored.matchedTokenCount).toBe(0);
    expect(scored.totalTokenCount).toBe(2);
    expect(scored.score).toEqual({
      valence: 0.5,
      arousal: 0.5,
      dominance: 0.5,
    });
  });

  it('normalizes apostrophes and keeps hyphenated words as single tokens', () => {
    expect(tokenizeVadText('Re-enter isn’t easy.')).toEqual(['re-enter', 'isn\'t', 'easy']);
  });

  it('fails closed on malformed score values', () => {
    expect(() => parseVadLexicon(
      [
        'term\tvalence\tarousal\tdominance',
        'happy\tabc\t0.7\t0.8',
      ].join('\n'),
      'broken-fixture',
    )).toThrow('Invalid valence score');
  });
});
