import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateCogSecDocumentProof,
  validateHubIdentityProof,
  validatePersistedProof,
  validateSituatedPresenceProof,
  validateSseTurnProof,
  validateTemporalProof,
} from '../lib/persisted-proofs.mjs';

function turnRecord(overrides = {}) {
  return {
    status: 'completed',
    location: { placeId: 'living_room', satelliteId: 'sat-living-room' },
    userMessage: { content: 'fixture user message' },
    assistantMessage: { content: 'hello from the room' },
    toolCalls: [],
    observability: {
      stages: [
        {
          stage: 'first-token',
          elapsedMs: 12,
          data: { source: 'stream', ttftMs: 12 },
        },
      ],
      snapshot: {
        plan: {
          messages: [{
            role: 'user',
            content: '[Fri 07-17-26 11:59] earlier persisted history',
          }],
        },
        promptContext: {
          response: {
            content: '[Fri 07-17-26 12:00] hello from the room',
          },
          runtimeContextSections: [
            {
              id: 'runtime_situated_presence',
              content: [
                '<runtime_situated_presence>',
                '[Situated presence]',
                'Here: Living Room (physical place)',
                'Perceivers here (what can sense this place):',
                '- Living Room Presence (presence, perceiver)',
                '</runtime_situated_presence>',
              ].join('\n'),
            },
          ],
          finalSystemSections: [
            {
              id: 'runtime.current_datetime',
              content: '<runtime.current_datetime><iso>2026-07-17T12:00:00-04:00</iso></runtime.current_datetime>',
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

test('situated-presence proof requires the exact persisted section and physical binding', () => {
  assert.deepEqual(validateSituatedPresenceProof({
    turnRecord: turnRecord(),
    expected: {
      mode: 'physical',
      placeId: 'living_room',
      placeLabel: 'Living Room',
      affordanceLabel: 'Living Room Presence',
    },
  }), []);

  const absent = turnRecord({
    observability: {
      snapshot: {
        promptContext: {
          runtimeContextSections: [],
          finalSystemSections: [],
        },
      },
    },
  });
  assert.match(
    validateSituatedPresenceProof({
      turnRecord: absent,
      expected: { mode: 'physical', placeId: 'living_room' },
    }).join('\n'),
    /runtime_situated_presence/u,
  );

  const wrongSection = turnRecord({
    observability: {
      snapshot: {
        promptContext: {
          runtimeContextSections: [{ id: 'runtime_somewhere_else', content: 'Living Room' }],
          finalSystemSections: [],
        },
      },
    },
  });
  assert.match(
    validateSituatedPresenceProof({
      turnRecord: wrongSection,
      expected: { mode: 'physical', placeId: 'living_room' },
    }).join('\n'),
    /runtime_situated_presence/u,
  );
});

test('placeless and shared-mindspace proofs fail closed in opposite directions', () => {
  assert.deepEqual(validateSituatedPresenceProof({
    turnRecord: turnRecord({
      location: undefined,
      observability: {
        stages: [],
        snapshot: {
          promptContext: {
            runtimeContextSections: [],
            finalSystemSections: [],
          },
        },
      },
    }),
    expected: { mode: 'placeless' },
  }), []);

  const mindspace = turnRecord({
    location: undefined,
    observability: {
      stages: [],
      snapshot: {
        promptContext: {
          runtimeContextSections: [{
            id: 'runtime_situated_presence',
            content: [
              '<runtime_situated_presence>',
              'Here: Living Room (Twin) (virtual place)',
              'Shared mindspace: Our Shared Room (virtual twin of Living Room)',
              '</runtime_situated_presence>',
            ].join('\n'),
          }],
          finalSystemSections: [],
        },
      },
    },
  });
  assert.deepEqual(validateSituatedPresenceProof({
    turnRecord: mindspace,
    expected: {
      mode: 'mindspace',
      placeId: 'living_room_twin',
      mirrorsPlaceId: 'living_room',
      placesRegistry: {
        places: [
          { placeId: 'living_room', displayName: 'Living Room', kind: 'physical' },
          {
            placeId: 'living_room_twin',
            displayName: 'Living Room (Twin)',
            kind: 'virtual',
            mirrorsPlaceId: 'living_room',
          },
        ],
      },
    },
  }), []);

  assert.match(
    validateSituatedPresenceProof({
      turnRecord: mindspace,
      expected: { mode: 'placeless' },
    }).join('\n'),
    /must not persist/u,
  );
});

test('CogSec proof requires quarantine plus session envelope and rejects memory/appraisal leakage', () => {
  const proof = {
    quarantine: {
      found: true,
      status: 'held',
      envelopeState: 'quarantined',
      rawSha256: 'a'.repeat(64),
    },
    session: {
      found: true,
      withheld: true,
      envelopeState: 'quarantined',
      fixedNoticePresent: true,
    },
    gardenQueue: {
      found: true,
      status: 'held',
      contentSha256Matches: true,
    },
    resolution: {
      action: 'discard',
      confirmed: true,
      applied: true,
    },
    backgroundJobs: [
      { kind: 'emotion_appraisal', state: 'succeeded', reasonCode: 'completed' },
      { kind: 'memory_extraction', state: 'succeeded', reasonCode: 'completed' },
    ],
    memoryLeakCount: 0,
    appraisalLeakCount: 0,
  };
  assert.deepEqual(validateCogSecDocumentProof({ sideChecks: { cogsec: proof } }), []);

  assert.match(
    validateCogSecDocumentProof({
      sideChecks: { cogsec: { ...proof, quarantine: { found: false } } },
    }).join('\n'),
    /quarantine/u,
  );
  assert.match(
    validateCogSecDocumentProof({
      sideChecks: { cogsec: { ...proof, memoryLeakCount: 1 } },
    }).join('\n'),
    /memory/u,
  );
  assert.match(
    validateCogSecDocumentProof({
      sideChecks: { cogsec: { ...proof, appraisalLeakCount: 1 } },
    }).join('\n'),
    /appraisal/u,
  );
  assert.match(
    validateCogSecDocumentProof({
      sideChecks: {
        cogsec: {
          ...proof,
          backgroundJobs: [{ kind: 'memory_extraction', state: 'queued' }],
        },
      },
    }).join('\n'),
    /background proof/u,
  );
});

test('hub proof binds the enrolled contact to accepted face telemetry and a moved place', () => {
  const sideChecks = {
    hubIdentity: {
      expected: {
        hubIdentityId: 'opaque-hub-1',
        contactId: 'contact-primary',
        placeId: 'kitchen',
        restorePlaceId: 'living_room',
        priorPlaceId: 'living_room',
        requireSharedPresence: true,
      },
      enrollment: {
        hubIdentityId: 'opaque-hub-1',
        contactId: 'contact-primary',
        status: 'enrolled',
      },
      enrollmentAudit: { action: 'enroll' },
      telemetry: { status: 202, eventId: 'event-1', gardenAuditFound: true },
      internalState: { placeId: 'kitchen' },
      presence: { placeId: 'kitchen' },
      cleanup: { revoked: true, restoredPlaceId: 'living_room' },
    },
  };
  assert.deepEqual(validateHubIdentityProof({
    turnRecord: turnRecord(),
    sideChecks,
  }), []);

  sideChecks.hubIdentity.presence.placeId = 'living_room';
  assert.match(
    validateHubIdentityProof({ turnRecord: turnRecord(), sideChecks }).join('\n'),
    /companion_presence/u,
  );
});

test('temporal and SSE proofs require persisted clock/first-token evidence and stripped output', () => {
  assert.deepEqual(validateTemporalProof({ turnRecord: turnRecord() }), []);
  assert.deepEqual(validateSseTurnProof({
    turnRecord: turnRecord(),
    sideChecks: {
      sse: {
        parseErrors: [],
        firstContentAtMs: 10,
        terminalAtMs: 20,
        firstContent: 'hello',
        contentText: 'hello from the room',
      },
    },
  }), []);

  const noDatetime = turnRecord();
  noDatetime.observability.snapshot.promptContext.finalSystemSections = [];
  assert.match(validateTemporalProof({ turnRecord: noDatetime }).join('\n'), /current_datetime/u);

  const stamped = turnRecord({
    assistantMessage: { content: '[Fri 07-17-26 12:00] leaked stamp' },
  });
  assert.match(validateTemporalProof({ turnRecord: stamped }).join('\n'), /history stamp/u);

  const noRenderedHistory = turnRecord();
  noRenderedHistory.observability.snapshot.plan.messages = [];
  assert.match(
    validateTemporalProof({ turnRecord: noRenderedHistory }).join('\n'),
    /rendered history stamp/u,
  );

  const noRawStampedResponse = turnRecord();
  noRawStampedResponse.observability.snapshot.promptContext.response.content = 'unstamped draft';
  assert.match(
    validateTemporalProof({ turnRecord: noRawStampedResponse }).join('\n'),
    /strip guard/u,
  );

  const noFirstToken = turnRecord();
  noFirstToken.observability.stages = [];
  assert.match(validateSseTurnProof({
    turnRecord: noFirstToken,
    sideChecks: {
      sse: {
        parseErrors: [],
        firstContentAtMs: null,
        terminalAtMs: 20,
        firstContent: '',
        contentText: '',
      },
    },
  }).join('\n'), /first non-empty/u);
});

test('persisted proof validation runs independently of narration or action sensitivity', async () => {
  let calls = 0;
  const failures = await validatePersistedProof({
    id: 'fixture',
    proof: { source: 'turn_record' },
    validatePersistedProof: () => {
      calls += 1;
      return ['missing durable row'];
    },
  }, {
    parsedAssistant: null,
    assistantText: '',
    seenToolNames: [],
  });
  assert.equal(calls, 1);
  assert.deepEqual(failures, ['missing durable row']);
});
