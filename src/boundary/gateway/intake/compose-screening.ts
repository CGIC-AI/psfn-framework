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
import { loadIntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import {
  createInjectionClassifier,
  INJECTION_CLASSIFIER_REQUIRED_FILES,
  INJECTION_CLASSIFIER_SCANNER_ID,
  type InjectionClassifier,
} from './injection-classifier.js';

const log = createComponentLogger('GatewayIntakeScreening');

export const DEFAULT_INJECTION_MODEL_DIR = './models/prompt-injection-v2';

export function resolveInjectionModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PSFN_INJECTION_MODEL_DIR?.trim();
  return resolve(configured || DEFAULT_INJECTION_MODEL_DIR);
}

function isInjectionModelProvisioned(modelDir: string): boolean {
  return INJECTION_CLASSIFIER_REQUIRED_FILES.every((file) => existsSync(join(modelDir, file)));
}

export interface GatewayIntakeScreeningComposition {
  screening: IntakeScreeningService | null;
  /** For shutdown: disposes the ONNX session when one was loaded. */
  dispose(): Promise<void>;
}

export async function composeGatewayIntakeScreening(input: {
  systemDataDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GatewayIntakeScreeningComposition> {
  const policy = loadIntakePolicyConfig(input.systemDataDir);
  if (policy.mode === 'off') {
    log.warn("Intake firewall mode is 'off': gateway intake screening is not wired");
    return { screening: null, dispose: async () => {} };
  }

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
    actor: 'gateway:intake-screening',
  });
  log.info('Gateway intake screening composed', {
    mode: policy.mode,
    l15Enabled: classifier !== null,
  });

  return {
    screening,
    dispose: async () => {
      await classifier?.dispose();
    },
  };
}
