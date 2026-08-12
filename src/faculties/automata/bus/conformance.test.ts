import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { projectAutomataBusReferenceState } from '../../../test-support/automata-bus-reference-reducer.js';
import {
  AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
  AUTOMATA_BUS_RELATIONS_FEATURE,
  AUTOMATA_BUS_SCHEMA_VERSION,
  AUTOMATA_BUS_SUPPORTED_FEATURES,
  parseAutomataBusEvent,
  validateAutomataBusHistory,
  type AutomataBusAccepted,
  type AutomataBusEvent,
  type AutomataBusEventType,
  type AutomataBusEvidence,
  type AutomataBusEvidenceKind,
  type AutomataBusFeature,
  type AutomataBusFindingBody,
  type AutomataBusFindingEvent,
  type AutomataBusNotUnderstood,
  type AutomataBusParseResult,
  type AutomataBusProvenance,
  type AutomataBusRejected,
  type AutomataBusRelationBody,
  type AutomataBusVerification,
  type AutomataBusVerificationStatus,
} from './contract.js';
import { projectAutomataBusCurrentState } from './current-state.js';

interface ConformanceManifestCase {
  file: string;
  outcome: 'accepted' | 'not-understood' | 'rejected';
  proves: string[];
}

interface ConformanceManifest {
  contractVersion: number;
  sources: {
    developmentFork: string;
    upstream: string;
  };
  cases: ConformanceManifestCase[];
}

interface ExpectedProjection {
  effectiveFindings: Array<{ eventId: string; claim: string }>;
  dispositions: Array<{
    targetEventId: string;
    relation: string;
    byEventId: string;
  }>;
}

interface ConformanceFixture {
  description: string;
  events: unknown[];
  projection?: ExpectedProjection;
}

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  'conformance',
  'v1',
);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const manifest = readJson<ConformanceManifest>(join(FIXTURE_ROOT, 'manifest.json'));

function compactProjection(state: ReturnType<typeof projectAutomataBusCurrentState>): ExpectedProjection {
  return {
    effectiveFindings: state.effectiveFindings.map(finding => ({
      eventId: finding.eventId,
      claim: finding.body.claim,
    })),
    dispositions: state.dispositions,
  };
}

describe('Automata Bus v1 language-neutral conformance corpus', () => {
  it('exposes the complete typed v1 contract surface', () => {
    expect(AUTOMATA_BUS_SCHEMA_VERSION).toBe(1);
    expect(AUTOMATA_BUS_SUPPORTED_FEATURES).toEqual([
      AUTOMATA_BUS_RELATIONS_FEATURE,
      AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
    ]);
    expectTypeOf<AutomataBusFeature>()
      .toEqualTypeOf<'finding-relations-v1' | 'lesson-attribution-v1'>();
    expectTypeOf<AutomataBusEventType>().toEqualTypeOf<'finding' | 'relation'>();
    expectTypeOf<AutomataBusProvenance>()
      .toEqualTypeOf<'computed' | 'fetched' | 'recalled' | 'testimony'>();
    expectTypeOf<AutomataBusEvidenceKind>()
      .toEqualTypeOf<'artifact' | 'command' | 'external' | 'session-span'>();
    expectTypeOf<AutomataBusVerificationStatus>()
      .toEqualTypeOf<'pending' | 'rejected' | 'verified'>();
    expectTypeOf<AutomataBusFindingBody['evidence']>().toEqualTypeOf<AutomataBusEvidence[]>();
    expectTypeOf<AutomataBusFindingBody['verification']>().toEqualTypeOf<AutomataBusVerification>();
    expectTypeOf<AutomataBusFindingEvent['body']>().toEqualTypeOf<AutomataBusFindingBody>();
    expectTypeOf<AutomataBusRelationBody['replacement']>()
      .toEqualTypeOf<AutomataBusFindingBody | undefined>();
    expectTypeOf<Extract<AutomataBusParseResult<AutomataBusEvent>, { status: 'accepted' }>>()
      .toEqualTypeOf<AutomataBusAccepted<AutomataBusEvent>>();
    expectTypeOf<Extract<AutomataBusParseResult<AutomataBusEvent>, { status: 'rejected' }>>()
      .toEqualTypeOf<AutomataBusRejected>();
    expectTypeOf<Extract<AutomataBusParseResult<AutomataBusEvent>, { status: 'not-understood' }>>()
      .toEqualTypeOf<AutomataBusNotUnderstood>();

    const fixture = readJson<ConformanceFixture>(join(FIXTURE_ROOT, 'accept/computed-finding.json'));
    expect(parseAutomataBusEvent(fixture.events[0]).status).toBe('accepted');
  });

  it('requires explicit feature negotiation and content-safe identifiers for lesson attribution', () => {
    const fixture = readJson<ConformanceFixture>(join(FIXTURE_ROOT, 'accept/computed-finding.json'));
    const base = fixture.events[0] as Record<string, unknown>;
    const body = base.body as Record<string, unknown>;
    const attributed = {
      ...base,
      mustUnderstand: [AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE],
      body: {
        ...body,
        lessonAttribution: {
          promptRevision: 'sha256:prompt-r1',
          toolName: 'repo',
          failureCategory: 'missing-instruction',
          lessonCode: 'read-before-edit',
          contradictionEventIds: [],
        },
      },
    };

    expect(parseAutomataBusEvent(attributed).status).toBe('accepted');
    expect(parseAutomataBusEvent({ ...attributed, mustUnderstand: [] })).toMatchObject({
      status: 'rejected',
      issues: [expect.stringMatching(/lesson-attribution-v1/u)],
    });
    expect(parseAutomataBusEvent({
      ...attributed,
      body: {
        ...attributed.body,
        lessonAttribution: {
          ...(attributed.body as Record<string, unknown>).lessonAttribution as object,
          lessonCode: 'private transcript sentence',
        },
      },
    })).toMatchObject({
      status: 'rejected',
      issues: [expect.stringMatching(/content-safe identifier/u)],
    });
  });

  it('pins both source commits and the contract generation', () => {
    expect(manifest.contractVersion).toBe(1);
    expect(manifest.sources.developmentFork).toBe('93ee245db060e9cdb9c9c32f6d31d76d0c5a491d');
    expect(manifest.sources.upstream).toBe('7dba0e40a1ce4def8b1c4ac8670a94aa54f9116e');
  });

  for (const conformanceCase of manifest.cases) {
    it(`${conformanceCase.outcome}: ${conformanceCase.file}`, () => {
      expect(conformanceCase.proves.length).toBeGreaterThan(0);
      const fixture = readJson<ConformanceFixture>(join(FIXTURE_ROOT, conformanceCase.file));
      expect(fixture.description).not.toHaveLength(0);
      const result = validateAutomataBusHistory(fixture.events);
      expect(result.status).toBe(conformanceCase.outcome);

      if (result.status !== 'accepted') return;
      const production = projectAutomataBusCurrentState(fixture.events);
      const reference = projectAutomataBusReferenceState(fixture.events);
      expect(reference).toEqual(production);
      if (fixture.projection !== undefined) {
        expect(compactProjection(production)).toEqual(fixture.projection);
      }
    });
  }
});
