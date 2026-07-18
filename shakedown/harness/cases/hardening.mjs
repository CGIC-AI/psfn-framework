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
          ['PSFN_SHAKEDOWN_SETTINGS_SAVE_PATH', 'PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY'],
          'backup_encryption_roundtrip',
        );
        return { backupBefore: services.readJsonIfExists(backupPath) };
      },
      execute: async ({ sessionId, apiUserId }) => {
        // Ride a benign turn so the case has a completed turn record; the proof
        // itself comes only from the backup.json owner-file snapshots.
        const main = await postAndWait({ services, sessionId, apiUserId, message: BACKUP_MESSAGE });
        const savePath = envText(env, 'PSFN_SHAKEDOWN_SETTINGS_SAVE_PATH');
        const saveMethod = envText(env, 'PSFN_SHAKEDOWN_SETTINGS_SAVE_METHOD', 'POST');
        const saveBody = envText(env, 'PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY');
        const save = await services.fetchJson(`${services.adminBase}${savePath}`, {
          method: saveMethod,
          headers: { 'Content-Type': 'application/json' },
          body: saveBody,
        });
        return normalizeCustomOutcome({
          sessionId,
          request: { privacy: 'private', message: BACKUP_MESSAGE, settingsSavePath: savePath },
          response: main.response,
          turnRecord: main.turnRecord,
          sideChecks: {
            save: { ok: save?.ok === true, status: save?.status ?? null },
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
      validatePersistedProof: ({ sideChecks }) => validateBackupEncryptionRoundTripProof(
        sideChecks?.backup ?? {},
      ),
    },
  ];
}
