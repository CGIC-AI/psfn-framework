// July hardening wave release-shakedown case catalog.
//
// A focused domain module alongside the Sprint 10 catalog (cases/sprint10/*):
// it authors only the hardening rows whose proofs the persisted-state library
// already supports — boundary spend accounting (model-lane routing, mmo9.7.3)
// and the backup.json encryption-block round-trip regression (irzz.1). Voice,
// passkey ceremonies, PWA, and the DNLL migration upgrade path stay
// operator-eyes / staged-session dispositions in docs/shakedown.md, not cases.

import { join } from 'node:path';

import { buildChatHeaders, postChatCompletion } from '../lib/probe.mjs';
import {
  validateBackupEncryptionRoundTripProof,
  validateModelLaneAttributionProof,
} from '../lib/hardening-proofs.mjs';
import {
  envText,
  normalizeCustomOutcome,
  proof,
  requireCaseEnv,
} from './sprint10/common.mjs';

const MODELS_OWNER_FILE = 'models.json';
const BACKUP_OWNER_FILE = 'backup.json';

const SPEND_MESSAGE = 'Reply with one short sentence for the boundary spend-ledger attribution proof.';
const BACKUP_MESSAGE = 'Reply with one short sentence for the backup encryption round-trip probe.';

const MODEL_USAGE_QUERY = `
  select slot_key, provider, model, charge_lane, charge_surface, purpose, recorded_at_ms
  from model_usage_events
  where recorded_at_ms >= $1
  order by recorded_at_ms asc
`;

export const HARDENING_CASE_IDS = Object.freeze([
  'model_lane_attribution',
  'backup_encryption_roundtrip',
]);

async function postAndWait({ services, sessionId, apiUserId, message }) {
  const startedAtMs = Date.now();
  const response = await postChatCompletion({
    apiUrl: services.apiUrl,
    headers: buildChatHeaders({ apiKey: services.apiKey, sessionId, privacy: 'private' }),
    message,
    timeoutMs: 120_000,
  });
  const turnRecord = await services.waitForTurnRecord({
    sessionId,
    apiUserId,
    message,
    minStartedAtMs: startedAtMs - 2_000,
    timeoutMs: 120_000,
  });
  return { response, turnRecord, startedAtMs };
}

function resolveSettingsValue(root, key) {
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    if (Object.prototype.hasOwnProperty.call(root, key)) {
      return { found: true, value: root[key] };
    }
    const settings = root.settings;
    if (
      settings && typeof settings === 'object' && !Array.isArray(settings)
      && Object.prototype.hasOwnProperty.call(settings, key)
    ) {
      return { found: true, value: settings[key] };
    }
  }
  return { found: false, value: undefined };
}

// Confirm the harmless settings change actually took effect by re-reading the
// pinned settings route and deep-comparing each submitted top-level field. A
// no-op 2xx that changes nothing fails here instead of false-passing.
export async function verifySettingsRoundTrip({ services, savePath, saveBody, saveOk, saveStatus }) {
  if (!saveOk) {
    return { verified: false, mismatches: [`settings save returned status ${String(saveStatus ?? 'none')}`] };
  }
  let submitted;
  try {
    submitted = JSON.parse(saveBody);
  } catch (error) {
    return {
      verified: false,
      mismatches: [`PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return { verified: false, mismatches: ['PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY must be a JSON object of settings fields'] };
  }
  const changedKeys = Object.keys(submitted);
  if (changedKeys.length === 0) {
    return { verified: false, mismatches: ['settings save body carried no fields to round-trip'] };
  }
  const refetch = await services.fetchJson(`${services.adminBase}${savePath}`, { method: 'GET' });
  if (refetch?.ok !== true || !refetch?.body || typeof refetch.body !== 'object') {
    return { verified: false, mismatches: [`refetch of ${savePath} failed (status ${String(refetch?.status ?? 'none')})`] };
  }
  const mismatches = [];
  for (const key of changedKeys) {
    const resolved = resolveSettingsValue(refetch.body, key);
    if (!resolved.found) {
      mismatches.push(`refetched settings missing field '${key}'`);
      continue;
    }
    if (JSON.stringify(resolved.value) !== JSON.stringify(submitted[key])) {
      mismatches.push(
        `field '${key}' did not round-trip (submitted ${JSON.stringify(submitted[key])}, refetched ${JSON.stringify(resolved.value)})`,
      );
    }
  }
  return { verified: mismatches.length === 0, mismatches };
}

export function buildHardeningCases(ctx, services, env = process.env) {
  const modelsPath = join(services.systemDataDir, MODELS_OWNER_FILE);
  const backupPath = join(services.systemDataDir, BACKUP_OWNER_FILE);

  return [
    {
      id: 'model_lane_attribution',
      tier: 'nursery',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-mmo9.7.3',
      sessionId: `hardening-spend-${ctx.runToken}`,
      message: SPEND_MESSAGE,
      proof: proof(
        'model_usage_events spend ledger cross-checked against models.json owner slots',
        'each charged lane resolves, via the owner file, to exactly the model that owner slot assigns',
      ),
      execute: async ({ sessionId, apiUserId }) => {
        const baselineMs = Date.now() - 2_000;
        const main = await postAndWait({ services, sessionId, apiUserId, message: SPEND_MESSAGE });
        const ledgerRows = await services.pgAll(MODEL_USAGE_QUERY, [baselineMs]);
        const modelsConfig = services.readJsonIfExists(modelsPath);
        return normalizeCustomOutcome({
          sessionId,
          request: { privacy: 'private', message: SPEND_MESSAGE },
          response: main.response,
          turnRecord: main.turnRecord,
          sideChecks: {
            modelLane: {
              modelsConfig,
              ledgerRows,
              // The interactive chat turn must route to the owner file's
              // chat-primary slot. The concrete model id is resolved from
              // models.json, never hardcoded here.
              laneExpectations: [{ lane: 'interactive', purpose: 'chat' }],
            },
          },
        });
      },
      after: async ({ outcome }) => ({
        modelLane: outcome?.sideChecks?.modelLane
          ? {
            ledgerRowCount: Array.isArray(outcome.sideChecks.modelLane.ledgerRows)
              ? outcome.sideChecks.modelLane.ledgerRows.length
              : 0,
          }
          : null,
      }),
      validatePersistedProof: ({ outcome }) => validateModelLaneAttributionProof(
        outcome?.sideChecks?.modelLane ?? {},
      ),
    },
    {
      id: 'backup_encryption_roundtrip',
      tier: 'nursery',
      variants: ['local'],
      feature: 'psfn-framework-irzz.1',
      sessionId: `hardening-backup-${ctx.runToken}`,
      message: BACKUP_MESSAGE,
      proof: proof(
        'backup.json owner-file snapshots captured before and after a unified Garden settings save',
        'the mandatory encryption block survives the save unchanged',
      ),
      before: async () => {
        requireCaseEnv(
          env,
          ['PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY'],
          'backup_encryption_roundtrip',
        );
        return { backupBefore: services.readJsonIfExists(backupPath) };
      },
      execute: async ({ sessionId, apiUserId }) => {
        // Ride a benign turn so the case has a completed turn record; the proof
        // itself comes only from the backup.json owner-file snapshots.
        const main = await postAndWait({ services, sessionId, apiUserId, message: BACKUP_MESSAGE });
        // Pin the canonical unified settings-save route. The route/method are NOT
        // operator-tunable — only the harmless payload is (still fail-closed
        // required). See src/operator/garden/routes/settings-routes.ts (PATCH
        // exactPath('/api/admin/settings')).
        const savePath = '/api/admin/settings';
        const saveBody = envText(env, 'PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY');
        const save = await services.fetchJson(`${services.adminBase}${savePath}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: saveBody,
        });
        // Round-trip verification: re-read the settings and assert the harmless
        // change is actually reflected, so a no-op 2xx cannot false-pass. Compare
        // each submitted top-level key against the refetched settings (checking
        // both the root and a `.settings` envelope).
        const roundTrip = await verifySettingsRoundTrip({
          services,
          savePath,
          saveBody,
          saveOk: save?.ok === true,
          saveStatus: save?.status ?? null,
        });
        return normalizeCustomOutcome({
          sessionId,
          request: { privacy: 'private', message: BACKUP_MESSAGE, settingsSavePath: savePath },
          response: main.response,
          turnRecord: main.turnRecord,
          sideChecks: {
            save: {
              ok: save?.ok === true,
              status: save?.status ?? null,
              roundTripVerified: roundTrip.verified,
              roundTripMismatches: roundTrip.mismatches,
            },
          },
        });
      },
      after: async ({ outcome, beforeChecks }) => ({
        backup: {
          before: beforeChecks?.backupBefore ?? null,
          after: services.readJsonIfExists(backupPath),
          save: outcome?.sideChecks?.save ?? null,
        },
      }),
      validateSideEffects: ({ sideChecks }) => {
        const save = sideChecks?.backup?.save ?? null;
        const failures = [];
        if (!save || save.ok !== true) {
          failures.push(
            `settings save via PATCH /api/admin/settings did not succeed (status ${String(save?.status ?? 'none')})`,
          );
        }
        if (save && save.roundTripVerified !== true) {
          failures.push(
            `settings save did not round-trip: ${
              Array.isArray(save.roundTripMismatches) && save.roundTripMismatches.length > 0
                ? save.roundTripMismatches.join('; ')
                : 'refetched settings did not reflect the submitted change'
            }`,
          );
        }
        return failures;
      },
      validatePersistedProof: ({ sideChecks }) => validateBackupEncryptionRoundTripProof(
        sideChecks?.backup ?? {},
      ),
    },
  ];
}
