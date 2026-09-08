import { describe, expect, it } from 'vitest';

import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createDefaultBiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import { normalizeBiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import { BiographySynthesisService } from './synthesis-service.js';
import type {
  BiographySynthesisTarget,
  BiographySynthesisTargetPort,
} from './synthesis-service.js';
import type { BiographicalSubjectRef } from './types.js';

const NOW = new Date('2026-02-01T00:00:00.000Z');
const COMPANION_SUBJECT: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
  kind: 'companion',
  companionId: 'companion-invented',
  subjectVersion: 1,
};
const CONTACT_SUBJECT: Extract<BiographicalSubjectRef, { kind: 'contact' }> = {
  kind: 'contact',
  contactId: 'contact-invented',
  subjectVersion: 1,
};

const POLICY: BiographicalCandidatePolicy = normalizeBiographicalCandidatePolicy({
  schemaVersion: 1,
  admittedSourceTypes: ['semantic', 'episodic', 'reflection', 'relational'],
  maximumSourceSensitivity: 'personal',
  excludedLifecycleStates: [
    'quarantined',
    'tombstoned',
    'cogsec_blocked',
    'revoked',
    'superseded',
  ],
  budgets: {
    maxPendingCandidates: 100,
    maxCandidatesPerAutomataRun: 20,
    maxSourcesPerCandidate: 8,
    maxReviewReceiptsPerCandidate: 8,
  },
  reviewTriggers: ['human_subject', 'inferred_basis', 'imported_basis', 'relational_claim'],
  companionOnlyAutoactivation: {
    enabled: true,
    scopes: ['companion_self'],
    admittedClaimKinds: ['nickname', 'role', 'stable-preference'],
    admittedBases: ['explicit'],
    maximumSensitivity: 'personal',
  },
  projectionScopes: ['companion_self', 'current_author', 'explicitly_relevant_subject'],
});

function memory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `Memory ${id}`,
    type: 'semantic',
    importance: 0.6,
    confidence: 0.9,
    emotionalValence: 0.1,
    salience: 0.4,
    sourceRef: 'test:biography-synthesis',
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    consentFlags: {},
    provenance: { subjectContactId: CONTACT_SUBJECT.contactId },
    ...overrides,
  };
}

/** A memory the companion authored about itself, in its own private silo. */
function companionMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return memory(id, {
    sourceType: 'reflection',
    provenance: {},
    ...overrides,
  });
}

function targetPort(targets: readonly BiographySynthesisTarget[]): BiographySynthesisTargetPort {
  return { listTargets: async () => targets };
}

const CONTACT_TARGET: BiographySynthesisTarget = {
  subject: CONTACT_SUBJECT,
  socialContext: {
    kind: 'companion_contact_dyad',
    companionId: COMPANION_SUBJECT.companionId,
    contactId: CONTACT_SUBJECT.contactId,
  },
  depth: 'full',
};

const COMPANION_TARGET: BiographySynthesisTarget = {
  subject: COMPANION_SUBJECT,
  socialContext: { kind: 'companion_self', companionId: COMPANION_SUBJECT.companionId },
  depth: 'full',
};

interface RecordingModel {
  readonly port: LLMProviderPort;
  readonly prompts: string[];
}

function recordingModel(responses: readonly string[]): RecordingModel {
  const prompts: string[] = [];
  let index = 0;
  const port = {
    complete: async (request: { systemPrompt?: string }) => {
      prompts.push(request.systemPrompt ?? '');
      const content = responses[Math.min(index, responses.length - 1)] ?? '';
      index += 1;
      return { content, model: 'test-model', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  } as unknown as LLMProviderPort;
  return { port, prompts };
}

function candidatesResponse(candidates: readonly unknown[]): string {
  return `<biographical_candidates>${JSON.stringify(candidates)}</biographical_candidates>`;
}

function preferenceCandidate(sourceMemoryIds: readonly string[], target = 'concise explanations') {
  return {
    kind: 'stable-preference',
    value: {
      kind: 'stable-preference',
      schemaVersion: 1,
      domain: 'communication',
      target,
      polarity: 'prefers',
    },
    basis: 'explicit',
    confidence: 0.9,
    sourceMemoryIds: [...sourceMemoryIds],
  };
}

function buildService(input: {
  memoryStore: MemoryStorePort;
  profileStore: InMemoryBiographicalProfileStore;
  model: RecordingModel;
  targets: readonly BiographySynthesisTarget[];
  runId?: string;
}): BiographySynthesisService {
  return new BiographySynthesisService({
    memoryStore: input.memoryStore,
    profileStore: input.profileStore,
    llmClient: input.model.port,
    promptRegistry: null,
    targets: targetPort(input.targets),
    companionSubject: COMPANION_SUBJECT,
    candidatePolicy: () => POLICY,
    depthPolicy: () => createDefaultBiographicalDepthPolicy(),
    now: () => NOW,
    newRunId: () => input.runId ?? 'biography-synthesis:test-run',
  });
}

describe('BiographySynthesisService', () => {
  it('stages typed candidates from sources in different sessions without activating them', async () => {
    const memories = new InMemoryMemoryStore();
    // Two independent silos-in-time: different sessions and channels, one
    // canonical contact. Collection is subject-scoped, not session-scoped.
    memories.insertMemory(memory('mem-session-a', {
      text: 'They asked for short answers again today.',
      provenance: { subjectContactId: CONTACT_SUBJECT.contactId, channelId: 'channel-a' },
    }));
    memories.insertMemory(memory('mem-session-b', {
      type: 'episodic',
      text: 'In a different room they repeated the same request.',
      provenance: { subjectContactId: CONTACT_SUBJECT.contactId, channelId: 'channel-b' },
    }));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    const model = recordingModel([
      candidatesResponse([preferenceCandidate(['mem-session-a', 'mem-session-b'])]),
    ]);

    const telemetry = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model,
      targets: [CONTACT_TARGET],
    }).run();

    expect(telemetry.candidatesStaged).toBe(1);
    const staged = await profileStore.listCandidates({ limit: 10 });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.stage).toBe('automata_synthesis');
    expect(staged[0]?.socialContext).toEqual(CONTACT_TARGET.socialContext);
    expect(staged[0]?.rationale).toBe('new_subject_claim');
    // Evidence from two sessions coalesced into one candidate's source set.
    const claim = await profileStore.getClaim(staged[0]!.claimId);
    expect(claim?.status).toBe('candidate');
    expect(claim?.sources.map(source => source.ref).sort()).toEqual([
      'memory:mem-session-a',
      'memory:mem-session-b',
    ]);
    // Nothing was activated: the portable projection sees no active claim.
    expect(await profileStore.listClaims({ status: 'active' })).toHaveLength(0);
  });

  it('never lets an above-ceiling source reach the prompt, a candidate, or telemetry', async () => {
    const memories = new InMemoryMemoryStore();
    memories.insertMemory(memory('mem-admissible', {
      text: 'They prefer concise explanations.',
    }));
    memories.insertMemory(memory('mem-intimate', {
      text: 'SECRET-INTIMATE-BODY',
      sensitivity: 'intimate',
    }));
    memories.insertMemory(memory('mem-emotional-type', {
      type: 'emotional',
      text: 'SECRET-EMOTIONAL-BODY',
    }));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    // The synthesizer tries to cite the excluded sources anyway.
    const model = recordingModel([
      candidatesResponse([
        preferenceCandidate(['mem-admissible']),
        preferenceCandidate(['mem-intimate'], 'intimate detail'),
        preferenceCandidate(['mem-emotional-type'], 'emotional detail'),
      ]),
    ]);

    const telemetry = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model,
      targets: [CONTACT_TARGET],
    }).run();

    const prompt = model.prompts.join('\n');
    expect(prompt).toContain('mem-admissible');
    expect(prompt).not.toContain('SECRET-INTIMATE-BODY');
    expect(prompt).not.toContain('SECRET-EMOTIONAL-BODY');
    expect(prompt).not.toContain('mem-intimate');
    expect(prompt).not.toContain('mem-emotional-type');
    expect(telemetry.sourcesWithheldByPolicy).toBe(2);

    const staged = await profileStore.listCandidates({ limit: 10 });
    expect(staged).toHaveLength(1);
    const claim = await profileStore.getClaim(staged[0]!.claimId);
    expect(claim?.sources.map(source => source.ref)).toEqual(['memory:mem-admissible']);
    // Candidates citing an unavailable source are withheld, not admitted.
    expect(telemetry.candidatesWithheld).toBe(2);
    // Telemetry is content-free: no ref, id, or body of any excluded source.
    const serializedTelemetry = JSON.stringify(telemetry);
    expect(serializedTelemetry).not.toContain('mem-intimate');
    expect(serializedTelemetry).not.toContain('SECRET');
    expect(serializedTelemetry).not.toContain(CONTACT_SUBJECT.contactId);
  });

  it('keeps a companion silo out of a contact scan and a contact silo out of a self scan', async () => {
    const memories = new InMemoryMemoryStore();
    memories.insertMemory(companionMemory('mem-companion-private', {
      text: 'COMPANION-ONLY-BODY',
    }));
    memories.insertMemory(memory('mem-contact', { text: 'CONTACT-ONLY-BODY' }));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    const model = recordingModel([candidatesResponse([])]);

    await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model,
      targets: [CONTACT_TARGET],
    }).run();
    expect(model.prompts.join('\n')).toContain('CONTACT-ONLY-BODY');
    expect(model.prompts.join('\n')).not.toContain('COMPANION-ONLY-BODY');

    const selfModel = recordingModel([candidatesResponse([])]);
    await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: selfModel,
      targets: [COMPANION_TARGET],
    }).run();
    expect(selfModel.prompts.join('\n')).toContain('COMPANION-ONLY-BODY');
    expect(selfModel.prompts.join('\n')).not.toContain('CONTACT-ONLY-BODY');
  });

  it('is idempotent across a restart on unchanged sources', async () => {
    const memories = new InMemoryMemoryStore();
    memories.insertMemory(memory('mem-stable'));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    const response = candidatesResponse([preferenceCandidate(['mem-stable'])]);

    const first = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: recordingModel([response]),
      targets: [CONTACT_TARGET],
      runId: 'biography-synthesis:run-1',
    }).run();
    // A restart gives the pass a new run id. The durable stage cursor survives
    // it, so the unchanged silo is skipped before any model call: idempotence
    // is now free rather than paid for with a duplicate synthesis.
    const restartModel = recordingModel([response]);
    const second = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: restartModel,
      targets: [CONTACT_TARGET],
      runId: 'biography-synthesis:run-2',
    }).run();

    expect(first.candidatesStaged).toBe(1);
    expect(first.targetsUnchanged).toBe(0);
    expect(second.candidatesStaged).toBe(0);
    expect(second.targetsUnchanged).toBe(1);
    expect(second.outcome).toBe('complete');
    expect(restartModel.prompts).toEqual([]);
    expect(await profileStore.listCandidates({ limit: 10 })).toHaveLength(1);
  });

  it('re-opens a target whose admitted evidence changed, and yields at a safe boundary', async () => {
    const memories = new InMemoryMemoryStore();
    memories.insertMemory(memory('mem-stable'));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);
    const response = candidatesResponse([preferenceCandidate(['mem-stable'])]);
    await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: recordingModel([response]),
      targets: [CONTACT_TARGET],
      runId: 'biography-synthesis:run-1',
    }).run();

    // New admitted evidence changes the digest, so the cursor no longer holds.
    memories.insertMemory(memory('mem-new'));
    const changedModel = recordingModel([
      candidatesResponse([preferenceCandidate(['mem-stable', 'mem-new'])]),
    ]);
    const changed = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: changedModel,
      targets: [CONTACT_TARGET],
      runId: 'biography-synthesis:run-3',
    }).run();
    expect(changed.targetsUnchanged).toBe(0);
    expect(changedModel.prompts).toHaveLength(1);

    // A yield at the first safe boundary stops the pass with work remaining and
    // reports it, rather than silently dropping the untouched targets.
    const yielded = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: recordingModel([response, response]),
      targets: [CONTACT_TARGET, COMPANION_TARGET],
      runId: 'biography-synthesis:run-4',
    }).run({ onSafeBoundary: async () => 'yield' });
    expect(yielded.outcome).toBe('yield');
    expect(yielded.targetsRemaining).toBe(1);
  });

  it('supersedes rather than duplicates when the same claim recurs over drifted sources', async () => {
    const memories = new InMemoryMemoryStore();
    memories.insertMemory(memory('mem-first'));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);

    await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: recordingModel([candidatesResponse([preferenceCandidate(['mem-first'])])]),
      targets: [CONTACT_TARGET],
      runId: 'biography-synthesis:run-1',
    }).run();

    memories.insertMemory(memory('mem-second', { text: 'Same preference, said again.' }));
    const second = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: recordingModel([
        candidatesResponse([preferenceCandidate(['mem-first', 'mem-second'])]),
      ]),
      targets: [CONTACT_TARGET],
      runId: 'biography-synthesis:run-2',
    }).run();

    expect(second.candidatesSuperseded).toBe(1);
    const all = await profileStore.listCandidates({ limit: 10 });
    expect(all).toHaveLength(2);
    const superseded = all.find(record => record.stage === 'superseded');
    const open = all.find(record => record.stage === 'automata_synthesis');
    expect(superseded).toBeDefined();
    expect(open?.supersedesCandidateId).toBe(superseded?.id);
    expect(open?.rationale).toBe('recurring_evidence');
    // The predecessor's receipts survive: history is append-only.
    expect(superseded?.receipts.some(receipt => receipt.authority === 'automata')).toBe(true);
    expect(
      superseded?.receipts.some(receipt => receipt.reason === 'owner_policy_supersession'),
    ).toBe(true);
  });

  it('keeps contradicting readings of the same evidence as separate candidates', async () => {
    const memories = new InMemoryMemoryStore();
    memories.insertMemory(memory('mem-ambiguous'));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);

    const telemetry = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: recordingModel([candidatesResponse([
        preferenceCandidate(['mem-ambiguous'], 'concise explanations'),
        {
          ...preferenceCandidate(['mem-ambiguous'], 'concise explanations'),
          value: {
            kind: 'stable-preference',
            schemaVersion: 1,
            domain: 'communication',
            target: 'concise explanations',
            polarity: 'avoids',
          },
        },
      ])]),
      targets: [CONTACT_TARGET],
    }).run();

    expect(telemetry.candidatesStaged).toBe(2);
    const staged = await profileStore.listCandidates({ limit: 10 });
    expect(new Set(staged.map(record => record.claimDigest)).size).toBe(2);
    expect(staged.every(record => record.stage === 'automata_synthesis')).toBe(true);
  });

  it('refuses a dyadic kind in a companion self scan', async () => {
    const memories = new InMemoryMemoryStore();
    memories.insertMemory(companionMemory('mem-self'));
    const profileStore = new InMemoryBiographicalProfileStore(() => NOW);

    const telemetry = await buildService({
      memoryStore: memories.asPort(),
      profileStore,
      model: recordingModel([candidatesResponse([{
        kind: 'relationship',
        value: { kind: 'relationship', relationshipType: 'friend' },
        basis: 'explicit',
        confidence: 0.9,
        sourceMemoryIds: ['mem-self'],
      }])]),
      targets: [COMPANION_TARGET],
    }).run();

    expect(telemetry.candidatesStaged).toBe(0);
    expect(telemetry.candidatesWithheld).toBe(1);
    expect(await profileStore.listCandidates({ limit: 10 })).toHaveLength(0);
  });
});
