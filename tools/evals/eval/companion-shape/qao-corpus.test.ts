import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildQaoCorpusArtifact,
  type QaoCorpusArtifact,
  type QaoCorpusOmissionReason,
} from './qao-corpus.js';

const FIXTURE_DIR = path.resolve(process.cwd(), 'eval/companion-shape/fixtures');

function readJsonFixture(fileName: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, fileName), 'utf8')) as unknown;
}

function buildFixtureArtifact(): QaoCorpusArtifact {
  return buildQaoCorpusArtifact(readJsonFixture('qao-corpus-source-records.json'), {
    generatedAt: '2026-06-20T00:00:00.000Z',
  });
}

function omissionReasons(artifact: QaoCorpusArtifact, sourceRecordId: string): QaoCorpusOmissionReason[] {
  return artifact.omissions.find((omission) => omission.sourceRecordId === sourceRecordId)?.reasons ?? [];
}

describe('QAO sanitized corpus builder', () => {
  it('emits public and approved synthetic examples into all required corpus families', () => {
    const artifact = buildFixtureArtifact();

    expect(artifact.sourceSummary).toEqual({
      acceptedRecords: 4,
      rejectedRecords: 8,
      emittedExamples: 5,
    });
    expect(artifact.examples.replay_continuation).toHaveLength(1);
    expect(artifact.examples.memory_grounded_response_prompts).toHaveLength(1);
    expect(artifact.examples.relationship_critical_memories).toHaveLength(1);
    expect(artifact.examples.boundaries_consent).toHaveLength(1);
    expect(artifact.examples.tool_truthfulness).toHaveLength(1);
  });

  it('preserves provenance and policy metadata on emitted examples', () => {
    const artifact = buildFixtureArtifact();
    const example = artifact.examples.memory_grounded_response_prompts[0];

    expect(example).toEqual(expect.objectContaining({
      sourceType: 'lower_tier_memory',
      provenance: expect.objectContaining({
        datasetId: 'qao.synthetic.corpus.v1',
        sourceId: 'fixture-memory-001',
        approvalId: 'fixture-approval-001',
        policyVersion: 'qao-corpus-policy-v1',
        synthetic: true,
      }),
      policy: expect.objectContaining({
        classification: 'approved_eval',
        consent: 'approved',
        sensitivity: 'low_tier',
        trust: 'trusted',
        channelVisibility: 'operator_approved_eval',
        redactionState: 'synthetic',
      }),
    }));
    expect(example?.prompt).toContain('Use only this sanitized memory projection');
    expect(example?.prompt).not.toMatch(/\buuid\b|\bembedding\b|\bsourceRef\b/iu);
  });

  it.each([
    ['synthetic-gated', 'gated_material'],
    ['synthetic-private', 'private_material'],
    ['synthetic-closed-door', 'closed_door_material'],
    ['synthetic-missing-metadata', 'missing_metadata'],
    ['synthetic-ambiguous', 'ambiguous_material'],
    ['synthetic-unknown-source', 'unknown_source_type'],
    ['synthetic-unknown-policy', 'unknown_policy'],
    ['synthetic-raw-sensitive', 'raw_sensitive_material'],
  ] as const)('omits %s with %s', (sourceRecordId, reason) => {
    const artifact = buildFixtureArtifact();

    expect(omissionReasons(artifact, sourceRecordId)).toContain(reason);
  });

  it('keeps redaction markers but does not emit raw rejected context', () => {
    const artifact = buildFixtureArtifact();
    const redactedPrompt = artifact.examples.boundaries_consent[0]?.prompt;
    const serialized = JSON.stringify(artifact);

    expect(redactedPrompt).toContain('[REDACTED:project-name]');
    expect(artifact.examples.boundaries_consent[0]?.policy).toEqual(expect.objectContaining({
      redactionState: 'redacted',
      appliedRedactions: ['project-name'],
    }));
    expect(serialized).not.toContain('[RAW_PRIVATE:synthetic raw detail]');
    expect(serialized).not.toContain('Legacy policy should not pass.');
    expect(serialized).not.toContain('This should not be emitted.');
  });

  it('returns a safe artifact shape with omissions but no raw source payloads', () => {
    const artifact = buildFixtureArtifact();

    expect(artifact).toEqual(expect.objectContaining({
      schemaVersion: 1,
      artifactType: 'psfn.qao_sanitized_corpus',
      generatedAt: '2026-06-20T00:00:00.000Z',
      privacy: {
        containsLiveCompanionData: false,
        notes: expect.any(String),
      },
    }));
    expect(artifact.omissions.every((omission) => omission.reasons.length > 0)).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain('projectedFields');
    expect(JSON.stringify(artifact)).not.toContain('turns');
  });

  it('fails closed when the top-level source list is malformed', () => {
    expect(() => buildQaoCorpusArtifact({ records: [] })).toThrow(/sourceRecords must be an array/);
  });
});
