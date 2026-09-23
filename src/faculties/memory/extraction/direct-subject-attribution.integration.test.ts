import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { SessionEntry } from '../../../core/session/types.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { createDefaultBiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { collectAuthorizedBiographicalSources } from '../biographical/authorized-sources.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import type { PurrMemory } from '../types.js';
import { renderExtractionChunkPrompt } from './llm-pass.js';
import { parseFactsXml } from './parser.js';
import { buildSpeakerRoutingContext, resolveFactRouting } from './speaker-routing.js';
import { buildExtractionFactRoutingTelemetry } from './write-execution.js';

const CONTACT_ID = 'contact-morgan';
const ENTRY: SessionEntry = {
  id: 12,
  channelId: 'discord:dm:invented',
  role: 'user',
  authorId: 'transport-morgan',
  authorName: 'Morgan',
  content: 'I collect model trains.',
  timestamp: 1_000,
};
const BASE_FACT = `<text>Morgan collects model trains.</text>
<type>semantic</type><importance>0.9</importance><confidence>0.95</confidence>
<sensitivity>personal</sensitivity>`;
const SOURCE = '<source_message_ids>12</source_message_ids><source_speaker_name>Morgan</source_speaker_name>';

let harness: PostgresTestHarness | undefined;
let pool: Pool | undefined;
let memoryStore: MemoryStorePort;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
  const database = await harness.createDatabase();
  pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'dm-subject-attribution-test', allowExitOnIdle: true, max: 4,
  });
  memoryStore = await createPostgresMemoryStoreFromPool(pool, 4);
});

afterAll(async () => {
  await pool?.end();
  await harness?.stop();
});

async function routeFact(attribution: string, entries: SessionEntry[] = [ENTRY]) {
  const fact = parseFactsXml(`<response><fact>${BASE_FACT}${attribution}</fact></response>`)[0]!;
  const context = await buildSpeakerRoutingContext(entries, async speaker => (
    speaker.authorId === ENTRY.authorId ? CONTACT_ID : 'contact-other'
  ));
  const route = resolveFactRouting(fact, context, CONTACT_ID);
  return { fact, route };
}

async function persistFact(id: string, attribution: string) {
  const { fact, route } = await routeFact(attribution);
  if (route.status !== 'route') throw new Error(`Fact was rejected: ${route.reason}`);
  const memory: PurrMemory = {
    id, text: fact.text, type: fact.type, importance: fact.importance,
    confidence: fact.confidence, emotionalValence: fact.emotionalValence,
    tags: fact.tags, sensitivity: 'personal', consentFlags: {},
    salience: 0.8, sourceRef: 'turn:invented', sourceType: 'turn',
    extractedAt: 1_000, lastAccessed: 1_000, accessCount: 0,
    contactId: route.contactId,
    provenance: {
      channelId: ENTRY.channelId,
      ...buildExtractionFactRoutingTelemetry(route, CONTACT_ID),
    },
  };
  await memoryStore.insertMemory(memory, new Float32Array([1, 0, 0, 0]));
  return await memoryStore.getMemorySubjectClassification(id);
}

async function biographySources(contactId = CONTACT_ID) {
  return await collectAuthorizedBiographicalSources({
    memoryStore,
    subject: { kind: 'contact', contactId, subjectVersion: 1 },
    policy: createDefaultBiographicalCandidatePolicy(),
    scanLimit: 10,
  });
}

describe('DM extraction subject attribution (mg8x3)', () => {
  it('requests same-speaker subject evidence even with an older configured extraction prompt', () => {
    const prompt = renderExtractionChunkPrompt([ENTRY], {
      extractionPrompt: 'Configured prompt: extract durable facts.\n{recent_messages}',
      existingFacts: '(none)', participantNames: {}, characterName: 'Companion',
      experientialCompanionName: undefined, personaPreamble: null,
    });
    expect(prompt).toContain('including when the subject is the source speaker');
    expect(prompt).toContain('source_message_ids');
    expect(prompt).toContain('subject_name');
    expect(prompt).toContain('Never invent a subject_contact_id');
  });

  it('persists explicit DM subject evidence and admits only that subject to biography collection', async () => {
    expect(await persistFact('dm-explicit', `${SOURCE}<subject_name>Morgan</subject_name>`))
      .toMatchObject({ subjectClass: 'single_contact', subjectContactIds: [CONTACT_ID] });
    const sources = await biographySources();
    expect(sources.evidence.map(entry => entry.memory.id)).toContain('dm-explicit');
    expect((await biographySources('contact-other')).evidence).toEqual([]);
  });

  it.each([
    ['no attribution', ''],
    ['source only', SOURCE],
    ['subject without source evidence', '<subject_name>Morgan</subject_name>'],
  ])('keeps an ownership-only fact unattributed: %s', async (label, attribution) => {
    const id = `unattributed-${label}`;
    expect(await persistFact(id, attribution)).toMatchObject({
      subjectClass: 'unattributed', subjectContactIds: [], evidence: ['no_subject_evidence'],
    });
    expect((await biographySources()).evidence.map(entry => entry.memory.id)).not.toContain(id);
  });

  it.each([
    ['conflicting ID', `${SOURCE}<subject_name>Morgan</subject_name><subject_contact_id>contact-other</subject_contact_id>`],
    ['unknown ID', `${SOURCE}<subject_name>Morgan</subject_name><subject_contact_id>contact-unknown</subject_contact_id>`],
    ['conflicting name', `${SOURCE}<subject_name>Someone Else</subject_name><subject_contact_id>${CONTACT_ID}</subject_contact_id>`],
    ['unsupported third party', `${SOURCE}<subject_name>Someone Else</subject_name>`],
    ['missing source message', '<source_message_ids>99</source_message_ids><subject_name>Morgan</subject_name>'],
    ['conflicting source speaker', '<source_message_ids>12</source_message_ids><source_speaker_name>Someone Else</source_speaker_name><subject_name>Morgan</subject_name>'],
  ])('rejects a subject claim with %s', async (_label, attribution) => {
    expect((await routeFact(attribution)).route.status).toBe('skip');
  });

  it('rejects ambiguous subject names even when a supplied ID picks one speaker', async () => {
    const { route } = await routeFact(
      `${SOURCE}<subject_name>Morgan</subject_name><subject_contact_id>${CONTACT_ID}</subject_contact_id>`,
      [ENTRY, { ...ENTRY, id: 13, authorId: 'transport-other' }],
    );
    expect(route.status).toBe('skip');
  });
});
