// ── Taxonomy-derived adversarial fixture corpus (psfn-framework-hrmrq.141) ──
//
// A pinned, versioned corpus mapping published attack-taxonomy entries
// (Arcanum PI Taxonomy v1.6.1, MITRE ATLAS 2026.07) onto the PSFN CogSec
// surfaces that must defeat them. This module owns the fixture contract,
// the loader (fail-closed validation — unknown framework/axis/layer/label/
// taxonomy-id data rejects), and the coverage computation that turns
// "what is the firewall NOT tested against?" into a stated fact.
//
// Layout:
//   upstream/manifest.json             version pins + hashes (bump signal)
//   upstream/arcanum-taxonomy.json     pinned Arcanum snapshot (172 entries)
//   upstream/atlas-technique-index.json  pinned ATLAS technique id/name index
//   upstream/atlas-relevance.json      ATLAS techniques in scope + rationale
//   fixtures/*.jsonl                   the corpus itself, one fixture per line
//
// Fixture status semantics (the ratchet):
//   enforced      — replayed offline against the real layer; actual behavior
//                   MUST equal `expected`. A regression fails the gate.
//   known-gap     — replayed offline; actual behavior MUST equal
//                   `knownGap.actual*`. An improvement OR a regression fails
//                   the gate until the fixture is updated — a fix can never
//                   land silently, and a gap can never widen silently.
//   semantic-only — targets a layer with no offline oracle (L2/L3 model
//                   screeners, live origin gating). Presence + schema are
//                   gated; verdicts are asserted by the live shakedown.
//
// Constraint (seed doc §6): fixtures are synthetic or derived from the
// published Arcanum examples[] only. No live companion content, no real
// names, no transcript excerpts — scripts/public-sanitize-check.mjs gates.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTAKE_RISK_LABELS,
  INTAKE_SOURCE_CLASSES,
  type IntakeRiskLabel,
  type IntakeSourceClass,
} from '../../../../shared/contracts/intake-envelope.js';
import { isRecord } from '../../../../shared/utils/types.js';

// ── Closed vocabularies ──

export const CORPUS_FRAMEWORKS = ['arcanum-pi-taxonomy', 'mitre-atlas'] as const;
export type CorpusFramework = typeof CORPUS_FRAMEWORKS[number];

export const CORPUS_AXES = ['inputs', 'techniques', 'evasions', 'intents', 'atlas-technique'] as const;
export type CorpusAxis = typeof CORPUS_AXES[number];

export const CORPUS_LAYERS = [
  'L1',
  'L1.5',
  'L2',
  'L3',
  'vision',
  'sink-gate',
  'origin-gating',
] as const;
export type CorpusLayer = typeof CORPUS_LAYERS[number];

/** Layers with an offline, deterministic oracle — replayable in CI. */
export const OFFLINE_REPLAYABLE_LAYERS: readonly CorpusLayer[] = ['L1'];

export const CORPUS_FIXTURE_STATUSES = ['enforced', 'known-gap', 'semantic-only'] as const;
export type CorpusFixtureStatus = typeof CORPUS_FIXTURE_STATUSES[number];

export const CORPUS_VERDICTS = ['flag', 'pass'] as const;
export type CorpusVerdict = typeof CORPUS_VERDICTS[number];

export const CORPUS_PROVENANCE = ['arcanum-example', 'synthetic-derived'] as const;
export type CorpusProvenance = typeof CORPUS_PROVENANCE[number];

export const MAX_FIXTURE_PAYLOAD_CHARS = 8192;
export const MAX_FIXTURE_NOTE_CHARS = 512;

// ── Fixture contract ──

export interface CorpusFixtureTaxonomy {
  framework: CorpusFramework;
  axis: CorpusAxis;
  /** Stable upstream id: an Arcanum slug ('a1z26') or an ATLAS id ('AML.T0051'). */
  entryId: string;
}

export interface CorpusFixtureExpectation {
  /** 'flag' = the layer must raise at least one risk label; 'pass' = must stay silent. */
  verdict: CorpusVerdict;
  /** Labels the layer must raise (subset match). Only meaningful with verdict 'flag'. */
  labels?: IntakeRiskLabel[];
}

export interface CorpusFixtureKnownGap {
  actualVerdict: CorpusVerdict;
  actualLabels: IntakeRiskLabel[];
  /** The finding: what the gap is and where it is tracked (bead ref required). */
  finding: string;
}

export interface CorpusFixture {
  /** Unique across the corpus. Convention: '<axis>-<entryId>-<nn>'. */
  id: string;
  kind: 'attack' | 'control';
  taxonomy: CorpusFixtureTaxonomy;
  layer: CorpusLayer;
  /** The intake surface the payload arrives on. */
  sourceClass: IntakeSourceClass;
  payload: string;
  expected: CorpusFixtureExpectation;
  status: CorpusFixtureStatus;
  knownGap?: CorpusFixtureKnownGap;
  provenance: CorpusProvenance;
  notes?: string;
}

// ── Upstream pins ──

export interface ArcanumTaxonomyEntry {
  id: string;
  title: string;
  description?: string;
  ideas?: string[];
  examples?: string[];
}

export interface ArcanumTaxonomySnapshot {
  inputs: ArcanumTaxonomyEntry[];
  techniques: ArcanumTaxonomyEntry[];
  evasions: ArcanumTaxonomyEntry[];
  intents: ArcanumTaxonomyEntry[];
}

export interface AtlasTechniqueIndexEntry {
  id: string;
  name: string;
  parent?: string;
}

export interface AtlasTechniqueIndex {
  release: string;
  formatVersion: string;
  source: string;
  techniques: AtlasTechniqueIndexEntry[];
}

export interface AtlasRelevanceEntry {
  techniqueId: string;
  psfnSurface: string;
  rationale: string;
}

export interface CorpusUpstream {
  manifest: Record<string, unknown>;
  arcanum: ArcanumTaxonomySnapshot;
  atlasIndex: AtlasTechniqueIndex;
  atlasRelevance: AtlasRelevanceEntry[];
}

export interface Corpus {
  upstream: CorpusUpstream;
  fixtures: CorpusFixture[];
}

// ── Validation ──

function fail(path: string, reason: string): never {
  throw new Error(`CogSec corpus: ${path}: ${reason}`);
}

function requireString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'must be a non-empty string');
  }
  if (value.length > maxChars) {
    fail(path, `exceeds ${String(maxChars)} chars`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

const FIXTURE_KEYS = new Set([
  'id', 'kind', 'taxonomy', 'layer', 'sourceClass', 'payload',
  'expected', 'status', 'knownGap', 'provenance', 'notes',
]);
const TAXONOMY_KEYS = new Set(['framework', 'axis', 'entryId']);
const EXPECTED_KEYS = new Set(['verdict', 'labels']);
const KNOWN_GAP_KEYS = new Set(['actualVerdict', 'actualLabels', 'finding']);

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(path, `unknown key '${key}'`);
  }
}

function parseLabels(value: unknown, path: string): IntakeRiskLabel[] {
  if (!Array.isArray(value)) fail(path, 'must be an array of risk labels');
  return value.map((label, index) =>
    requireEnum(label, INTAKE_RISK_LABELS, `${path}[${String(index)}]`));
}

function parseFixture(
  raw: unknown,
  path: string,
  validEntryIds: ReadonlyMap<CorpusAxis, ReadonlySet<string>>,
): CorpusFixture {
  if (!isRecord(raw)) fail(path, 'fixture must be an object');
  rejectUnknownKeys(raw, FIXTURE_KEYS, path);

  const id = requireString(raw.id, `${path}.id`, 128);
  const kind = requireEnum(raw.kind, ['attack', 'control'] as const, `${path}.kind`);
  const layer = requireEnum(raw.layer, CORPUS_LAYERS, `${path}.layer`);
  const sourceClass = requireEnum(raw.sourceClass, INTAKE_SOURCE_CLASSES, `${path}.sourceClass`);
  const payload = requireString(raw.payload, `${path}.payload`, MAX_FIXTURE_PAYLOAD_CHARS);
  const status = requireEnum(raw.status, CORPUS_FIXTURE_STATUSES, `${path}.status`);
  const provenance = requireEnum(raw.provenance, CORPUS_PROVENANCE, `${path}.provenance`);

  if (!isRecord(raw.taxonomy)) fail(`${path}.taxonomy`, 'must be an object');
  rejectUnknownKeys(raw.taxonomy, TAXONOMY_KEYS, `${path}.taxonomy`);
  const framework = requireEnum(raw.taxonomy.framework, CORPUS_FRAMEWORKS, `${path}.taxonomy.framework`);
  const axis = requireEnum(raw.taxonomy.axis, CORPUS_AXES, `${path}.taxonomy.axis`);
  const entryId = requireString(raw.taxonomy.entryId, `${path}.taxonomy.entryId`, 128);
  if (framework === 'arcanum-pi-taxonomy' && axis === 'atlas-technique') {
    fail(`${path}.taxonomy.axis`, `framework 'arcanum-pi-taxonomy' cannot use axis 'atlas-technique'`);
  }
  if (framework === 'mitre-atlas' && axis !== 'atlas-technique') {
    fail(`${path}.taxonomy.axis`, `framework 'mitre-atlas' requires axis 'atlas-technique'`);
  }
  if (!validEntryIds.get(axis)?.has(entryId)) {
    fail(
      `${path}.taxonomy.entryId`,
      `'${entryId}' is not in the pinned upstream snapshot for axis '${axis}' — `
      + 'an upstream bump that renames/removes entries must be reconciled deliberately',
    );
  }

  if (!isRecord(raw.expected)) fail(`${path}.expected`, 'must be an object');
  rejectUnknownKeys(raw.expected, EXPECTED_KEYS, `${path}.expected`);
  const verdict = requireEnum(raw.expected.verdict, CORPUS_VERDICTS, `${path}.expected.verdict`);
  const expected: CorpusFixtureExpectation = { verdict };
  if (raw.expected.labels !== undefined) {
    const labels = parseLabels(raw.expected.labels, `${path}.expected.labels`);
    if (labels.length === 0) fail(`${path}.expected.labels`, 'must be non-empty when present');
    if (verdict !== 'flag') fail(`${path}.expected.labels`, `labels require verdict 'flag'`);
    expected.labels = labels;
  }

  let knownGap: CorpusFixtureKnownGap | undefined;
  if (status === 'known-gap') {
    if (!isRecord(raw.knownGap)) {
      fail(`${path}.knownGap`, `status 'known-gap' requires a knownGap record`);
    }
    rejectUnknownKeys(raw.knownGap, KNOWN_GAP_KEYS, `${path}.knownGap`);
    const actualVerdict = requireEnum(raw.knownGap.actualVerdict, CORPUS_VERDICTS, `${path}.knownGap.actualVerdict`);
    const actualLabels = parseLabels(raw.knownGap.actualLabels ?? [], `${path}.knownGap.actualLabels`);
    const finding = requireString(raw.knownGap.finding, `${path}.knownGap.finding`, MAX_FIXTURE_NOTE_CHARS);
    if (!/psfn-framework-[a-z0-9.]+/u.test(finding)) {
      fail(`${path}.knownGap.finding`, 'must reference a tracking bead (psfn-framework-…)');
    }
    knownGap = { actualVerdict, actualLabels, finding };
  } else if (raw.knownGap !== undefined) {
    fail(`${path}.knownGap`, `only allowed with status 'known-gap'`);
  }

  if (status === 'semantic-only' && (OFFLINE_REPLAYABLE_LAYERS as readonly string[]).includes(layer)) {
    fail(
      `${path}.status`,
      `layer '${layer}' is offline-replayable — fixtures must be 'enforced' or 'known-gap', never 'semantic-only'`,
    );
  }

  const fixture: CorpusFixture = {
    id, kind, taxonomy: { framework, axis, entryId }, layer, sourceClass,
    payload, expected, status, provenance,
    ...(knownGap === undefined ? {} : { knownGap }),
    ...(raw.notes === undefined
      ? {}
      : { notes: requireString(raw.notes, `${path}.notes`, MAX_FIXTURE_NOTE_CHARS) }),
  };
  return fixture;
}

// ── Loading ──

function readJson<T>(path: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    fail(path, `unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed as T;
}

function loadArcanum(path: string): ArcanumTaxonomySnapshot {
  const raw = readJson<unknown>(path);
  if (!isRecord(raw)) fail(path, 'snapshot must be an object');
  const snapshot = {} as Record<string, ArcanumTaxonomyEntry[]>;
  for (const axis of ['inputs', 'techniques', 'evasions', 'intents'] as const) {
    const entries = raw[axis];
    if (!Array.isArray(entries) || entries.length === 0) {
      fail(path, `axis '${axis}' must be a non-empty array`);
    }
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
        fail(path, `axis '${axis}' entry ${String(index)} lacks a stable id`);
      }
    }
    snapshot[axis] = entries as ArcanumTaxonomyEntry[];
  }
  return snapshot as unknown as ArcanumTaxonomySnapshot;
}

function loadAtlasIndex(path: string): AtlasTechniqueIndex {
  const raw = readJson<unknown>(path);
  if (!isRecord(raw) || !Array.isArray(raw.techniques)) {
    fail(path, 'ATLAS index must be an object with a techniques array');
  }
  for (const [index, entry] of raw.techniques.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.startsWith('AML.T')) {
      fail(path, `technique ${String(index)} lacks an AML.T id`);
    }
  }
  return raw as unknown as AtlasTechniqueIndex;
}

function loadAtlasRelevance(path: string, index: AtlasTechniqueIndex): AtlasRelevanceEntry[] {
  const raw = readJson<unknown>(path);
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(path, 'relevance list must be a non-empty array');
  }
  const known = new Set(index.techniques.map((t) => t.id));
  return raw.map((entry, i) => {
    const p = `${path}[${String(i)}]`;
    if (!isRecord(entry)) fail(p, 'must be an object');
    const techniqueId = requireString(entry.techniqueId, `${p}.techniqueId`, 32);
    if (!known.has(techniqueId)) {
      fail(`${p}.techniqueId`, `'${techniqueId}' is not in the pinned ATLAS technique index`);
    }
    return {
      techniqueId,
      psfnSurface: requireString(entry.psfnSurface, `${p}.psfnSurface`, 256),
      rationale: requireString(entry.rationale, `${p}.rationale`, MAX_FIXTURE_NOTE_CHARS),
    };
  });
}

/** Loads and fully validates the corpus rooted at `corpusDir`. Throws on any defect. */
export function loadCorpus(corpusDir: string): Corpus {
  const upstreamDir = join(corpusDir, 'upstream');
  const manifest = readJson<Record<string, unknown>>(join(upstreamDir, 'manifest.json'));
  const arcanum = loadArcanum(join(upstreamDir, 'arcanum-taxonomy.json'));
  const atlasIndex = loadAtlasIndex(join(upstreamDir, 'atlas-technique-index.json'));
  const atlasRelevance = loadAtlasRelevance(join(upstreamDir, 'atlas-relevance.json'), atlasIndex);

  const validEntryIds = new Map<CorpusAxis, Set<string>>([
    ['inputs', new Set(arcanum.inputs.map((e) => e.id))],
    ['techniques', new Set(arcanum.techniques.map((e) => e.id))],
    ['evasions', new Set(arcanum.evasions.map((e) => e.id))],
    ['intents', new Set(arcanum.intents.map((e) => e.id))],
    ['atlas-technique', new Set(atlasIndex.techniques.map((t) => t.id))],
  ]);

  const fixturesDir = join(corpusDir, 'fixtures');
  const fixtures: CorpusFixture[] = [];
  const seenIds = new Set<string>();
  for (const fileName of readdirSync(fixturesDir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const filePath = join(fixturesDir, fileName);
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const path = `${fileName}:${String(index + 1)}`;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        fail(path, 'invalid JSON line');
      }
      const fixture = parseFixture(raw, path, validEntryIds);
      if (seenIds.has(fixture.id)) fail(path, `duplicate fixture id '${fixture.id}'`);
      seenIds.add(fixture.id);
      fixtures.push(fixture);
    }
  }
  if (fixtures.length === 0) fail(fixturesDir, 'corpus contains no fixtures');
  return { upstream: { manifest, arcanum, atlasIndex, atlasRelevance }, fixtures };
}

// ── Coverage ──

export interface EntryCoverage {
  axis: CorpusAxis;
  entryId: string;
  title: string;
  attackFixtures: number;
  enforced: number;
  knownGaps: number;
  semanticOnly: number;
  findings: string[];
}

export interface CorpusCoverage {
  entries: EntryCoverage[];
  uncovered: EntryCoverage[];
  totals: {
    upstreamEntries: number;
    coveredEntries: number;
    fixtures: number;
    enforced: number;
    knownGaps: number;
    semanticOnly: number;
  };
}

/**
 * The coverage denominator: every pinned upstream entry, covered or not.
 * "Covered" means at least one attack fixture — the quality dimension
 * (enforced vs known-gap vs semantic-only) is reported, not hidden.
 */
export function computeCoverage(corpus: Corpus): CorpusCoverage {
  const byEntry = new Map<string, CorpusFixture[]>();
  for (const fixture of corpus.fixtures) {
    if (fixture.kind !== 'attack') continue;
    const key = `${fixture.taxonomy.axis}:${fixture.taxonomy.entryId}`;
    const list = byEntry.get(key) ?? [];
    list.push(fixture);
    byEntry.set(key, list);
  }

  const entries: EntryCoverage[] = [];
  const addAxis = (axis: CorpusAxis, upstreamEntries: { id: string; title: string }[]): void => {
    for (const entry of upstreamEntries) {
      const fixtures = byEntry.get(`${axis}:${entry.id}`) ?? [];
      const coverage: EntryCoverage = {
        axis,
        entryId: entry.id,
        title: entry.title,
        attackFixtures: fixtures.length,
        enforced: fixtures.filter((f) => f.status === 'enforced').length,
        knownGaps: fixtures.filter((f) => f.status === 'known-gap').length,
        semanticOnly: fixtures.filter((f) => f.status === 'semantic-only').length,
        findings: fixtures.flatMap((f) => (f.knownGap ? [f.knownGap.finding] : [])),
      };
      entries.push(coverage);
    }
  };

  const arcanum = corpus.upstream.arcanum;
  addAxis('inputs', arcanum.inputs.map((e) => ({ id: e.id, title: e.title })));
  addAxis('techniques', arcanum.techniques.map((e) => ({ id: e.id, title: e.title })));
  addAxis('evasions', arcanum.evasions.map((e) => ({ id: e.id, title: e.title })));
  addAxis('intents', arcanum.intents.map((e) => ({ id: e.id, title: e.title })));
  // The ATLAS denominator is the relevance list, not all 178 techniques —
  // relevance is a curated, justified scoping decision (atlas-relevance.json).
  const atlasTitles = new Map(corpus.upstream.atlasIndex.techniques.map((t) => [t.id, t.name]));
  addAxis('atlas-technique', corpus.upstream.atlasRelevance.map((r) => ({
    id: r.techniqueId,
    title: atlasTitles.get(r.techniqueId) ?? r.techniqueId,
  })));

  const uncovered = entries.filter((e) => e.attackFixtures === 0);
  return {
    entries,
    uncovered,
    totals: {
      upstreamEntries: entries.length,
      coveredEntries: entries.length - uncovered.length,
      fixtures: corpus.fixtures.length,
      enforced: corpus.fixtures.filter((f) => f.status === 'enforced').length,
      knownGaps: corpus.fixtures.filter((f) => f.status === 'known-gap').length,
      semanticOnly: corpus.fixtures.filter((f) => f.status === 'semantic-only').length,
    },
  };
}
