import { describe, expect, it } from 'vitest';

import { parseAutomataBusEvent, type AutomataBusFindingEvent } from './contract.js';

/**
 * Red-team schema fixtures (psfn-framework-mgdks.3): the Bus carries process
 * findings and governed artifact references, never people. Payloads shaped as
 * biography, raw memory, private transcripts, or inline artifact bodies must be
 * rejected by the canonical parser at every nesting level, not filtered later.
 */
const BASE: AutomataBusFindingEvent = {
  schemaVersion: 1,
  eventId: 'event-privacy',
  companionId: 'companion-a',
  sequence: 1,
  occurredAt: '2026-09-24T00:00:00.000Z',
  mustUnderstand: [],
  type: 'finding',
  context: {
    automatonClass: 'subagent.bounded',
    runId: 'run-1',
    taskId: 'task-1',
    sessionIds: [],
    artifactRefs: ['artifact:report'],
  },
  body: {
    claim: 'The build cache must be cleared after a lockfile change.',
    provenance: 'computed',
    evidence: [{ kind: 'artifact', reference: 'artifact:report', summary: 'Build log digest' }],
    verification: { status: 'pending' },
  },
};

type Mutation = (event: Record<string, unknown>) => void;

function mutate(apply: Mutation): unknown {
  const event = structuredClone(BASE) as unknown as Record<string, unknown>;
  apply(event);
  return event;
}

function body(event: Record<string, unknown>): Record<string, unknown> {
  return event.body as Record<string, unknown>;
}

const RED_TEAM: Array<[string, Mutation]> = [
  ['biography on the finding body', event => { body(event).biography = 'Partner grew up in a coastal town.'; }],
  ['companion biography on the finding body', event => { body(event).companionBiography = 'I was named after a star.'; }],
  ['raw memory text on the finding body', event => { body(event).memoryText = 'User said they feel lonely at night.'; }],
  ['private transcript on the finding body', event => { body(event).transcript = [{ role: 'user', content: 'hi' }]; }],
  ['transcript on the event context', event => {
    (event.context as Record<string, unknown>).transcript = 'user: my address is ...';
  }],
  ['person identity on the event context', event => {
    (event.context as Record<string, unknown>).contactId = 'contact:partner';
  }],
  ['inline artifact body on evidence', event => {
    ((body(event).evidence as Array<Record<string, unknown>>)[0]!).body = 'full private report text';
  }],
  ['raw memory on verification', event => {
    (body(event).verification as Record<string, unknown>).memory = 'raw L2 row';
  }],
  ['ungoverned top-level payload', event => { event.payload = { memories: ['raw'] }; }],
];

describe('Automata Bus privacy schema', () => {
  it('accepts the governed process-finding shape', () => {
    expect(parseAutomataBusEvent(structuredClone(BASE)).status).toBe('accepted');
  });

  it.each(RED_TEAM)('rejects %s', (_label, apply) => {
    const parsed = parseAutomataBusEvent(mutate(apply));
    expect(parsed.status).not.toBe('accepted');
  });

  it('rejects an evidence kind outside the governed reference vocabulary', () => {
    const parsed = parseAutomataBusEvent(mutate(event => {
      ((body(event).evidence as Array<Record<string, unknown>>)[0]!).kind = 'memory';
    }));
    expect(parsed.status).not.toBe('accepted');
  });
});
