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
  summarizeUnknownEmbeddingAttribution,
  validateBackupEncryptionRoundTripProof,
  validateBackgroundModelDriveProof,
  validateModelLaneAttributionProof,
} from '../lib/hardening-proofs.mjs';
import { runCaseWithTimeout } from '../lib/case-execution.mjs';
import {
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

// The canonical backup owner-file save route. This is the actual regression
// site: POST /api/admin/settings/backup routes through saveSubConfigJson('backup')
// -> configStore.saveBackup -> saveBackupConfig / validateBackupConfig
// (src/operator/garden/routes/settings-routes.ts POST prefixedParamPath, and
// src/system/config/backup-config.ts). The route/method are NOT operator-tunable
// — only the (self-derived, benign) payload is. The body is form-urlencoded with
// a single `configJson` field (a JSON-stringified full backup config); a valid
// save returns 200 text `backup.json saved`, a rejected payload returns 400 JSON
// `{error}`.
const BACKUP_SAVE_PATH = '/api/admin/settings/backup';

// Benign mutable retention scalars we may flip by +1 to prove a real backup save
// landed on disk. Every candidate is a pure grandfather-father-son retention
// count enforced by validateBackupConfig (backup-config.ts): it never touches
// encryption, mode, keyRef, mirrorDir, or any security/identity field, and a
// valid on-disk backup.json always carries at least one of them. Flipping a
// retention count by 1 is inert for the round and fully reversible. We prefer
// maxMonthlyBackups (a required GFS count, min 0) and fall back only if a given
// deployment somehow lacks it.
const BACKUP_FLIP_FIELD_CANDIDATES = Object.freeze([
  'maxMonthlyBackups',
  'maxWeeklyBackups',
  'maxRotatingBackups',
]);

// 1x1 transparent PNG. An inline attachment exercises the multimodal foreground
// path without any external egress (which the nursery tier does not grant).
const VISION_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Scope the spend ledger to THIS case: foreground rows carry the case session
// id, while the emotion-appraisal call carries the source turn id. The
// lane+turn predicate excludes unrelated concurrent background work. $1 = case
// session id; $2 = the source turn whose successful appraisal landed usage.
const MODEL_USAGE_QUERY = `
  select slot_key, provider, model, charge_lane, charge_surface, purpose,
         origin_stage, recorded_at_ms, turn_id, session_id
  from model_usage_events
  where (session_id = $1 and charge_lane = 'interactive')
    or (
      charge_lane = 'background'
      and turn_id = $2
      and origin_stage = 'emotion.appraisal'
    )
  order by recorded_at_ms asc
`;

// Residual diagnosis for the historical unknown-lane embedding bucket. These
// runtime-authored provenance columns identify real callers without inferring
// a call site from a model name or an aggregate count.
const UNKNOWN_EMBEDDING_ATTRIBUTION_QUERY = `
  select logical_call_id, recorded_at_ms, purpose, origin_type, origin_stage,
         service, process, session_id, turn_id, request_id, channel_id,
         channel_type, workload_type, workload_id, tool_name, slot_key, provider,
         model, charge_surface, metadata_json,
         count(*) over() as total_unknown_embedding_count
  from model_usage_events
  where call_kind = 'embedding' and charge_lane = 'unknown'
  order by recorded_at_ms desc
  limit 200
`;

const BACKGROUND_APPRAISAL_ORIGIN_QUERY = `
  select origin_stage
  from model_usage_events
  where turn_id = $1
    and charge_lane = 'background'
    and origin_stage = 'emotion.appraisal'
  order by recorded_at_ms asc
  limit 1
`;

const TERMINAL_BACKGROUND_JOB_STATES = new Set(['succeeded', 'failed', 'stale_discarded']);
export const MODEL_LANE_DISPATCH_TIMEOUT_MS = 120_000;
const MODEL_LANE_CANCELLATION_DRAIN_TIMEOUT_MS = 10_000;

export class ModelLaneAttributionDispatchTimeoutError extends Error {
  constructor(stage, timeoutMs) {
    super(`model_lane_attribution ${stage} timed out after ${timeoutMs}ms`);
    this.name = 'ModelLaneAttributionDispatchTimeoutError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export const HARDENING_CASE_IDS = Object.freeze([
  'model_lane_attribution',
  'backup_encryption_roundtrip',
]);

async function postAndWait({ services, sessionId, apiUserId, message, signal }) {
  const startedAtMs = Date.now();
  const response = await postChatCompletion({
    apiUrl: services.apiUrl,
    headers: buildChatHeaders({ apiKey: services.apiKey, sessionId, privacy: 'private' }),
    message,
    timeoutMs: 120_000,
    signal,
  });
  const turnRecord = await services.waitForTurnRecord({
    sessionId,
    apiUserId,
    message,
    minStartedAtMs: startedAtMs - 2_000,
    timeoutMs: 120_000,
    signal,
  });
  return { response, turnRecord, startedAtMs };
}

// Vision workload. Sends a foreground turn carrying an inline base64 image and
// recovers the persisted turn record — and its turnId — so the image turn can be
// attributed at turn granularity in the spend ledger.
//
// Runtime reality (verified for osln/65rk): an inline base64 attachment is
// detected as a vision turn (resolveTurnModelPurpose -> 'vision',
// src/core/agent/substrate-agent/model-runtime.ts), but the dedicated vision
// reviewer only fires for fetchable http(s) image_urls (which need image egress
// the nursery tier does not grant). The inline image therefore rides the main
// foreground agent.prompt call: its model_usage_events row lands on the
// interactive lane against the models.json vision owner slot (which, in the
// default config, is the same 'primary' slot that owns 'chat' — see
// load-config.ts). The ledger's `purpose` COLUMN carries the correlation stage
// string 'agent.turn.prompt', not the routing ModelPurpose 'vision'; the proof
// therefore attributes by turn_id against the vision OWNER SLOT (resolved from
// models.json, never hardcoded), which is the strongest honest assertion for the
// inline case and fails closed if no row lands for the turn or it routes to a
// non-owner model.
//
// The persisted userMessage.content for a multimodal turn is a STRING whose
// prefix is the text block verbatim, then an appended image-attachment block
// (src/core/agent/substrate-agent/vision-attachments.ts
// appendPersistedImageAttachmentBlock). Exact-string matching therefore fails,
// but a substring match on VISION_MESSAGE recovers the record; turnRecord.turnId
// equals model_usage_events.turn_id (both the turn's UUIDv7) for this
// operator_visible foreground turn, so a turn_id-scoped ledger assertion holds.
async function postAndWaitVisionInline({ services, sessionId, apiUserId, signal }) {
  const startedAtMs = Date.now();
  const response = await postChatCompletion({
    apiUrl: services.apiUrl,
    headers: buildChatHeaders({ apiKey: services.apiKey, sessionId, privacy: 'private' }),
    message: VISION_MESSAGE,
    content: [
      { type: 'text', text: VISION_MESSAGE },
      { type: 'image', data: VISION_PNG_BASE64, mimeType: 'image/png', name: 'shakedown-probe.png' },
    ],
    timeoutMs: 120_000,
    signal,
  });
  const turnRecord = await services.waitForTurnRecord({
    sessionId,
    apiUserId,
    messageIncludes: VISION_MESSAGE,
    minStartedAtMs: startedAtMs - 2_000,
    timeoutMs: 120_000,
    signal,
  });
  return { response, turnRecord };
}

// Await a turn's post-turn emotion-appraisal background job to a terminal state.
async function waitForEmotionAppraisal(services, turnId, signal) {
  if (typeof turnId !== 'string' || turnId.length === 0) return null;
  let appraisalObserved = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let jobs;
    try {
      jobs = await services.pgAll(
        `select job_id, kind, source_turn_id, state
         from agent_background_work_jobs
         where source_turn_id = $1 and kind = 'emotion_appraisal';`,
        [turnId],
      );
    } catch (error) {
      return {
        jobId: null,
        sourceTurnId: turnId,
        state: 'proof_query_failed',
        proofQueryFailure: {
          stage: 'background_appraisal_poll',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
      };
    }
    const appraisal = Array.isArray(jobs)
      ? jobs.find((job) => job.kind === 'emotion_appraisal')
      : null;
    appraisalObserved ||= Boolean(appraisal);
    if (appraisal && TERMINAL_BACKGROUND_JOB_STATES.has(appraisal.state)) {
      return {
        jobId: appraisal.job_id ?? appraisal.jobId ?? null,
        sourceTurnId: appraisal.source_turn_id ?? appraisal.sourceTurnId ?? turnId,
        state: appraisal.state,
      };
    }
    // Most turns do not cross the periodic appraisal cadence. Give job creation
    // a short grace period, then advance to the next paced warmup turn instead
    // of burning twenty seconds polling for a job that was never scheduled.
    if (!appraisalObserved && attempt >= 7) return null;
    await sleep(250, signal);
  }
  return null;
}

// Drive the background lane. The emotion-appraisal background job charges the
// 'background' lane, but its periodic gate only opens once turnsSinceLast >= the
// appraisal turn cadence (runtime default 5; see src/core/emotion/appraisal.ts).
// The interactive + vision turns already advanced the counter for this session;
// drive additional benign turns until a SUCCEEDED appraisal for one exact source
// turn lands a background-lane usage row whose origin_stage is emotion.appraisal.
// That provenance condition distinguishes a real emotion-model call from a
// successfully skipped gate and from intention appraisal on the same source turn.
// Residual risk: if an operator raised the cadence above the warmup budget the
// proof fails closed with a clear message.
async function driveBackgroundLane({
  services,
  sessionId,
  apiUserId,
  signal,
  setStage,
  stepDelayMs,
}) {
  const maxWarmupTurns = 10;
  let warmupTurns = 0;
  let backgroundObserved = false;
  let backgroundOriginStage = null;
  let backgroundJobState = null;
  let backgroundTurnId = null;
  let backgroundJobId = null;
  const proofQueryFailures = [];
  for (let i = 0; i < maxWarmupTurns; i += 1) {
    if (stepDelayMs > 0) await sleep(stepDelayMs, signal);
    setStage?.('background_warmup_turn');
    const turn = await postAndWait({
      services,
      sessionId,
      apiUserId,
      message: `${BACKGROUND_WARMUP_MESSAGE} (${i + 1})`,
      signal,
    });
    warmupTurns += 1;
    setStage?.('background_appraisal_poll');
    const appraisal = await waitForEmotionAppraisal(
      services,
      turn.turnRecord?.turnId,
      signal,
    );
    backgroundJobState = appraisal?.state ?? null;
    if (appraisal?.proofQueryFailure) {
      proofQueryFailures.push(appraisal.proofQueryFailure);
      break;
    }
    if (appraisal?.state !== 'succeeded') continue;
    const sourceTurnId = appraisal.sourceTurnId;
    setStage?.('background_usage_origin_read');
    let originStage;
    try {
      originStage = await services.pgScalar(
        BACKGROUND_APPRAISAL_ORIGIN_QUERY,
        [sourceTurnId],
      );
    } catch (error) {
      proofQueryFailures.push({
        stage: 'background_usage_origin_read',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      break;
    }
    if (originStage === 'emotion.appraisal') {
      backgroundObserved = true;
      backgroundOriginStage = originStage;
      backgroundTurnId = sourceTurnId;
      backgroundJobId = appraisal.jobId;
      break;
    }
  }
  return {
    warmupTurns,
    backgroundObserved,
    backgroundOriginStage,
    backgroundJobState,
    backgroundTurnId,
    backgroundJobId,
    proofQueryFailures,
  };
}

async function runModelLaneAttributionDispatch({
  timeoutMs,
  parentSignal,
  getStage,
  run,
}) {
  const cancellationDrainTimeoutMs = Math.min(
    MODEL_LANE_CANCELLATION_DRAIN_TIMEOUT_MS,
    Math.max(1, Math.floor(timeoutMs / 2)),
  );
  const executionTimeoutMs = timeoutMs - cancellationDrainTimeoutMs;
  return runCaseWithTimeout({
    label: 'model_lane_attribution dispatch',
    timeoutMs: executionTimeoutMs,
    cancellationDrainTimeoutMs,
    createTimeoutError: () => new ModelLaneAttributionDispatchTimeoutError(
      getStage(),
      executionTimeoutMs,
    ),
    run: (dispatchSignal) => run(parentSignal
      ? AbortSignal.any([dispatchSignal, parentSignal])
      : dispatchSignal),
  });
}

export function buildModelLaneExpectations({
  interactiveTurnId,
  visionTurnId,
  backgroundTurnId,
}) {
  return [
    { turnId: interactiveTurnId, purpose: 'chat' },
    { turnId: visionTurnId, purpose: 'vision' },
    {
      lane: 'background',
      turnId: backgroundTurnId,
      originStage: 'emotion.appraisal',
      purpose: 'background',
    },
  ];
}

// ── Backup owner-file save-path helpers (irzz.1) ──

function hasBackupEncryptionBlock(backup) {
  const encryption = backup?.encryption;
  return Boolean(encryption)
    && typeof encryption === 'object'
    && !Array.isArray(encryption)
    && typeof encryption.mode === 'string'
    && encryption.mode.length > 0;
}

function pickBackupFlipField(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return null;
  for (const field of BACKUP_FLIP_FIELD_CANDIDATES) {
    const value = backup[field];
    if (typeof value === 'number' && Number.isFinite(value)) return field;
  }
  return null;
}

// POST a full backup config to the pinned save route. The body is form-urlencoded
// `configJson=<JSON>` per the route contract. Returns the normalized outcome —
// never the plain-text success body as proof.
async function postBackupConfig(services, payload, signal) {
  const res = await services.fetchJson(`${services.adminBase}${BACKUP_SAVE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `configJson=${encodeURIComponent(JSON.stringify(payload))}`,
    signal,
  });
  return {
    ok: res?.ok === true,
    status: typeof res?.status === 'number' ? res.status : null,
    error: res?.body?.error ?? null,
  };
}

export function buildHardeningCases(ctx, services, options = {}) {
  const modelsPath = join(services.systemDataDir, MODELS_OWNER_FILE);
  const backupPath = join(services.systemDataDir, BACKUP_OWNER_FILE);
  const modelLaneDispatchTimeoutMs = options.modelLaneDispatchTimeoutMs
    ?? MODEL_LANE_DISPATCH_TIMEOUT_MS;
  const modelLaneStepDelayMs = options.modelLaneStepDelayMs ?? 0;
  if (!Number.isInteger(modelLaneDispatchTimeoutMs) || modelLaneDispatchTimeoutMs <= 0) {
    throw new Error('modelLaneDispatchTimeoutMs must be a positive integer');
  }
  if (!Number.isInteger(modelLaneStepDelayMs) || modelLaneStepDelayMs < 0) {
    throw new Error('modelLaneStepDelayMs must be a non-negative integer');
  }

  // Durable-side-effect ledger for the idempotent top-level backup cleanup.
  // before() captures the original full backup.json payload; if a save/restore
  // throws before execute() restores it, the case runner's top-level cleanup
  // (invoked on harness error paths) restores it from here.
  const backupCleanupState = {
    originalPayload: null,
    field: null,
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
      timeoutMs: modelLaneDispatchTimeoutMs,
      proof: proof(
        'model_usage_events spend ledger cross-checked against models.json owner slots',
        'each charged lane resolves, via the owner file, to exactly the model that owner slot assigns',
      ),
      execute: async ({ sessionId, apiUserId, signal }) => {
        let stage = 'interactive_turn';
        return runModelLaneAttributionDispatch({
          timeoutMs: modelLaneDispatchTimeoutMs,
          parentSignal: signal,
          getStage: () => stage,
          run: async (dispatchSignal) => {
            // (1) Interactive lane: a plain foreground chat turn.
            const interactive = await postAndWait({
              services,
              sessionId,
              apiUserId,
              message: SPEND_MESSAGE,
              signal: dispatchSignal,
            });
            const interactiveTurnId = interactive.turnRecord?.turnId ?? null;
            // (2) Vision workload: a foreground turn carrying an inline image, whose
            //     turn record (and turnId) we recover so the image turn is attributed
            //     at turn granularity against the models.json vision owner slot.
            stage = 'vision_turn';
            if (modelLaneStepDelayMs > 0) await sleep(modelLaneStepDelayMs, dispatchSignal);
            const vision = await postAndWaitVisionInline({
              services,
              sessionId,
              apiUserId,
              signal: dispatchSignal,
            });
            const visionTurnId = vision.turnRecord?.turnId ?? null;
            // (3) Background lane: drive benign turns until the periodic
            //     emotion-appraisal gate opens and its background-lane call lands.
            const background = await driveBackgroundLane({
              services,
              sessionId,
              apiUserId,
              signal: dispatchSignal,
              stepDelayMs: modelLaneStepDelayMs,
              setStage: (nextStage) => {
                stage = nextStage;
              },
            });
            stage = 'ledger_read';
            let ledgerRows = [];
            const proofQueryFailures = [...background.proofQueryFailures];
            try {
              ledgerRows = await services.pgAll(
                MODEL_USAGE_QUERY,
                [sessionId, background.backgroundTurnId],
              );
            } catch (error) {
              proofQueryFailures.push({
                stage,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              });
            }
            stage = 'unknown_embedding_attribution_read';
            let unknownEmbeddingRows = [];
            try {
              unknownEmbeddingRows = await services.pgAll(
                UNKNOWN_EMBEDDING_ATTRIBUTION_QUERY,
              );
            } catch (error) {
              proofQueryFailures.push({
                stage,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              });
            }
            const modelsConfig = services.readJsonIfExists(modelsPath);
            return normalizeCustomOutcome({
              sessionId,
              request: { privacy: 'private', message: SPEND_MESSAGE },
              response: interactive.response,
              turnRecord: interactive.turnRecord,
              busyObservedAtMs: interactive.startedAtMs,
              sideChecks: {
                modelLane: {
                  modelsConfig,
                  ledgerRows,
                  unknownEmbeddingRows,
                  unknownEmbeddingAttribution:
                    summarizeUnknownEmbeddingAttribution(unknownEmbeddingRows),
                  proofQueryFailures,
                  // Each purpose is bound to the exact turn this case drove. Chat and
                  // vision remain distinguishable despite sharing the interactive
                  // charge lane; background additionally intersects the exact source
                  // turn with charge_lane=background.
                  laneExpectations: buildModelLaneExpectations({
                    interactiveTurnId,
                    visionTurnId,
                    backgroundTurnId: background.backgroundTurnId,
                  }),
                  driven: {
                    interactiveTurnId,
                    visionInline: Boolean(vision.response),
                    visionTurnId,
                    backgroundWarmupTurns: background.warmupTurns,
                    backgroundObserved: background.backgroundObserved,
                    backgroundOriginStage: background.backgroundOriginStage,
                    backgroundJobState: background.backgroundJobState,
                    backgroundTurnId: background.backgroundTurnId,
                    backgroundJobId: background.backgroundJobId,
                  },
                },
              },
            });
          },
        });
      },
      after: async ({ outcome }) => ({
        modelLane: outcome?.sideChecks?.modelLane
          ? {
            ledgerRowCount: Array.isArray(outcome.sideChecks.modelLane.ledgerRows)
              ? outcome.sideChecks.modelLane.ledgerRows.length
              : 0,
            unknownEmbeddingAttribution:
              outcome.sideChecks.modelLane.unknownEmbeddingAttribution ?? null,
            unknownEmbeddingRows:
              outcome.sideChecks.modelLane.unknownEmbeddingRows ?? [],
            driven: outcome.sideChecks.modelLane.driven ?? null,
          }
          : null,
      }),
      validatePersistedProof: ({ outcome }) => {
        const modelLane = outcome?.sideChecks?.modelLane ?? {};
        return [
          ...(Array.isArray(modelLane.proofQueryFailures)
            ? modelLane.proofQueryFailures.map((failure) => (
                `model-lane proof query failed at ${String(failure?.stage)}: ${String(failure?.error)}`
              ))
            : []),
          ...validateBackgroundModelDriveProof(modelLane.driven),
          ...validateModelLaneAttributionProof(modelLane),
        ];
      },
    },
    {
      id: 'backup_encryption_roundtrip',
      tier: 'nursery',
      variants: ['local'],
      feature: 'psfn-framework-irzz.1',
      sessionId: `hardening-backup-${ctx.runToken}`,
      message: BACKUP_MESSAGE,
      proof: proof(
        'backup.json owner-file snapshots captured across a real backup save (POST /api/admin/settings/backup)',
        'a full-payload save lands on disk with the mandatory encryption block intact, and an encryption-stripped payload is rejected fail-closed without touching backup.json',
      ),
      before: async () => {
        const backupBefore = services.readJsonIfExists(backupPath);
        if (!backupBefore || typeof backupBefore !== 'object' || Array.isArray(backupBefore)) {
          throw new Error(
            `backup_encryption_roundtrip could not read a backup.json owner file at ${backupPath}`,
          );
        }
        if (!hasBackupEncryptionBlock(backupBefore)) {
          throw new Error(
            'backup_encryption_roundtrip precondition failed: backup.json has no encryption block to protect',
          );
        }
        const field = pickBackupFlipField(backupBefore);
        if (!field) {
          throw new Error(
            'backup_encryption_roundtrip found no benign numeric retention field to flip in backup.json '
            + `(looked for ${BACKUP_FLIP_FIELD_CANDIDATES.join(', ')}); refusing to write`,
          );
        }
        const flipFrom = backupBefore[field];
        const flipTo = flipFrom + 1;
        // Full payloads: preserve every field, flip only the benign retention
        // scalar; strip the encryption block for the negative guard probe.
        const flippedPayload = { ...backupBefore, [field]: flipTo };
        const strippedPayload = { ...backupBefore };
        delete strippedPayload.encryption;
        // Seed the idempotent cleanup with the ORIGINAL full payload so an error
        // path can restore backup.json.
        backupCleanupState.originalPayload = backupBefore;
        backupCleanupState.field = field;
        backupCleanupState.restored = false;
        return { backupBefore, field, flipFrom, flipTo, flippedPayload, strippedPayload };
      },
      execute: async ({ sessionId, apiUserId, beforeChecks, signal }) => {
        // Ride a benign turn so the case has a completed turn record; the proof
        // itself comes only from the backup.json owner-file snapshots and the
        // save/restore/reject request outcomes.
        const main = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: BACKUP_MESSAGE,
          signal,
        });

        const { field, flipFrom, flipTo, flippedPayload, strippedPayload, backupBefore } = beforeChecks;

        // (a) POSITIVE round-trip: drive the REAL backup save path with a full
        //     payload that flips one benign scalar; snapshot backup.json across
        //     the write to prove it landed with the encryption block intact.
        const save = await postBackupConfig(services, flippedPayload, signal);
        const afterWrite = services.readJsonIfExists(backupPath);

        // Restore the original full payload immediately and confirm restoration.
        const restore = await postBackupConfig(
          services,
          backupCleanupState.originalPayload,
          signal,
        );
        const afterRestore = services.readJsonIfExists(backupPath);
        if (
          restore.ok
          && afterRestore && typeof afterRestore === 'object'
          && afterRestore[field] === flipFrom
          && hasBackupEncryptionBlock(afterRestore)
        ) {
          backupCleanupState.restored = true;
        }

        // (b) NEGATIVE guard probe: POST the irzz.1 regression shape (encryption
        //     block stripped) and prove the API rejects it AND backup.json is
        //     unchanged on disk.
        const reject = await postBackupConfig(services, strippedPayload, signal);
        const afterReject = services.readJsonIfExists(backupPath);

        return normalizeCustomOutcome({
          sessionId,
          request: { privacy: 'private', message: BACKUP_MESSAGE, backupSavePath: BACKUP_SAVE_PATH },
          response: main.response,
          turnRecord: main.turnRecord,
          busyObservedAtMs: main.startedAtMs,
          sideChecks: {
            backup: {
              field,
              flipFrom,
              flipTo,
              before: backupBefore,
              afterWrite,
              afterRestore,
              afterReject,
              save,
              restore,
              reject,
              restored: backupCleanupState.restored,
            },
          },
        });
      },
      after: async ({ outcome }) => ({
        backup: outcome?.sideChecks?.backup
          ? {
            field: outcome.sideChecks.backup.field,
            flipFrom: outcome.sideChecks.backup.flipFrom,
            flipTo: outcome.sideChecks.backup.flipTo,
            save: outcome.sideChecks.backup.save,
            restore: outcome.sideChecks.backup.restore,
            reject: outcome.sideChecks.backup.reject,
            restored: outcome.sideChecks.backup.restored,
          }
          : null,
      }),
      validatePersistedProof: ({ outcome }) => validateBackupEncryptionRoundTripProof(
        outcome?.sideChecks?.backup ?? {},
      ),
      // Idempotent top-level cleanup. The case runner calls this on harness error
      // paths (and again after a normal run). It restores the original backup.json
      // payload if execute() did not already confirm it, and is a near no-op once
      // the restore is confirmed. Returns the runner's { cleanup, cleanupErrors }
      // shape.
      cleanup: async () => {
        const cleanupErrors = [];
        const done = {
          restored: backupCleanupState.restored,
          alreadyClean: false,
        };
        if (!backupCleanupState.originalPayload) {
          // before() never derived a payload — nothing durable to undo.
          done.alreadyClean = true;
          return { cleanup: { backup: done }, cleanupErrors };
        }
        if (backupCleanupState.restored) {
          done.alreadyClean = true;
          return { cleanup: { backup: done }, cleanupErrors };
        }
        try {
          const restore = await postBackupConfig(services, backupCleanupState.originalPayload);
          const afterRestore = services.readJsonIfExists(backupPath);
          const field = backupCleanupState.field;
          if (
            restore.ok
            && afterRestore && typeof afterRestore === 'object'
            && (!field || afterRestore[field] === backupCleanupState.originalPayload[field])
            && hasBackupEncryptionBlock(afterRestore)
          ) {
            backupCleanupState.restored = true;
            done.restored = true;
          } else {
            cleanupErrors.push(
              `backup.json restore was not confirmed (status ${String(restore.status)}`
              + `${restore.error ? `: ${restore.error}` : ''})`,
            );
          }
        } catch (error) {
          cleanupErrors.push(
            `backup.json restore threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return { cleanup: { backup: done }, cleanupErrors };
      },
    },
  ];
}
