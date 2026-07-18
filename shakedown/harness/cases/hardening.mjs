// July hardening wave release-shakedown case catalog.
//
// A focused domain module alongside the Sprint 10 catalog (cases/sprint10/*):
// it authors only the hardening rows whose proofs the persisted-state library
// already supports — boundary spend accounting (model-lane routing, mmo9.7.3 /
// osln) and the backup.json encryption-block round-trip regression (irzz.1).
// Voice, passkey ceremonies, PWA, and the DNLL migration upgrade path stay
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
  sleep,
} from './sprint10/common.mjs';

const MODELS_OWNER_FILE = 'models.json';
const BACKUP_OWNER_FILE = 'backup.json';

const SPEND_MESSAGE = 'Reply with one short sentence for the boundary spend-ledger attribution proof.';
const VISION_MESSAGE = 'Reply with one short sentence about this image for the spend-ledger vision-workload probe.';
const BACKGROUND_WARMUP_MESSAGE = 'Reply with one short sentence to advance the background emotion-appraisal cadence for the spend-ledger proof.';
const BACKUP_MESSAGE = 'Reply with one short sentence for the backup encryption round-trip probe.';

// The canonical unified settings-save route. The route/method are NOT
// operator-tunable — only the (harmless) payload is. See
// src/operator/garden/routes/settings-routes.ts (GET + PATCH
// exactPath('/api/admin/settings')).
const SETTINGS_PATH = '/api/admin/settings';

// Self-derived round-trip field for backup_encryption_roundtrip.
// sessionRestartBehavior governs ONLY how a fresh inbound API request with no
// explicit session maps to a session (reuse the latest vs open a new one). It
// never touches identity, persona, memory, emotion, trust, or any
// companion/partner data — it is definitively companion-neutral, a
// session/UX-plumbing default. getSettingsData force-defaults it
// (settings-service.ts: `runtimeConfig.sessionRestartBehavior ??=
// 'reuse_latest_session'`), so it is always present in the settings GET, and
// every harness turn passes an explicit X-Session-ID, so flipping the default
// is inert for the round. We flip it to the other enum value, prove the round
// trip, then restore it immediately (and again in the idempotent top-level
// cleanup on error paths).
const ROUNDTRIP_FIELD = 'sessionRestartBehavior';
const ROUNDTRIP_FIELD_VALUES = Object.freeze(['reuse_latest_session', 'new_session']);

// 1x1 transparent PNG. An inline attachment exercises the multimodal foreground
// path without any external egress (which the nursery tier does not grant).
const VISION_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Scope the spend ledger to THIS case: rows on the case session (interactive +
// vision foreground turns are operator_visible and carry the case session id)
// plus any background-lane rows in the case window (the emotion-appraisal
// background job is companion_private, so its session/turn ids are 'unknown' and
// it can only be scoped by lane + window). This replaces the previous
// time-window-only filter that let every unrelated concurrent row into the
// proof (osln). $1 = case start, $2 = case end, $3 = case session id.
const MODEL_USAGE_QUERY = `
  select slot_key, provider, model, charge_lane, charge_surface, purpose,
         recorded_at_ms, turn_id, session_id
  from model_usage_events
  where recorded_at_ms >= $1
    and recorded_at_ms <= $2
    and (session_id = $3 or charge_lane = 'background')
  order by recorded_at_ms asc
`;

const BACKGROUND_ROW_COUNT_QUERY = `
  select count(*)::int as count
  from model_usage_events
  where recorded_at_ms >= $1 and charge_lane = 'background'
`;

const TERMINAL_BACKGROUND_JOB_STATES = new Set(['succeeded', 'failed', 'stale_discarded']);

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

// Vision workload. Sends a foreground turn carrying an inline base64 image.
// Runtime reality (verified for osln): there is NO dedicated 'vision' charge
// lane, and the dedicated vision reviewer only fires for fetchable http(s)
// image_urls (which need image egress the nursery tier does not grant). An
// inline attachment therefore rides the main foreground chat model call, so its
// usage row lands on the interactive lane / chat owner slot and is attributed by
// the interactive lane expectation. stream:false means the returned response
// already proves the turn (and its usage row) settled; the multimodal
// userMessage is not exact-string matchable by waitForTurnRecord, so we do not
// wait on a turn record here. Dedicated vision-slot attribution (a distinct
// 'images.vision_review' row against the models.json vision purpose) is a
// follow-up that needs a fetchable image_url + image egress.
async function postAndWaitVisionInline({ services, sessionId }) {
  const response = await postChatCompletion({
    apiUrl: services.apiUrl,
    headers: buildChatHeaders({ apiKey: services.apiKey, sessionId, privacy: 'private' }),
    message: VISION_MESSAGE,
    content: [
      { type: 'text', text: VISION_MESSAGE },
      { type: 'image', data: VISION_PNG_BASE64, mimeType: 'image/png', name: 'shakedown-probe.png' },
    ],
    timeoutMs: 120_000,
  });
  return { response };
}

// Await a turn's post-turn emotion-appraisal background job to a terminal state.
// The appraisal job is the runtime's only 'background' charge-lane producer.
async function waitForEmotionAppraisal(services, turnId) {
  if (typeof turnId !== 'string' || turnId.length === 0) return null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jobs = await services.pgAll(
      `select kind, state
       from agent_background_work_jobs
       where source_turn_id = $1 and kind = 'emotion_appraisal';`,
      [turnId],
    );
    const appraisal = Array.isArray(jobs)
      ? jobs.find((job) => job.kind === 'emotion_appraisal')
      : null;
    if (appraisal && TERMINAL_BACKGROUND_JOB_STATES.has(appraisal.state)) {
      return appraisal.state;
    }
    await sleep(250);
  }
  return null;
}

// Drive the background lane. The emotion-appraisal background job charges the
// 'background' lane, but its periodic gate only opens once turnsSinceLast >= the
// appraisal turn cadence (runtime default 5; see src/core/emotion/appraisal.ts).
// The interactive + vision turns already advanced the counter for this session;
// drive additional benign turns until a background-lane usage row lands (or the
// budget is exhausted), awaiting each turn's appraisal job so the counter
// advances deterministically between sends. Residual risk: if an operator raised
// the cadence above the warmup budget the background row never lands and the
// proof fails closed with a clear "no background lane row" message.
async function driveBackgroundLane({ services, sessionId, apiUserId, baselineMs }) {
  const maxWarmupTurns = 10;
  let warmupTurns = 0;
  let backgroundObserved = false;
  for (let i = 0; i < maxWarmupTurns; i += 1) {
    const turn = await postAndWait({
      services,
      sessionId,
      apiUserId,
      message: `${BACKGROUND_WARMUP_MESSAGE} (${i + 1})`,
    });
    warmupTurns += 1;
    await waitForEmotionAppraisal(services, turn.turnRecord?.turnId);
    const backgroundRows = Number(await services.pgScalar(BACKGROUND_ROW_COUNT_QUERY, [baselineMs]));
    if (Number.isFinite(backgroundRows) && backgroundRows > 0) {
      backgroundObserved = true;
      break;
    }
  }
  return { warmupTurns, backgroundObserved };
}

function resolveSettingsValue(root, key) {
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    if (Object.prototype.hasOwnProperty.call(root, key)) {
      return { found: true, value: root[key] };
    }
    // The unified settings GET wraps runtime settings under `.config`
    // (settings-service.ts getSettingsData); some views also expose a
    // `.settings` envelope. Check both alongside the root.
    for (const envelopeKey of ['config', 'settings']) {
      const envelope = root[envelopeKey];
      if (
        envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        && Object.prototype.hasOwnProperty.call(envelope, key)
      ) {
        return { found: true, value: envelope[key] };
      }
    }
  }
  return { found: false, value: undefined };
}

// Confirm the settings change actually took effect by re-reading the pinned
// settings route and deep-comparing each submitted top-level field. A no-op 2xx
// that changes nothing fails here instead of false-passing.
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
      mismatches: [`settings save body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return { verified: false, mismatches: ['settings save body must be a JSON object of settings fields'] };
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

// Derive the harmless settings-save payload. Self-contained by default (flip
// sessionRestartBehavior to the other enum value), with an optional operator
// override (PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY). Also captures the pre-change
// value of every field it will change so the case and the idempotent top-level
// cleanup can restore it. Fails closed if the settings GET fails or a field is
// absent.
export async function deriveRoundTripPayload(services, env) {
  const override = envText(env, 'PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY');
  const current = await services.fetchJson(`${services.adminBase}${SETTINGS_PATH}`, { method: 'GET' });
  if (current?.ok !== true || !current?.body || typeof current.body !== 'object' || Array.isArray(current.body)) {
    throw new Error(
      `backup_encryption_roundtrip could not GET ${SETTINGS_PATH} to derive a harmless settings change (status ${String(current?.status ?? 'none')})`,
    );
  }

  let submitted;
  if (override) {
    try {
      submitted = JSON.parse(override);
    } catch (error) {
      throw new Error(
        `PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
      throw new Error('PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY must be a JSON object of settings fields');
    }
    if (Object.keys(submitted).length === 0) {
      throw new Error('PSFN_SHAKEDOWN_SETTINGS_SAVE_BODY must carry at least one settings field');
    }
  } else {
    const resolved = resolveSettingsValue(current.body, ROUNDTRIP_FIELD);
    if (!resolved.found || typeof resolved.value !== 'string') {
      throw new Error(
        `backup_encryption_roundtrip requires the settings GET to expose ${ROUNDTRIP_FIELD}; it was absent`,
      );
    }
    const sentinel = ROUNDTRIP_FIELD_VALUES.find((value) => value !== resolved.value);
    if (!sentinel) {
      throw new Error(
        `backup_encryption_roundtrip cannot derive a sentinel for ${ROUNDTRIP_FIELD}=${String(resolved.value)} (not a known value)`,
      );
    }
    submitted = { [ROUNDTRIP_FIELD]: sentinel };
  }

  const originals = {};
  for (const key of Object.keys(submitted)) {
    const resolved = resolveSettingsValue(current.body, key);
    if (!resolved.found) {
      throw new Error(
        `backup_encryption_roundtrip settings-save field '${key}' is absent from ${SETTINGS_PATH}; refusing to change an unknown field`,
      );
    }
    originals[key] = resolved.value;
  }

  return { saveBody: JSON.stringify(submitted), originals, isOverride: Boolean(override) };
}

// Idempotent restore of the captured original settings value(s). PATCHes the
// originals back and confirms the round trip.
async function restoreSettings(services, originals) {
  const body = JSON.stringify(originals);
  const save = await services.fetchJson(`${services.adminBase}${SETTINGS_PATH}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const roundTrip = await verifySettingsRoundTrip({
    services,
    savePath: SETTINGS_PATH,
    saveBody: body,
    saveOk: save?.ok === true,
    saveStatus: save?.status ?? null,
  });
  return {
    ok: save?.ok === true,
    status: save?.status ?? null,
    verified: roundTrip.verified,
    mismatches: roundTrip.mismatches,
  };
}

export function buildHardeningCases(ctx, services, env = process.env) {
  const modelsPath = join(services.systemDataDir, MODELS_OWNER_FILE);
  const backupPath = join(services.systemDataDir, BACKUP_OWNER_FILE);

  // Durable-side-effect ledger for the idempotent top-level backup cleanup.
  // before() captures the pre-change settings value(s); if the chat dispatch or
  // PATCH throws before execute() restores them, the case runner's top-level
  // cleanup (invoked on harness error paths) restores them from here.
  const backupCleanupState = {
    originals: null,
    saveBody: null,
    restored: false,
  };

  return [
    {
      id: 'model_lane_attribution',
      tier: 'nursery',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-osln',
      sessionId: `hardening-spend-${ctx.runToken}`,
      message: SPEND_MESSAGE,
      proof: proof(
        'model_usage_events spend ledger cross-checked against models.json owner slots',
        'each charged lane resolves, via the owner file, to exactly the model that owner slot assigns',
      ),
      execute: async ({ sessionId, apiUserId }) => {
        const baselineMs = Date.now() - 2_000;
        // (1) Interactive lane: a plain foreground chat turn.
        const interactive = await postAndWait({ services, sessionId, apiUserId, message: SPEND_MESSAGE });
        // (2) Vision workload: a foreground turn carrying an inline image (rides
        //     the interactive lane / chat owner slot — see postAndWaitVisionInline).
        const vision = await postAndWaitVisionInline({ services, sessionId });
        // (3) Background lane: drive benign turns until the periodic
        //     emotion-appraisal gate opens and its background-lane call lands.
        const background = await driveBackgroundLane({ services, sessionId, apiUserId, baselineMs });
        const endMs = Date.now() + 2_000;
        const ledgerRows = await services.pgAll(MODEL_USAGE_QUERY, [baselineMs, endMs, sessionId]);
        const modelsConfig = services.readJsonIfExists(modelsPath);
        return normalizeCustomOutcome({
          sessionId,
          request: { privacy: 'private', message: SPEND_MESSAGE },
          response: interactive.response,
          turnRecord: interactive.turnRecord,
          sideChecks: {
            modelLane: {
              modelsConfig,
              ledgerRows,
              // Each lane's owner slot is resolved from models.json purposes; the
              // concrete model id is never hardcoded here. The interactive lane
              // covers the plain chat turn and the (inline) vision turn, which
              // both ride the chat owner slot; the background lane covers the
              // emotion-appraisal call against the background owner slot.
              laneExpectations: [
                { lane: 'interactive', purpose: 'chat' },
                { lane: 'background', purpose: 'background' },
              ],
              driven: {
                visionInline: Boolean(vision.response),
                backgroundWarmupTurns: background.warmupTurns,
                backgroundObserved: background.backgroundObserved,
              },
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
            driven: outcome.sideChecks.modelLane.driven ?? null,
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
        const backupBefore = services.readJsonIfExists(backupPath);
        // Self-derive the harmless payload from the live settings (or use the
        // optional operator override). Capture the pre-change value(s) for the
        // idempotent restore.
        const derived = await deriveRoundTripPayload(services, env);
        backupCleanupState.originals = derived.originals;
        backupCleanupState.saveBody = derived.saveBody;
        backupCleanupState.restored = false;
        return {
          backupBefore,
          saveBody: derived.saveBody,
          originals: derived.originals,
          isOverride: derived.isOverride,
        };
      },
      execute: async ({ sessionId, apiUserId, beforeChecks }) => {
        // Ride a benign turn so the case has a completed turn record; the proof
        // itself comes only from the backup.json owner-file snapshots.
        const main = await postAndWait({ services, sessionId, apiUserId, message: BACKUP_MESSAGE });
        const saveBody = beforeChecks?.saveBody ?? backupCleanupState.saveBody;
        const save = await services.fetchJson(`${services.adminBase}${SETTINGS_PATH}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: saveBody,
        });
        // Round-trip verification: re-read the settings and assert the harmless
        // change is actually reflected, so a no-op 2xx cannot false-pass.
        const roundTrip = await verifySettingsRoundTrip({
          services,
          savePath: SETTINGS_PATH,
          saveBody,
          saveOk: save?.ok === true,
          saveStatus: save?.status ?? null,
        });
        // Restore the original value(s) immediately — never leave the settings
        // mutated. The top-level cleanup repeats this idempotently on error paths.
        let restore = null;
        if (backupCleanupState.originals) {
          restore = await restoreSettings(services, backupCleanupState.originals);
          if (restore.verified) backupCleanupState.restored = true;
        }
        return normalizeCustomOutcome({
          sessionId,
          request: { privacy: 'private', message: BACKUP_MESSAGE, settingsSavePath: SETTINGS_PATH },
          response: main.response,
          turnRecord: main.turnRecord,
          sideChecks: {
            save: {
              ok: save?.ok === true,
              status: save?.status ?? null,
              roundTripVerified: roundTrip.verified,
              roundTripMismatches: roundTrip.mismatches,
              restored: backupCleanupState.restored,
              restoreMismatches: restore?.mismatches ?? [],
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
            `settings save via PATCH ${SETTINGS_PATH} did not succeed (status ${String(save?.status ?? 'none')})`,
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
        if (save && save.restored !== true) {
          failures.push(
            `settings were not restored to their pre-probe value: ${
              Array.isArray(save.restoreMismatches) && save.restoreMismatches.length > 0
                ? save.restoreMismatches.join('; ')
                : 'restore round-trip was not confirmed'
            }`,
          );
        }
        return failures;
      },
      validatePersistedProof: ({ sideChecks }) => validateBackupEncryptionRoundTripProof(
        sideChecks?.backup ?? {},
      ),
      // Idempotent top-level cleanup. The case runner calls this on harness error
      // paths (and again after a normal run). It restores the pre-probe settings
      // value(s) if execute() did not already, and is a near no-op once the
      // restore is confirmed. Returns the runner's { cleanup, cleanupErrors }
      // shape; recorded without changing the validator contract.
      cleanup: async () => {
        const cleanupErrors = [];
        const done = {
          restored: backupCleanupState.restored,
          alreadyClean: false,
        };
        if (!backupCleanupState.originals) {
          // before() never derived a payload — nothing durable to undo.
          done.alreadyClean = true;
          return { cleanup: { settings: done }, cleanupErrors };
        }
        if (backupCleanupState.restored) {
          done.alreadyClean = true;
          return { cleanup: { settings: done }, cleanupErrors };
        }
        try {
          const restore = await restoreSettings(services, backupCleanupState.originals);
          if (restore.verified) {
            backupCleanupState.restored = true;
            done.restored = true;
          } else {
            cleanupErrors.push(
              `settings restore was not confirmed: ${
                Array.isArray(restore.mismatches) && restore.mismatches.length > 0
                  ? restore.mismatches.join('; ')
                  : `status ${String(restore.status)}`
              }`,
            );
          }
        } catch (error) {
          cleanupErrors.push(`settings restore threw: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { cleanup: { settings: done }, cleanupErrors };
      },
    },
  ];
}
