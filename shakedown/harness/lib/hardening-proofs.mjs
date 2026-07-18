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
    // Per-turn / per-session correlation columns (migrations.ts model_usage_events
    // idx_model_usage_events_request / _session_time). Populated for
    // operator_visible turns; 'unknown' for companion_private background rows.
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
 *   laneExpectations — [{ lane|turnId, purpose }] entries: the rows they select
 *                      must have been charged the model the owner file assigns to
 *                      that purpose's primary slot. `purpose` resolves to a model
 *                      id via models.json — no model name is hardcoded. Each entry
 *                      scopes rows by EITHER `lane` (charge_lane match — used for
 *                      the distinct 'background' lane) OR `turnId` (turn_id match —
 *                      used to attribute a specific foreground turn without pulling
 *                      in the whole interactive lane); `turnId` wins when both are
 *                      present. osln scopes the query to the case's session so a
 *                      lane match no longer sweeps in unrelated concurrent rows.
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
    const purpose = expectation?.purpose;
    const hasLane = typeof lane === 'string' && lane.length > 0;
    const hasTurn = typeof turnId === 'string' && turnId.length > 0;
    if (typeof purpose !== 'string' || (!hasLane && !hasTurn)) {
      failures.push('lane expectation must name a purpose and either a lane or a turnId');
      continue;
    }
    // turn_id wins so a specific foreground turn can be attributed without
    // sweeping in every other row on its charge lane.
    const scopeLabel = hasTurn ? `turn ${turnId}` : `${lane} lane`;
    const slotId = purposePrimary[purpose];
    if (!slotId || !slotCatalog[slotId]) {
      failures.push(`models.json has no primary owner slot for purpose ${purpose} (${scopeLabel})`);
      continue;
    }
    const expectedModel = slotCatalog[slotId].model;
    const scopedRows = hasTurn
      ? rows.filter((row) => row.turnId === turnId)
      : rows.filter((row) => row.chargeLane === lane);
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

function hasEncryptionBlock(backup) {
  const encryption = backup?.encryption;
  return Boolean(encryption)
    && typeof encryption === 'object'
    && typeof encryption.mode === 'string'
    && encryption.mode.length > 0;
}

/**
 * Prove a unified Garden settings save preserved the mandatory backup.json
 * encryption block (irzz.1 regression: the save stripped it and broke the
 * next encrypted backup). Inputs are owner-file snapshots captured before and
 * after the save plus the save-request outcome — reply text is never proof.
 */
export function validateBackupEncryptionRoundTripProof({ before, after, save }) {
  const failures = [];
  if (!hasEncryptionBlock(before)) {
    failures.push('pre-save backup.json snapshot is missing its encryption block — precondition not met');
    return failures;
  }
  if (save?.ok !== true || typeof save?.status !== 'number' || save.status >= 400) {
    failures.push(`unified settings save did not succeed (status ${String(save?.status)})`);
  }
  if (!hasEncryptionBlock(after)) {
    failures.push('settings save stripped the mandatory backup.json encryption block (irzz.1 regression)');
    return failures;
  }
  if (after.encryption.mode !== before.encryption.mode) {
    failures.push(
      `settings save changed backup.json encryption.mode from ${before.encryption.mode} to ${after.encryption.mode}`,
    );
  }
  const beforeKeyRef = JSON.stringify(before.encryption.keyRef ?? null);
  const afterKeyRef = JSON.stringify(after.encryption.keyRef ?? null);
  if (beforeKeyRef !== afterKeyRef) {
    failures.push('settings save mutated the backup.json encryption keyRef');
  }
  return failures;
}
