// ── Onboarding flow orchestration (psfn-framework-wckv.1.1 / wckv.1.2) ──
// Drives the interactive flow through the Prompter seam, assembles a complete
// OnboardingPlan (no disk writes), then commits owner files + .env abort-safely.
// Every prompt happens before any write, so aborting mid-flow leaves zero files.

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  InstallMode,
  OnboardingPlan,
  PersistenceRootPlan,
  Prompter,
  ProviderSelection,
  VoiceSelection,
} from './types.js';
import { INSTALL_MODES, modeGuidance } from './modes.js';
import {
  defaultModelSlugs,
  discoverProviderTypes,
  discoverVoiceProviders,
  voiceProviderEnvName,
} from './discovery.js';
import { commitOwnerFiles, detectExistingOwnerFiles } from './config-generator.js';
import { commitEnv, type EnvEntry } from './env-writer.js';
import { checkProviderConnectivity, type ConnectivityResult } from './connectivity.js';

export interface OnboardingDeps {
  prompter: Prompter;
  seedDir: string;
  /** Repo-root .env path. */
  envPath: string;
  /** Override the mode's default persistence roots (used by tests). */
  rootsOverride?: Partial<Record<InstallMode, PersistenceRootPlan>>;
  /** Injected connectivity probe (tests). */
  connectivity?: (provider: ProviderSelection) => Promise<ConnectivityResult>;
}

export interface OnboardingOutcome {
  plan: OnboardingPlan;
  writtenPaths: string[];
  envWritten: boolean;
}

export async function runOnboarding(deps: OnboardingDeps): Promise<OnboardingOutcome> {
  const { prompter } = deps;
  prompter.info('PSFN onboarding — configure a fresh install from clone to first chat.');

  const mode = (await prompter.choice(
    'How do you want to run PSFN?',
    Object.values(INSTALL_MODES).map((info) => ({
      value: info.mode,
      label: info.label,
      hint: info.hint,
    })),
  )) as InstallMode;
  const modeInfo = INSTALL_MODES[mode];
  const roots = deps.rootsOverride?.[mode] ?? modeInfo.defaultRoots;

  // Idempotency: detect an existing config and offer update vs abort.
  const provisionalPlanForDetection = draftPlan({ mode, roots, seedDir: deps.seedDir });
  const existing = detectExistingOwnerFiles(provisionalPlanForDetection);
  let updateExisting = false;
  if (existing.length > 0) {
    prompter.info(`\nFound ${existing.length} existing owner file(s) in the target root(s).`);
    const decision = await prompter.choice('An existing configuration is present. What now?', [
      { value: 'update', label: 'Update — overwrite the owner files with the new selections' },
      { value: 'abort', label: 'Abort — leave everything untouched' },
    ]);
    if (decision === 'abort') {
      throw new OnboardingCancelled('Existing configuration left untouched.');
    }
    updateExisting = true;
  }

  const provider = await selectProvider(prompter, modeInfo.capturesHostSecret);
  const models = await selectModels(prompter, deps.seedDir);
  const voice = await selectVoice(prompter, modeInfo.capturesHostSecret);

  // Optional connectivity check (only when we hold a key value and are not k8s).
  if (modeInfo.capturesHostSecret && provider.apiKeyValue.length > 0) {
    const wantCheck = await prompter.confirm(
      'Run an optional connectivity check against the provider now? (skip for offline setup)',
      { default: false },
    );
    if (wantCheck) {
      const probe = deps.connectivity ?? ((p) => checkProviderConnectivity(p));
      const result = await probe(provider);
      prompter.info(result.ok ? `  OK: ${result.message}` : `  WARNING: ${result.message}`);
      if (!result.ok) {
        const proceed = await prompter.confirm(
          'The connectivity check did not pass. Write the configuration anyway?',
          { default: true },
        );
        if (!proceed) {
          throw new OnboardingCancelled('Aborted after a failed connectivity check; nothing was written.');
        }
      }
    }
  }

  const envEntries = buildEnvEntries({ mode, roots, provider, voice, capturesHostSecret: modeInfo.capturesHostSecret });

  const plan: OnboardingPlan = {
    mode,
    roots,
    seedDir: deps.seedDir,
    provider,
    models,
    voice,
    companionId: randomUUID(),
    envEntries,
    updateExisting,
  };

  // Commit: owner files first (validated internally), then .env.
  const { writtenPaths } = commitOwnerFiles(plan);
  let envWritten = false;
  if (modeInfo.capturesHostSecret && envEntries.length > 0) {
    commitEnv(deps.envPath, envEntries.map(toEnvEntry));
    envWritten = true;
  }

  prompter.info(`\nWrote ${writtenPaths.length} owner file(s).`);
  if (envWritten) prompter.info(`Updated ${deps.envPath} with ${envEntries.length} entry/entries (secrets not shown).`);
  for (const line of modeGuidance(mode, provider)) prompter.info(line);

  return { plan, writtenPaths, envWritten };
}

async function selectProvider(prompter: Prompter, capturesHostSecret: boolean): Promise<ProviderSelection> {
  const types = discoverProviderTypes();
  const chosenType = await prompter.choice(
    'Which LLM provider?',
    types.map((info) => ({ value: info.type, label: info.label, hint: info.type })),
  );
  const info = types.find((entry) => entry.type === chosenType);
  if (!info) throw new Error(`Unknown provider type: ${chosenType}`);

  const id = (await prompter.text('Provider id (registry key)', { default: info.type })).toLowerCase();
  const apiBaseUrl = await prompter.text('API base URL', {
    default: info.defaultApiBaseUrl,
    allowEmpty: false,
  });
  const modelsApiUrl = info.requiresModelsApiUrl
    ? await prompter.text('Models list URL', { default: info.defaultModelsApiUrl, allowEmpty: false })
    : undefined;
  const apiKeyEnvName = (await prompter.text('Env var name for the API key', {
    default: info.defaultApiKeyEnvName,
  })).toUpperCase();

  let apiKeyValue = '';
  if (capturesHostSecret) {
    apiKeyValue = await prompter.secret(`API key value for ${apiKeyEnvName} (input hidden)`);
  } else {
    prompter.info(`  (Kubernetes mode: provide ${apiKeyEnvName} as a cluster Secret; no key captured here.)`);
  }

  return {
    id,
    type: info.type,
    label: info.label,
    apiBaseUrl,
    ...(modelsApiUrl ? { modelsApiUrl } : {}),
    apiKeyEnvName,
    apiKeyValue,
  };
}

async function selectModels(prompter: Prompter, seedDir: string): Promise<{ primaryModelSlug: string; extractionModelSlug: string }> {
  const defaults = defaultModelSlugs(seedDir);
  const primaryModelSlug = await prompter.text('Primary chat model slug', { default: defaults.primary });
  const extractionModelSlug = await prompter.text('Background/extraction model slug', { default: defaults.extraction });
  return { primaryModelSlug, extractionModelSlug };
}

async function selectVoice(prompter: Prompter, capturesHostSecret: boolean): Promise<VoiceSelection> {
  const enable = await prompter.confirm('Enable voice (STT/TTS)?', { default: false });
  if (!enable) return { enabled: false, secrets: [] };

  const surface = discoverVoiceProviders();
  const sttProvider = surface.sttProviders.length > 0
    ? await prompter.choice('Speech-to-text provider', surface.sttProviders.map((p) => ({ value: p, label: p })))
    : undefined;
  const ttsProvider = surface.ttsProviders.length > 0
    ? await prompter.choice('Text-to-speech provider', surface.ttsProviders.map((p) => ({ value: p, label: p })))
    : undefined;

  const secrets: Array<{ envName: string; value: string }> = [];
  if (capturesHostSecret) {
    for (const [kind, providerId] of [['stt', sttProvider], ['tts', ttsProvider]] as const) {
      if (!providerId) continue;
      const envName = voiceProviderEnvName(kind, providerId);
      if (!envName) continue;
      if (secrets.some((entry) => entry.envName === envName)) continue;
      const value = await prompter.secret(`API key value for ${envName} (input hidden)`);
      if (value.length > 0) secrets.push({ envName, value });
    }
  }

  return {
    enabled: true,
    ...(sttProvider ? { sttProvider } : {}),
    ...(ttsProvider ? { ttsProvider } : {}),
    secrets,
  };
}

export function buildEnvEntries(input: {
  mode: InstallMode;
  roots: PersistenceRootPlan;
  provider: ProviderSelection;
  voice: VoiceSelection;
  capturesHostSecret: boolean;
}): OnboardingPlan['envEntries'] {
  if (!input.capturesHostSecret) return [];
  const entries: OnboardingPlan['envEntries'] = [];
  if (input.mode === 'local') {
    entries.push({
      envName: 'DATA_DIR',
      value: input.roots.systemDataDir,
      comment: 'Local dev shared runtime data root (generated by npm run onboard)',
    });
  }
  if (input.provider.apiKeyValue.length > 0) {
    entries.push({
      envName: input.provider.apiKeyEnvName,
      value: input.provider.apiKeyValue,
      comment: `Primary LLM provider key (${input.provider.label})`,
    });
  }
  for (const secret of input.voice.secrets) {
    entries.push({ envName: secret.envName, value: secret.value, comment: 'Voice provider key' });
  }
  return entries;
}

function toEnvEntry(entry: OnboardingPlan['envEntries'][number]): EnvEntry {
  return { envName: entry.envName, value: entry.value, ...(entry.comment ? { comment: entry.comment } : {}) };
}

/** Minimal plan used only for existing-config detection (no secrets needed). */
function draftPlan(input: { mode: InstallMode; roots: PersistenceRootPlan; seedDir: string }): OnboardingPlan {
  return {
    mode: input.mode,
    roots: input.roots,
    seedDir: input.seedDir,
    provider: {
      id: 'placeholder',
      type: 'openrouter',
      label: 'placeholder',
      apiBaseUrl: 'https://example.invalid/v1',
      apiKeyEnvName: 'PLACEHOLDER',
      apiKeyValue: '',
    },
    models: { primaryModelSlug: 'x', extractionModelSlug: 'y' },
    voice: { enabled: false, secrets: [] },
    companionId: '00000000-0000-4000-8000-000000000000',
    envEntries: [],
    updateExisting: false,
  };
}

/** Thrown when the operator chooses to abort at a decision point. */
export class OnboardingCancelled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingCancelled';
  }
}

export function resolveDefaultEnvPath(cwd = process.cwd()): string {
  return join(resolve(cwd), '.env');
}
