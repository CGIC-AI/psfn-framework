// ── Gateway intake screening composition (htm9.2) ──
//
// Builds the gateway process's IntakeScreeningService from intake-policy.json
// (system-data owner file): the deterministic L1 scanner pipeline, plus —
// when the ONNX model has been provisioned out-of-band — the L1.5 injection
// classifier as an async scorer, plus — when an OpenRouter backend is
// resolvable — the L2/L3 escalation port (htm9.6/htm9.7, escalation.ts) so
// the layered firewall actually escalates at runtime.
//
// L1.5 provisioning posture (htm9.2 wiring contract, tightened by cyy7l):
// - enforce mode: the ~700MiB ONNX weights are a HARD startup prerequisite.
//   When they are absent the gateway FAILS CLOSED at startup with an
//   actionable error naming `npm run provision:injection-model`. A degraded
//   L1-only firewall under an enforce posture is a fail-closed violation: the
//   posture reports "armed" while L1.5 scoring silently never runs.
// - shadow mode: weights remain optional. When absent the gateway emits ONE
//   loud structured startup warning (never per-message), screens on the
//   deterministic L1 layer alone, and marks the composition
//   `injectionClassifier.degraded` so intake health surfaces show it.
// In every mode a present-but-broken model directory fails startup (fail
// closed), and the classifier never downloads at runtime.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  createIntakeScreeningService,
  type IntakeEscalationPort,
  type IntakeScreeningServiceOptions,
  type IntakeScreeningService,
} from '../../../core/cogsec/intake/screening.js';
import { createIntakeL1Scanner } from '../../../core/cogsec/intake/scanners/index.js';
import {
  createIntakeQuarantineStore,
  type IntakeQuarantineStoreOptions,
  type IntakeQuarantineStore,
} from '../../../core/cogsec/intake/quarantine-store.js';
import { CogSecEventStore } from '../../../core/cogsec/events.js';
import { resolveCogSecEventsPath, resolveIntakeQuarantinePath } from '../../../persistence/layout.js';
import { loadIntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import { resolveOptionalCredentialReference } from '../../custody/credential-vault.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  assertInjectionModelProvisioned,
  createInjectionClassifier,
  INJECTION_CLASSIFIER_REQUIRED_FILES,
  INJECTION_CLASSIFIER_SCANNER_ID,
  type InjectionClassifier,
  type InjectionClassifierBackendFactory,
} from './injection-classifier.js';
import type { ScreenerBackend, ScreenerFetch } from './screener-transport.js';
import { createGatewayIntakeEscalationPort } from './escalation.js';
import {
  evaluateVisionIntake,
  toVisionIntakeImageScreenResult,
  type VisionIntakeImageInput,
  type VisionIntakeImageScreenResult,
} from './vision-screener.js';
import { resolveIntakeScreenerModels } from './screener-model-selection.js';

const log = createComponentLogger('GatewayIntakeScreening');

export const DEFAULT_INJECTION_MODEL_DIR = './models/prompt-injection-v2';

export function resolveInjectionModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PSFN_INJECTION_MODEL_DIR?.trim();
  return resolve(configured || DEFAULT_INJECTION_MODEL_DIR);
}

function isInjectionModelProvisioned(modelDir: string): boolean {
  return INJECTION_CLASSIFIER_REQUIRED_FILES.every((file) => existsSync(join(modelDir, file)));
}

/**
 * Gateway-facing vision intake screener (htm9.8): one call per inbound image,
 * exposed to the agent process through the `intake.screen_image` RPC method.
 */
export interface GatewayVisionIntakeScreener {
  screenImage(input: {
    image: VisionIntakeImageInput;
    originRef: string;
    originDetail?: string;
    /** Attachment index on the carrying message (envelope subject). */
    subjectIndex?: number;
    canonicalContactId?: string;
  }): Promise<VisionIntakeImageScreenResult>;
}

/**
 * Resolves the OpenRouter backend for the gateway-side intake screeners from
 * the openrouter provider config (providers.json apiBaseUrl + apiKeyRef).
 * Returns null when either half is missing — the vision-screener composition
 * below decides whether that is a loud skip (shadow) or a startup failure
 * (enforce; never screen-less delivery).
 */
export function resolveIntakeScreenerBackend(
  config: SubstrateConfig,
  env: NodeJS.ProcessEnv = process.env,
): ScreenerBackend | null {
  const apiBaseUrl = config.openRouterApiBaseUrl?.trim();
  if (!apiBaseUrl || !config.openRouterApiKeyRef) return null;
  const apiKey = resolveOptionalCredentialReference(
    config.credentialVault,
    config.openRouterApiKeyRef,
    env,
  );
  if (!apiKey) return null;
  return { apiBaseUrl, apiKey };
}

export interface GatewayIntakeScreeningComposition {
  screening: IntakeScreeningService | null;
  /** Durable quarantine store (htm9.11); null when the firewall is off. */
  quarantine: IntakeQuarantineStore | null;
  /**
   * Vision intake screener (htm9.8); null when the firewall is off, the
   * visionScreener policy is disabled, or (shadow mode only) no OpenRouter
   * backend is resolvable. Enforce mode with visionScreener enabled and no
   * backend FAILS STARTUP — images must never be delivered unscreened.
   */
  visionIntake: GatewayVisionIntakeScreener | null;
  /**
   * L1.5 injection-classifier capability, surfaced for intake health (cyy7l).
   * `enabled` reflects whether the ONNX classifier actually loaded. `degraded`
   * is true only in shadow mode with the weights absent — enforce mode fails
   * startup instead of degrading — and means the firewall is screening on the
   * deterministic L1 layer alone. `modelDir` is the resolved provisioning path.
   */
  injectionClassifier: {
    enabled: boolean;
    degraded: boolean;
    modelDir: string;
  };
  /** For shutdown: disposes the ONNX session when one was loaded. */
  dispose(): Promise<void>;
}

export async function composeGatewayIntakeScreening(input: {
  /** Hydrated canonical models/settings config used for purpose selection. */
  config: SubstrateConfig;
  systemDataDir: string;
  /** Companion data root; hosts the durable quarantine store (htm9.11). */
  companionDataDir: string;
  /**
   * OpenRouter backend for the L2/L3 escalation screeners (htm9.6/htm9.7)
   * and the vision intake screener (htm9.8), resolved by the caller via
   * `resolveIntakeScreenerBackend`. Null/absent means no backend is
   * available.
   */
  screenerBackend?: ScreenerBackend | null;
  /** Test seam for the L2/L3/vision screener transports; production uses global fetch. */
  screenerFetch?: ScreenerFetch;
  /** Called after a quarantine hold has been atomically persisted. */
  onQuarantineHeld?: () => void;
  /** Called for lazy held-item TTL expiry; content is never included. */
  onQuarantineExpired?: IntakeQuarantineStoreOptions['onExpired'];
  /** Called for structural fail-closed screening telemetry. */
  onFailClosedScreening?: IntakeScreeningServiceOptions['onFailClosed'];
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam for the L1.5 injection classifier backend. When provided the
   * classifier is treated as provisioned and constructed with this factory
   * (bypassing the on-disk weight check); production always loads the ONNX
   * weights from `modelDir`.
   */
  injectionBackendFactory?: InjectionClassifierBackendFactory;
}): Promise<GatewayIntakeScreeningComposition> {
  const modelDir = resolveInjectionModelDir(input.env ?? process.env);
  const policy = loadIntakePolicyConfig(input.systemDataDir);
  if (policy.mode === 'off') {
    log.warn("Intake firewall mode is 'off': gateway intake screening is not wired");
    return {
      screening: null,
      quarantine: null,
      visionIntake: null,
      injectionClassifier: { enabled: false, degraded: false, modelDir },
      dispose: async () => {},
    };
  }
  const screenerModels = resolveIntakeScreenerModels(input.config, {
    l3DualModel: policy.l3Screener.dualModel,
    visionEnabled: policy.visionScreener.enabled,
  });

  // Held items land in companion-data/state/intake-quarantine.json; the
  // Garden approval queue reads the same file through its own instance.
  const durableQuarantine = createIntakeQuarantineStore(
    resolveIntakeQuarantinePath(input.companionDataDir),
    {
      itemTtlHours: policy.quarantine.itemTtlHours,
      maxHeldItems: policy.quarantine.maxHeldItems,
      ...(input.onQuarantineExpired ? { onExpired: input.onQuarantineExpired } : {}),
    },
  );
  const quarantine: IntakeQuarantineStore = input.onQuarantineHeld
    ? {
        hold: (holdInput) => {
          const held = durableQuarantine.hold(holdInput);
          input.onQuarantineHeld?.();
          return held;
        },
        list: () => durableQuarantine.list(),
        getById: (id) => durableQuarantine.getById(id),
        applyDecision: (decision) => durableQuarantine.applyDecision(decision),
        findByArtifactPath: (path) => durableQuarantine.findByArtifactPath(path),
        findByArtifactPaths: (paths) => durableQuarantine.findByArtifactPaths(paths),
        recordAccessAttempt: (attempt) => durableQuarantine.recordAccessAttempt(attempt),
        recordAccessAttempts: (attempts) => durableQuarantine.recordAccessAttempts(attempts),
        checkArtifactAccesses: (batch) => durableQuarantine.checkArtifactAccesses(batch),
        readRevisionToken: () => durableQuarantine.readRevisionToken(),
        listActiveArtifactPaths: () => durableQuarantine.listActiveArtifactPaths(),
        listActiveArtifactIdentities: () => durableQuarantine.listActiveArtifactIdentities(),
      }
    : durableQuarantine;

  let classifier: InjectionClassifier | null = null;
  let injectionClassifierDegraded = false;
  const injectionModelProvisioned = input.injectionBackendFactory != null
    || isInjectionModelProvisioned(modelDir);
  if (injectionModelProvisioned) {
    // Present model directories must load correctly — a broken provision
    // throws here and stops gateway startup (fail closed, no silent skip).
    classifier = await createInjectionClassifier({
      modelDir,
      labelThreshold: policy.injectionClassifier.labelThreshold,
      ...(input.injectionBackendFactory
        ? { backendFactory: input.injectionBackendFactory }
        : {}),
    });
    log.info('Intake L1.5 injection classifier loaded', { modelDir });
  } else if (existsSync(modelDir)) {
    // A partial footprint means provisioning began but did not complete.
    // Treat it as broken state, not as the clean "not installed" case: an
    // interrupted download must never silently downgrade live screening.
    assertInjectionModelProvisioned(modelDir);
  } else if (policy.mode === 'enforce') {
    // FAIL CLOSED (cyy7l): an enforce-mode intake firewall that silently runs
    // on the deterministic L1 layer alone reports "armed" while the L1.5
    // injection classifier never scores anything. The ~700MiB weights are
    // gitignored and provisioned out of band, so a kube target that skipped
    // provisioning would otherwise pass this point degraded under an enforce
    // posture. Refuse to start until the weights are on disk.
    throw new Error(
      'Intake firewall mode=enforce but the L1.5 injection classifier weights '
      + `are not provisioned at ${modelDir}. Provision them onto every deploy `
      + "target's model-cache before startup — "
      + `\`npm run provision:injection-model -- --dest ${modelDir}\` — then `
      + 'restart the gateway. Refusing to run an enforce-mode intake firewall '
      + 'on L1 scanners alone (no silent L1-only operation under enforce).',
    );
  } else {
    // shadow mode: a single loud, structured startup warning (never
    // per-message) plus a degraded-capability flag on the composition so
    // intake health surfaces can show the firewall is screening without L1.5.
    injectionClassifierDegraded = true;
    log.warn(
      'Intake L1.5 injection classifier weights are not provisioned; gateway '
      + 'intake screening runs on the deterministic L1 layer alone (DEGRADED). '
      + 'Tolerated only because intake mode=shadow — provision the weights onto '
      + 'the model-cache before switching to enforce (enforce fails closed here): '
      + '`npm run provision:injection-model`.',
      { modelDir, mode: policy.mode, injectionClassifierDegraded: true },
    );
  }

  // ── L2/L3 escalation port (htm9.6/htm9.7) ──
  // backend present  → composed; screen() escalates per the policy's
  //                    thresholds, mandatory tiers, and fail-closed actions.
  // backend absent   → enforce mode with mandatory escalation tiers FAILS
  //                    STARTUP: the policy unconditionally demands deep
  //                    screening that cannot run, and an enforce surface must
  //                    never silently deliver what policy says to deep-screen
  //                    (same posture as the vision screener below). Otherwise
  //                    the escalation layers are skipped LOUDLY (same posture
  //                    as unprovisioned L1.5 weights).
  const backend = input.screenerBackend ?? null;
  let escalation: IntakeEscalationPort | null = null;
  if (backend) {
    // Multi-writer JSON store (same file the gateway core, contact-block
    // gate, and Garden use); reloads from disk per operation, so a second
    // instance here is safe.
    const cogSecEvents = new CogSecEventStore(
      resolveCogSecEventsPath(input.companionDataDir),
    );
    escalation = createGatewayIntakeEscalationPort({
      policy,
      l2Model: screenerModels.l2,
      l3Models: screenerModels.l3,
      backend,
      quarantine,
      cogSecEvents,
      ...(input.screenerFetch ? { fetch: input.screenerFetch } : {}),
      ...(input.onFailClosedScreening
        ? { onFailClosed: input.onFailClosedScreening }
        : {}),
    });
  } else {
    const mandatoryTiers = [...new Set([
      ...policy.l2Screener.mandatoryTiers,
      ...policy.l3Screener.mandatoryTiers,
    ])];
    if (policy.mode === 'enforce' && mandatoryTiers.length > 0) {
      throw new Error(
        `Intake policy mandates L2/L3 deep screening for tiers [${mandatoryTiers.join(', ')}] `
        + 'with mode=enforce but no OpenRouter backend is resolvable '
        + '(providers.json openrouter apiBaseUrl/apiKeyRef). Configure the '
        + 'openrouter provider or remove the l2Screener/l3Screener '
        + 'mandatoryTiers from intake-policy.json.',
      );
    }
    log.warn(
      'Intake L2/L3 escalation screeners have no OpenRouter backend; gateway '
      + 'intake screening runs without escalation. Configure the openrouter '
      + 'provider (providers.json apiBaseUrl/apiKeyRef) to enable L2/L3.',
    );
  }

  const screening = createIntakeScreeningService({
    policy,
    l1: createIntakeL1Scanner({ schemeActions: policy.urlScanner.schemeActions }),
    ...(classifier
      ? {
        injectionScorer: {
          scannerId: INJECTION_CLASSIFIER_SCANNER_ID,
          classify: (text: string) => classifier.classify(text),
        },
      }
      : {}),
    ...(escalation ? { escalation } : {}),
    quarantine,
    actor: 'gateway:intake-screening',
    ...(input.onFailClosedScreening ? { onFailClosed: input.onFailClosedScreening } : {}),
  });
  // ── Vision intake screener (htm9.8) ──
  // enabled + backend        → wired.
  // enabled + no backend     → enforce: FAIL STARTUP (an enforce-mode image
  //                            surface with no screener would either deliver
  //                            unscreened or withhold every image — both are
  //                            misconfigurations to surface, not runtime
  //                            states); shadow: loud skip, observe-only.
  // disabled                 → not wired (pre-htm9.8 behavior, explicit knob).
  let visionIntake: GatewayVisionIntakeScreener | null = null;
  if (policy.visionScreener.enabled) {
    if (backend) {
      visionIntake = {
        screenImage: async (request) => toVisionIntakeImageScreenResult(
          await evaluateVisionIntake({
            image: request.image,
            origin: {
              ref: request.originRef.slice(0, 2048),
              ...(request.originDetail !== undefined
                ? { detail: request.originDetail.slice(0, 512) }
                : {}),
            },
            ...(request.subjectIndex !== undefined
              ? { subject: { kind: 'attachment', index: request.subjectIndex } }
              : {}),
            ...(request.canonicalContactId !== undefined
              ? { canonicalContactId: request.canonicalContactId }
              : {}),
            policy,
            model: screenerModels.vision!,
            screening,
            backend,
            quarantine,
            ...(input.screenerFetch ? { fetch: input.screenerFetch } : {}),
          }),
        ),
      };
    } else if (policy.mode === 'enforce') {
      throw new Error(
        'Intake vision screener is enabled with mode=enforce but no OpenRouter '
        + 'backend is resolvable (providers.json openrouter apiBaseUrl/apiKeyRef). '
        + 'Configure the openrouter provider or set intake-policy.json '
        + 'visionScreener.enabled=false.',
      );
    } else {
      log.warn(
        'Intake vision screener is enabled but no OpenRouter backend is resolvable; '
        + 'images pass UNSCREENED in shadow mode. Configure the openrouter provider '
        + '(providers.json apiBaseUrl/apiKeyRef) to enable image screening.',
      );
    }
  }

  log.info('Gateway intake screening composed', {
    mode: policy.mode,
    l15Enabled: classifier !== null,
    l15Degraded: injectionClassifierDegraded,
    escalationWired: escalation !== null,
    visionScreenerEnabled: policy.visionScreener.enabled,
    visionIntakeWired: visionIntake !== null,
  });

  return {
    screening,
    quarantine,
    visionIntake,
    injectionClassifier: {
      enabled: classifier !== null,
      degraded: injectionClassifierDegraded,
      modelDir,
    },
    dispose: async () => {
      await classifier?.dispose();
    },
  };
}
