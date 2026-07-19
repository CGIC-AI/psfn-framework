// Persisted-state proof validators for the July hardening wave shakedown cases.
//
// Like lib/persisted-proofs.mjs, these validators never inspect a model's
// claimed result. Their inputs are canonical owner-file snapshots and the
// boundary spend ledger the runtime persists. A missing artifact is a failure.
//
// Two proofs live here:
//   1. model-lane attribution — the boundary spend ledger's per-lane model
//      attribution must resolve, through the canonical models.json owner slots,
//      to exactly the model that was charged. Model names are never hardcoded:
//      the intended tier model for each lane is derived from the owner file.
//   2. backup.json encryption round-trip — a unified Garden settings save must
//      not strip the mandatory backup.json encryption block (irzz.1 regression).

// Mirrors src/shared/contracts/charge-policy.ts (CHARGE_POLICY_RUNTIME_LANE_VALUES)
// plus the model-usage attribution sentinel (src/shared/telemetry/
// model-usage-attribution.ts MODEL_USAGE_UNKNOWN_DIMENSION = 'unknown').
export const MODEL_USAGE_LANE_VALUES = Object.freeze([
  'interactive',
  'companion_social',
  'background',
  'maintenance',
  'subagent',
  'shard',
  'unknown',
]);

// Mirrors src/shared/contracts/charge-policy.ts (CHARGE_POLICY_SURFACE_VALUES)
// plus the same 'unknown' sentinel.
export const MODEL_USAGE_SURFACE_VALUES = Object.freeze([
  'ownerFileInspection',
  'localFilesystem',
  'memoryRead',
  'memoryWrite',
  'localEmbedding',
  'externalEmbedding',
  'localImageGeneration',
  'paidImageGeneration',
  'analysisWorkbenchExtensionBand',
  'subagentLaunch',
  'shardLaunch',
  'externalModelConsult',
  'moaRoundBase',
  'companionSocialContinuation',
  'unknown',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pick(row, snake, camel) {
  const snakeValue = row?.[snake];
  if (typeof snakeValue === 'string' && snakeValue.length > 0) return snakeValue;
  const camelValue = row?.[camel];
  if (typeof camelValue === 'string' && camelValue.length > 0) return camelValue;
  return null;
}

/**
 * Project the canonical models.json owner file into owner slots, mirroring
 * src/system/settings/schema-model-registry.ts:
 *   - slotCatalog[id] = { model: identity.model, provider: identity.provider }
 *   - purposePrimary[purpose] = the slot id whose purpose tag is primary
 * Returns { slotCatalog, purposePrimary, failures } — a malformed owner file
 * yields failures rather than a silent empty projection.
 */
export function resolveOwnerSlots(modelsConfig) {
  const failures = [];
  const slotCatalog = {};
  const purposePrimary = {};
  const models = asArray(modelsConfig?.models);
  if (models.length === 0) {
    failures.push('models.json owner file exposes no models[] to resolve owner slots');
    return { slotCatalog, purposePrimary, failures };
  }
  for (const entry of models) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    const model = typeof entry?.identity?.model === 'string' ? entry.identity.model : null;
    const provider = typeof entry?.identity?.provider === 'string' ? entry.identity.provider : null;
    if (!id || !model || !provider) {
      failures.push(`models.json entry is missing id/identity.model/identity.provider (${JSON.stringify(entry?.id ?? null)})`);
      continue;
    }
    slotCatalog[id] = { model, provider };
    for (const purposeTag of asArray(entry.purposes)) {
      if (purposeTag?.primary !== true || typeof purposeTag?.purpose !== 'string') continue;
      if (purposePrimary[purposeTag.purpose] && purposePrimary[purposeTag.purpose] !== id) {
        failures.push(`models.json declares two primary slots for purpose ${purposeTag.purpose}`);
        continue;
      }
      purposePrimary[purposeTag.purpose] = id;
    }
  }
  return { slotCatalog, purposePrimary, failures };
}

function normalizeLedgerRow(row) {
  return {
    slotKey: pick(row, 'slot_key', 'slotKey'),
    model: pick(row, 'model', 'model'),
    provider: pick(row, 'provider', 'provider'),
    chargeLane: pick(row, 'charge_lane', 'chargeLane'),
    chargeSurface: pick(row, 'charge_surface', 'chargeSurface'),
    purpose: pick(row, 'purpose', 'purpose'),
    originStage: pick(row, 'origin_stage', 'originStage'),
    // Per-turn / per-session correlation columns (migrations.ts model_usage_events
    // idx_model_usage_events_request / _session_time). Companion-private work
    // deliberately collapses these to 'unknown'; the case-driven emotion
    // appraisal used here is operator-visible and retains its source turn id.
    turnId: pick(row, 'turn_id', 'turnId'),
    sessionId: pick(row, 'session_id', 'sessionId'),
  };
}

/**
 * Cross-check the boundary spend ledger (model_usage_events rows) against the
 * canonical owner slots.
 *
 * inputs:
 *   modelsConfig     — parsed models.json owner file.
 *   ledgerRows       — model_usage_events rows (snake or camel columns).
 *   laneExpectations — [{ lane?, turnId?, originStage?, purpose }] entries: the rows they select
 *                      must have been charged the model the owner file assigns to
 *                      that purpose's primary slot. `purpose` resolves to a model
 *                      id via models.json — no model name is hardcoded. Each entry
 *                      may scope by `lane`, `turnId`, `originStage`, or their
 *                      intersection. Exact turn scoping keeps chat and vision
 *                      independent even though both charge the interactive lane;
 *                      lane+turn+origin scoping binds the background assertion to
 *                      the emotion appraisal driven by this case rather than
 *                      unrelated concurrent background work.
 */
export function validateModelLaneAttributionProof({ modelsConfig, ledgerRows, laneExpectations = [] }) {
  const failures = [];
  const { slotCatalog, purposePrimary, failures: slotFailures } = resolveOwnerSlots(modelsConfig);
  failures.push(...slotFailures);

  const rows = asArray(ledgerRows).map(normalizeLedgerRow);
  if (rows.length === 0) {
    failures.push('boundary spend ledger produced no model_usage_events rows to attribute');
    return failures;
  }

  for (const row of rows) {
    if (!row.slotKey) {
      failures.push('a spend-ledger row is missing its slot_key owner-slot attribution');
      continue;
    }
    const slot = slotCatalog[row.slotKey];
    if (!slot) {
      failures.push(`spend-ledger slot_key ${row.slotKey} is not a canonical models.json owner slot`);
      continue;
    }
    if (row.model !== slot.model) {
      failures.push(
        `slot ${row.slotKey} charged model ${String(row.model)} but models.json assigns ${slot.model}`,
      );
    }
    if (row.provider !== slot.provider) {
      failures.push(
        `slot ${row.slotKey} charged provider ${String(row.provider)} but models.json assigns ${slot.provider}`,
      );
    }
    if (!MODEL_USAGE_LANE_VALUES.includes(row.chargeLane)) {
      failures.push(`spend-ledger charge_lane ${String(row.chargeLane)} is not a canonical runtime lane`);
    }
    if (!MODEL_USAGE_SURFACE_VALUES.includes(row.chargeSurface)) {
      failures.push(`spend-ledger charge_surface ${String(row.chargeSurface)} is not a canonical charge surface`);
    }
  }

  for (const expectation of asArray(laneExpectations)) {
    const lane = expectation?.lane;
    const turnId = expectation?.turnId;
    const originStage = expectation?.originStage;
    const purpose = expectation?.purpose;
    const hasLane = typeof lane === 'string' && lane.length > 0;
    const hasTurn = typeof turnId === 'string' && turnId.length > 0;
    const hasOriginStage = typeof originStage === 'string' && originStage.length > 0;
    if (typeof purpose !== 'string' || (!hasLane && !hasTurn)) {
      failures.push('lane expectation must name a purpose and either a lane or a turnId');
      continue;
    }
    const laneTurnLabel = hasTurn && hasLane
      ? `turn ${turnId} on ${lane} lane`
      : (hasTurn ? `turn ${turnId}` : `${lane} lane`);
    const scopeLabel = hasOriginStage
      ? `${laneTurnLabel} at origin stage ${originStage}`
      : laneTurnLabel;
    const slotId = purposePrimary[purpose];
    if (!slotId || !slotCatalog[slotId]) {
      failures.push(`models.json has no primary owner slot for purpose ${purpose} (${scopeLabel})`);
      continue;
    }
    const expectedModel = slotCatalog[slotId].model;
    const scopedRows = rows.filter((row) => (
      (!hasTurn || row.turnId === turnId)
      && (!hasLane || row.chargeLane === lane)
      && (!hasOriginStage || row.originStage === originStage)
    ));
    if (scopedRows.length === 0) {
      failures.push(`spend ledger has no ${scopeLabel} row to attribute against the ${purpose} owner slot`);
      continue;
    }
    for (const row of scopedRows) {
      if (row.model !== expectedModel) {
        failures.push(
          `${scopeLabel} routed to model ${String(row.model)} but the ${purpose} owner slot resolves to ${expectedModel}`,
        );
      }
    }
  }

  return failures;
}

export function validateBackgroundModelDriveProof(driven) {
  if (!driven || typeof driven !== 'object' || Array.isArray(driven)) {
    return ['case-owned background appraisal evidence is missing'];
  }
  const failures = [];
  if (driven.backgroundJobState !== 'succeeded') {
    failures.push(
      `case-owned background appraisal did not succeed (state=${String(driven.backgroundJobState)})`,
    );
  }
  if (typeof driven.backgroundTurnId !== 'string' || driven.backgroundTurnId.length === 0) {
    failures.push('case-owned background appraisal source turn is missing');
  }
  if (driven.backgroundObserved !== true) {
    failures.push('case-owned background appraisal produced no model-usage row');
  }
  if (driven.backgroundOriginStage !== 'emotion.appraisal') {
    failures.push(
      'case-owned background appraisal is not proven by an emotion.appraisal model call',
    );
  }
  return failures;
}

function backupEncryptionBlock(backup) {
  const encryption = backup?.encryption;
  if (
    !encryption
    || typeof encryption !== 'object'
    || Array.isArray(encryption)
    || typeof encryption.mode !== 'string'
    || encryption.mode.length === 0
  ) {
    return null;
  }
  return encryption;
}

/**
 * Prove the real backup owner-file save path preserves the mandatory backup.json
 * encryption block, and that the fail-closed guard at the regression site rejects
 * an encryption-stripped payload (irzz.1: a unified save dropped the encryption
 * block and broke the next encrypted backup).
 *
 * This drives the actual save route (POST /api/admin/settings/backup ->
 * saveBackupConfig / validateBackupConfig), never the unrelated settings PATCH.
 * Inputs are on-disk backup.json snapshots captured across each real write plus
 * the save/restore/reject request outcomes — reply text is never proof.
 *
 * Requires, all fail-closed:
 *   - the pre-save owner file actually carries an encryption block (precondition);
 *   - the POSITIVE full-payload save succeeded AND the flipped benign scalar
 *     landed on disk AND the encryption block survived byte-for-byte;
 *   - the original payload was restored (flipped scalar back, encryption intact);
 *   - the NEGATIVE encryption-stripped payload was REJECTED and did not touch
 *     backup.json on disk.
 */
export function validateBackupEncryptionRoundTripProof({
  field,
  flipFrom,
  flipTo,
  before,
  afterWrite,
  afterRestore,
  afterReject,
  save,
  restore,
  reject,
} = {}) {
  const failures = [];

  const beforeEncryption = backupEncryptionBlock(before);
  if (!beforeEncryption) {
    failures.push('pre-save backup.json snapshot is missing its encryption block — precondition not met');
    return failures;
  }
  if (typeof field !== 'string' || field.length === 0) {
    failures.push('backup round-trip did not record which benign scalar it flipped');
    return failures;
  }
  const beforeEncryptionStr = JSON.stringify(beforeEncryption);

  // (a) POSITIVE round-trip through the real backup save path.
  if (save?.ok !== true || typeof save?.status !== 'number' || save.status >= 400) {
    failures.push(`backup save via POST /api/admin/settings/backup did not succeed (status ${String(save?.status)})`);
  }
  const writeEncryption = backupEncryptionBlock(afterWrite);
  if (!writeEncryption) {
    failures.push('backup save stripped the mandatory backup.json encryption block (irzz.1 regression)');
  } else if (JSON.stringify(writeEncryption) !== beforeEncryptionStr) {
    failures.push('backup save mutated the backup.json encryption block (mode/keyRef changed)');
  }
  if (flipTo === flipFrom) {
    failures.push('backup round-trip flipped the scalar to its own value — the write would be a no-op');
  }
  if (!afterWrite || typeof afterWrite !== 'object' || afterWrite[field] !== flipTo) {
    failures.push(
      `backup save did not land: expected on-disk ${field}=${String(flipTo)} but read ${String(afterWrite?.[field])}`,
    );
  }

  // Restore: the original scalar came back and the encryption block is intact.
  if (restore?.ok !== true || typeof restore?.status !== 'number' || restore.status >= 400) {
    failures.push(`backup restore did not succeed (status ${String(restore?.status)})`);
  }
  const restoreEncryption = backupEncryptionBlock(afterRestore);
  if (!restoreEncryption || JSON.stringify(restoreEncryption) !== beforeEncryptionStr) {
    failures.push('backup restore did not return the original encryption block');
  }
  if (!afterRestore || typeof afterRestore !== 'object' || afterRestore[field] !== flipFrom) {
    failures.push(
      `backup was not restored: expected on-disk ${field}=${String(flipFrom)} but read ${String(afterRestore?.[field])}`,
    );
  }

  // (b) NEGATIVE guard probe: the encryption-stripped payload must be REJECTED
  //     at the regression site and must not touch backup.json on disk.
  if (reject?.ok === true || typeof reject?.status !== 'number' || reject.status < 400) {
    failures.push(
      `encryption-stripped backup payload was NOT rejected (status ${String(reject?.status)}) — the fail-closed guard is missing`,
    );
  }
  if (JSON.stringify(afterReject) !== JSON.stringify(afterRestore)) {
    failures.push('rejected backup payload changed backup.json on disk — the reject was not fail-closed');
  }

  return failures;
}
