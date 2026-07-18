import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOwnerSlots,
  validateBackupEncryptionRoundTripProof,
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
  assert.equal(purposePrimary.chat, 'primary');
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

test('backup encryption round-trip proves the mandatory block survives a settings save', () => {
  const before = { encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'PSFN_BACKUP_ENCRYPTION_KEY' } } };
  const after = { encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'PSFN_BACKUP_ENCRYPTION_KEY' } } };
  assert.deepEqual(
    validateBackupEncryptionRoundTripProof({ before, after, save: { ok: true, status: 200 } }),
    [],
  );
});

test('backup encryption round-trip fails closed when the save strips or mutates the block', () => {
  const before = { encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'PSFN_BACKUP_ENCRYPTION_KEY' } } };

  assert.match(
    validateBackupEncryptionRoundTripProof({
      before,
      after: { intervalHours: 12 },
      save: { ok: true, status: 200 },
    }).join('\n'),
    /stripped the mandatory backup\.json encryption block/u,
  );

  assert.match(
    validateBackupEncryptionRoundTripProof({
      before: { intervalHours: 12 },
      after: before,
      save: { ok: true, status: 200 },
    }).join('\n'),
    /precondition not met/u,
  );

  assert.match(
    validateBackupEncryptionRoundTripProof({
      before,
      after: before,
      save: { ok: false, status: 500 },
    }).join('\n'),
    /did not succeed/u,
  );

  assert.match(
    validateBackupEncryptionRoundTripProof({
      before,
      after: { encryption: { mode: 'disabled', keyRef: before.encryption.keyRef } },
      save: { ok: true, status: 200 },
    }).join('\n'),
    /changed backup\.json encryption\.mode from required to disabled/u,
  );

  assert.match(
    validateBackupEncryptionRoundTripProof({
      before,
      after: { encryption: { mode: 'required', keyRef: { kind: 'env', envName: 'OTHER_KEY' } } },
      save: { ok: true, status: 200 },
    }).join('\n'),
    /mutated the backup\.json encryption keyRef/u,
  );
});
