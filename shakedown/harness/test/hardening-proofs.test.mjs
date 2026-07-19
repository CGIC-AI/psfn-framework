import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOwnerSlots,
  validateBackupEncryptionRoundTripProof,
  validateBackgroundModelDriveProof,
  validateModelLaneAttributionProof,
} from '../lib/hardening-proofs.mjs';

function modelsConfig() {
  return {
    schemaVersion: 1,
    models: [
      {
        id: 'primary',
        identity: { provider: 'openrouter', model: 'z-ai/glm-5' },
        purposes: [
          { purpose: 'chat', primary: true },
        ],
      },
      {
        id: 'vision',
        identity: { provider: 'google', model: 'google/gemini-flash-lite' },
        purposes: [
          { purpose: 'vision', primary: true },
        ],
      },
      {
        id: 'extraction',
        identity: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' },
        purposes: [
          { purpose: 'background', primary: true },
          { purpose: 'extraction', primary: true },
        ],
      },
    ],
  };
}

function ledgerRows() {
  return [
    {
      slot_key: 'primary',
      provider: 'openrouter',
      model: 'z-ai/glm-5',
      charge_lane: 'interactive',
      charge_surface: 'moaRoundBase',
      purpose: 'chat',
    },
    {
      slot_key: 'extraction',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v3.2',
      charge_lane: 'background',
      charge_surface: 'memoryWrite',
      purpose: 'background',
    },
  ];
}

test('owner-slot resolution mirrors models.json id -> identity model/provider and primary purposes', () => {
  const { slotCatalog, purposePrimary, failures } = resolveOwnerSlots(modelsConfig());
  assert.deepEqual(failures, []);
  assert.deepEqual(slotCatalog.primary, { model: 'z-ai/glm-5', provider: 'openrouter' });
  assert.deepEqual(slotCatalog.vision, {
    model: 'google/gemini-flash-lite',
    provider: 'google',
  });
  assert.equal(purposePrimary.chat, 'primary');
  assert.equal(purposePrimary.vision, 'vision');
  assert.equal(purposePrimary.background, 'extraction');

  assert.match(
    resolveOwnerSlots({ models: [] }).failures.join('\n'),
    /no models/u,
  );
  assert.match(
    resolveOwnerSlots({
      models: [
        { id: 'a', identity: { provider: 'p', model: 'm' }, purposes: [{ purpose: 'chat', primary: true }] },
        { id: 'b', identity: { provider: 'p', model: 'n' }, purposes: [{ purpose: 'chat', primary: true }] },
      ],
    }).failures.join('\n'),
    /two primary slots for purpose chat/u,
  );
});

test('model-lane attribution passes when every charged lane resolves to its owner slot', () => {
  assert.deepEqual(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: ledgerRows(),
      laneExpectations: [{ lane: 'interactive', purpose: 'chat' }],
    }),
    [],
  );
});

test('model-lane attribution covers the interactive and background lanes together (osln)', () => {
  assert.deepEqual(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: ledgerRows(),
      laneExpectations: [
        { lane: 'interactive', purpose: 'chat' },
        { lane: 'background', purpose: 'background' },
      ],
    }),
    [],
  );
});

test('model-lane attribution fails when the background lane routes to a non-owner model', () => {
  const rows = ledgerRows();
  // The background appraisal row is charged the chat slot's model — a routing bug.
  rows[1].model = 'z-ai/glm-5';
  rows[1].slot_key = 'primary';
  const failures = validateModelLaneAttributionProof({
    modelsConfig: modelsConfig(),
    ledgerRows: rows,
    laneExpectations: [{ lane: 'background', purpose: 'background' }],
  });
  assert.match(
    failures.join('\n'),
    /background lane routed to model z-ai\/glm-5 but the background owner slot resolves to deepseek\/deepseek-v3\.2/u,
  );
});

test('model-lane attribution can scope an expectation to a single turn_id', () => {
  const rows = ledgerRows();
  rows[0].turn_id = 'turn-interactive';
  rows[1].turn_id = 'turn-background';
  // Turn-scoped interactive attribution: only the named turn's row is checked.
  assert.deepEqual(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: rows,
      laneExpectations: [{ turnId: 'turn-interactive', purpose: 'chat' }],
    }),
    [],
  );
  // A turn with no matching ledger row fails closed.
  assert.match(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: rows,
      laneExpectations: [{ turnId: 'turn-missing', purpose: 'chat' }],
    }).join('\n'),
    /spend ledger has no turn turn-missing row/u,
  );
  // A turn-scoped model drift fails closed and names the turn.
  const drift = ledgerRows();
  drift[0].turn_id = 'turn-interactive';
  drift[0].model = 'z-ai/glm-5.1';
  assert.match(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: drift,
      laneExpectations: [{ turnId: 'turn-interactive', purpose: 'chat' }],
    }).join('\n'),
    /turn turn-interactive routed to model z-ai\/glm-5\.1 but the chat owner slot resolves to z-ai\/glm-5/u,
  );
});

test('model-lane attribution intersects lane and turn scopes for background proof', () => {
  const rows = ledgerRows();
  rows[0].turn_id = 'turn-appraisal';
  rows[1].turn_id = 'turn-appraisal';
  assert.deepEqual(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: rows,
      laneExpectations: [
        { lane: 'background', turnId: 'turn-appraisal', purpose: 'background' },
      ],
    }),
    [],
    'the foreground row for the same source turn is excluded from the background expectation',
  );
});

test('background model drive proof requires the case-owned appraisal to succeed and land usage', () => {
  assert.deepEqual(
    validateBackgroundModelDriveProof({
      backgroundJobState: 'succeeded',
      backgroundTurnId: 'turn-appraisal',
      backgroundObserved: true,
    }),
    [],
  );
  assert.match(
    validateBackgroundModelDriveProof({
      backgroundJobState: 'failed',
      backgroundTurnId: 'turn-appraisal',
      backgroundObserved: true,
    }).join('\n'),
    /did not succeed/u,
  );
  assert.match(
    validateBackgroundModelDriveProof({
      backgroundJobState: 'succeeded',
      backgroundTurnId: null,
      backgroundObserved: true,
    }).join('\n'),
    /source turn is missing/u,
  );
  assert.match(
    validateBackgroundModelDriveProof({
      backgroundJobState: 'succeeded',
      backgroundTurnId: 'turn-appraisal',
      backgroundObserved: false,
    }).join('\n'),
    /no model-usage row/u,
  );
});

test('model-lane attribution attributes the inline-vision turn against the vision owner slot', () => {
  const rows = ledgerRows();
  rows[0].turn_id = 'turn-chat';
  // The inline-image foreground turn: an interactive-lane row on the primary
  // slot. Its `purpose` COLUMN is the correlation stage string 'agent.turn.prompt'
  // (never 'vision') — the expectation's purpose only resolves the OWNER slot.
  const visionRow = {
    slot_key: 'vision',
    provider: 'google',
    model: 'google/gemini-flash-lite',
    charge_lane: 'interactive',
    charge_surface: 'moaRoundBase',
    purpose: 'agent.turn.prompt',
    turn_id: 'turn-vision',
  };
  assert.deepEqual(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: [...rows, visionRow],
      laneExpectations: [{ turnId: 'turn-vision', purpose: 'vision' }],
    }),
    [],
  );
  // No ledger row for the inline-image turn → the proof fails closed.
  assert.match(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: rows,
      laneExpectations: [{ turnId: 'turn-vision', purpose: 'vision' }],
    }).join('\n'),
    /spend ledger has no turn turn-vision row to attribute against the vision owner slot/u,
  );
  // The vision turn routed to a non-owner model → fails closed and names the turn.
  const drift = { ...visionRow, model: 'deepseek/deepseek-v3.2', slot_key: 'extraction' };
  assert.match(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: [...rows, drift],
      laneExpectations: [{ turnId: 'turn-vision', purpose: 'vision' }],
    }).join('\n'),
    /turn turn-vision routed to model deepseek\/deepseek-v3\.2 but the vision owner slot resolves to google\/gemini-flash-lite/u,
  );
  // A null turnId (the harness never recovered the vision turn record) → fails closed.
  assert.match(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: [...rows, visionRow],
      laneExpectations: [{ turnId: null, purpose: 'vision' }],
    }).join('\n'),
    /must name a purpose and either a lane or a turnId/u,
  );
});

test('model-lane attribution rejects an expectation with neither a lane nor a turnId', () => {
  assert.match(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: ledgerRows(),
      laneExpectations: [{ purpose: 'chat' }],
    }).join('\n'),
    /must name a purpose and either a lane or a turnId/u,
  );
});

test('model-lane attribution fails closed on empty ledger, unknown slot, and model drift', () => {
  assert.match(
    validateModelLaneAttributionProof({ modelsConfig: modelsConfig(), ledgerRows: [] }).join('\n'),
    /no model_usage_events rows/u,
  );

  const unknownSlot = ledgerRows();
  unknownSlot[0].slot_key = 'ghost';
  assert.match(
    validateModelLaneAttributionProof({ modelsConfig: modelsConfig(), ledgerRows: unknownSlot }).join('\n'),
    /not a canonical models\.json owner slot/u,
  );

  const drift = ledgerRows();
  drift[0].model = 'z-ai/glm-5.1';
  assert.match(
    validateModelLaneAttributionProof({ modelsConfig: modelsConfig(), ledgerRows: drift }).join('\n'),
    /charged model z-ai\/glm-5\.1 but models\.json assigns z-ai\/glm-5/u,
  );

  const badLane = ledgerRows();
  badLane[0].charge_lane = 'made_up_lane';
  assert.match(
    validateModelLaneAttributionProof({ modelsConfig: modelsConfig(), ledgerRows: badLane }).join('\n'),
    /not a canonical runtime lane/u,
  );
});

test('model-lane attribution fails when a lane is not routed to its config-resolved tier model', () => {
  const rows = ledgerRows();
  // The interactive lane row is charged the background slot's model — a routing bug.
  rows[0].model = 'deepseek/deepseek-v3.2';
  rows[0].slot_key = 'extraction';
  const failures = validateModelLaneAttributionProof({
    modelsConfig: modelsConfig(),
    ledgerRows: rows,
    laneExpectations: [{ lane: 'interactive', purpose: 'chat' }],
  });
  assert.match(failures.join('\n'), /interactive lane routed to model deepseek\/deepseek-v3\.2 but the chat owner slot resolves to z-ai\/glm-5/u);

  // A purpose with no primary owner slot is a fail-closed config gap.
  assert.match(
    validateModelLaneAttributionProof({
      modelsConfig: modelsConfig(),
      ledgerRows: ledgerRows(),
      laneExpectations: [{ lane: 'maintenance', purpose: 'summary' }],
    }).join('\n'),
    /no primary owner slot for purpose summary/u,
  );
});

// A passing backup round-trip: a full-payload save landed the benign scalar flip
// on disk with the encryption block intact, the original was restored, and the
// encryption-stripped payload was rejected without touching backup.json.
function backupRoundTrip() {
  const encryption = { mode: 'required', keyRef: { kind: 'env', envName: 'PSFN_BACKUP_ENCRYPTION_KEY' } };
  const base = {
    intervalHours: 6,
    maxRotatingBackups: 5,
    maxWeeklyBackups: 4,
    maxMonthlyBackups: 12,
    mirrorDir: '',
    verifyRestore: true,
    encryption,
  };
  return {
    field: 'maxMonthlyBackups',
    flipFrom: 12,
    flipTo: 13,
    before: { ...base },
    afterWrite: { ...base, maxMonthlyBackups: 13 },
    afterRestore: { ...base },
    afterReject: { ...base },
    save: { ok: true, status: 200 },
    restore: { ok: true, status: 200 },
    reject: { ok: false, status: 400 },
  };
}

test('backup round-trip passes when the real save lands, encryption survives, and the stripped payload is rejected', () => {
  assert.deepEqual(validateBackupEncryptionRoundTripProof(backupRoundTrip()), []);
});

test('backup round-trip fails closed on a missing precondition, failed save, or unlanded write', () => {
  // Precondition: the pre-save snapshot must carry an encryption block.
  const noBlock = backupRoundTrip();
  delete noBlock.before.encryption;
  assert.match(validateBackupEncryptionRoundTripProof(noBlock).join('\n'), /precondition not met/u);

  // The positive save must succeed.
  const failedSave = backupRoundTrip();
  failedSave.save = { ok: false, status: 500 };
  assert.match(validateBackupEncryptionRoundTripProof(failedSave).join('\n'), /did not succeed/u);

  // The flipped scalar must actually change on disk (no-op 2xx fails closed).
  const noLand = backupRoundTrip();
  noLand.afterWrite = { ...noLand.before };
  assert.match(validateBackupEncryptionRoundTripProof(noLand).join('\n'), /did not land/u);
});

test('backup round-trip fails closed when the real save strips or mutates the encryption block', () => {
  const stripped = backupRoundTrip();
  delete stripped.afterWrite.encryption;
  assert.match(
    validateBackupEncryptionRoundTripProof(stripped).join('\n'),
    /stripped the mandatory backup\.json encryption block/u,
  );

  const mutated = backupRoundTrip();
  mutated.afterWrite = { ...mutated.afterWrite, encryption: { mode: 'disabled', keyRef: mutated.before.encryption.keyRef } };
  assert.match(
    validateBackupEncryptionRoundTripProof(mutated).join('\n'),
    /mutated the backup\.json encryption block/u,
  );

  const keyRefDrift = backupRoundTrip();
  keyRefDrift.afterWrite = { ...keyRefDrift.afterWrite, encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'OTHER_KEY' } } };
  assert.match(
    validateBackupEncryptionRoundTripProof(keyRefDrift).join('\n'),
    /mutated the backup\.json encryption block/u,
  );
});

test('backup round-trip fails closed when the original is not restored', () => {
  const notRestored = backupRoundTrip();
  notRestored.afterRestore = { ...notRestored.afterRestore, maxMonthlyBackups: 13 };
  notRestored.afterReject = { ...notRestored.afterRestore };
  assert.match(validateBackupEncryptionRoundTripProof(notRestored).join('\n'), /was not restored/u);
});

test('backup round-trip fails closed when the encryption-stripped payload is NOT rejected or touches disk', () => {
  // The guard is missing: the stripped payload was accepted.
  const accepted = backupRoundTrip();
  accepted.reject = { ok: true, status: 200 };
  assert.match(
    validateBackupEncryptionRoundTripProof(accepted).join('\n'),
    /was NOT rejected .* the fail-closed guard is missing/u,
  );

  // The reject nonetheless mutated backup.json on disk — not fail-closed.
  const dirtyReject = backupRoundTrip();
  dirtyReject.afterReject = { ...dirtyReject.afterReject, maxMonthlyBackups: 99 };
  assert.match(
    validateBackupEncryptionRoundTripProof(dirtyReject).join('\n'),
    /changed backup\.json on disk — the reject was not fail-closed/u,
  );
});
