// ── Gateway intake screening composition (htm9.2) ──
//
// Builds the gateway process's IntakeScreeningService from intake-policy.json
// (system-data owner file): the deterministic L1 scanner pipeline plus — when
// the ONNX model has been provisioned out-of-band — the L1.5 injection
// classifier as an async scorer.
//
// L1.5 provisioning posture (from the htm9.2 wiring contract): weights are
// OPTIONAL for this wiring. When `npm run provision:injection-model` has not
// been run, the gateway SKIPS the classifier LOUDLY (structured warn log at
// startup) and screens on L1 alone; it never downloads at runtime and never
// silently degrades an already-provisioned model (a present-but-broken model
// directory fails startup, fail closed).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  createIntakeScreeningService,
  type IntakeScreeningService,
} from '../../../core/cogsec/intake/screening.js';
import { createIntakeL1Scanner } from '../../../core/cogsec/intake/scanners/index.js';
import {
  createIntakeQuarantineStore,
  type IntakeQuarantineStore,
} from '../../../core/cogsec/intake/quarantine-store.js';
import { resolveIntakeQuarantinePath } from '../../../persistence/layout.js';
import { loadIntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import { resolveOptionalCredentialReference } from '../../custody/credential-vault.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  createInjectionClassifier,
  INJECTION_CLASSIFIER_REQUIRED_FILES,
  INJECTION_CLASSIFIER_SCANNER_ID,
  type InjectionClassifier,
} from './injection-classifier.js';
import type { ScreenerBackend } from './screener-transport.js';
import {
  evaluateVisionIntake,
  toVisionIntakeImageScreenResult,
  type VisionIntakeImageInput,
  type VisionIntakeImageScreenResult,
} from './vision-screener.js';

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
  /** For shutdown: disposes the ONNX session when one was loaded. */
  dispose(): Promise<void>;
}

export async function composeGatewayIntakeScreening(input: {
  systemDataDir: string;
  /** Companion data root; hosts the durable quarantine store (htm9.11). */
  companionDataDir: string;
  /**
   * OpenRouter backend for the vision intake screener (htm9.8), resolved by
   * the caller via `resolveIntakeScreenerBackend`. Null/absent means no
   * backend is available.
   */
  screenerBackend?: ScreenerBackend | null;
  env?: NodeJS.ProcessEnv;
}): Promise<GatewayIntakeScreeningComposition> {
  const policy = loadIntakePolicyConfig(input.systemDataDir);
  if (policy.mode === 'off') {
    log.warn("Intake firewall mode is 'off': gateway intake screening is not wired");
    return { screening: null, quarantine: null, visionIntake: null, dispose: async () => {} };
  }

  // Held items land in companion-data/state/intake-quarantine.json; the
  // Garden approval queue reads the same file through its own instance.
  const quarantine = createIntakeQuarantineStore(
    resolveIntakeQuarantinePath(input.companionDataDir),
    {
      itemTtlHours: policy.quarantine.itemTtlHours,
      maxHeldItems: policy.quarantine.maxHeldItems,
    },
  );

  let classifier: InjectionClassifier | null = null;
  const modelDir = resolveInjectionModelDir(input.env ?? process.env);
  if (isInjectionModelProvisioned(modelDir)) {
    // Present model directories must load correctly — a broken provision
    // throws here and stops gateway startup (fail closed, no silent skip).
    classifier = await createInjectionClassifier({
      modelDir,
      labelThreshold: policy.injectionClassifier.labelThreshold,
    });
    log.info('Intake L1.5 injection classifier loaded', { modelDir });
  } else {
    log.warn(
      'Intake L1.5 injection classifier weights are not provisioned; '
      + 'gateway intake screening runs on L1 scanners alone. '
      + 'Run `npm run provision:injection-model` to enable L1.5 scoring.',
      { modelDir },
    );
  }

  const screening = createIntakeScreeningService({
    policy,
    l1: createIntakeL1Scanner(),
    ...(classifier
      ? {
        injectionScorer: {
          scannerId: INJECTION_CLASSIFIER_SCANNER_ID,
          classify: (text: string) => classifier.classify(text),
        },
      }
      : {}),
    quarantine,
    actor: 'gateway:intake-screening',
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
  const backend = input.screenerBackend ?? null;
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
            screening,
            backend,
            quarantine,
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
    visionScreenerEnabled: policy.visionScreener.enabled,
    visionIntakeWired: visionIntake !== null,
  });

  return {
    screening,
    quarantine,
    visionIntake,
    dispose: async () => {
      await classifier?.dispose();
    },
  };
}
