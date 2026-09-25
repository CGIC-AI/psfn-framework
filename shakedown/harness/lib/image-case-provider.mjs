import { InvalidEnvError, requireEnv } from './env.mjs';

/**
 * Image-provider selection for the image_create / image_edit / selfie_create
 * cases (psfn-framework-t2q1w). The cases used to hard-code provider "auto",
 * which overrides the owner-file imageProvider and can never reach the
 * explicit-only OpenRouter provider. The round now names the provider:
 *
 * - `settings`: the prompt omits provider so the deployment's configured
 *   imageProvider (settings.json) selects it.
 * - `auto` | `fal` | `comfyui` | `comfyui_mcp` | `openrouter`: the prompt
 *   passes that provider and the case requires a successful tool result
 *   reporting it (for every value except `auto`).
 *
 * There is no default: selecting an image case without the variable fails
 * closed, so an OpenRouter round cannot silently exercise another provider.
 */
export const IMAGE_CASE_PROVIDER_ENV = 'PSFN_SHAKEDOWN_IMAGE_PROVIDER';

const IMAGE_CASE_IDS = new Set(['image_create', 'image_edit', 'selfie_create']);
const PHASES_WITHOUT_IMAGE_CASES = new Set(['baseline', 'nursery']);
const IMAGE_CASE_PROVIDERS = new Set(['settings', 'auto', 'fal', 'comfyui', 'comfyui_mcp', 'openrouter']);
const PROVIDERS_WITHOUT_PROOF = new Set(['settings', 'auto']);

export function resolveImageCaseProvider(env = process.env) {
  const provider = requireEnv(
    IMAGE_CASE_PROVIDER_ENV,
    `image case provider (${[...IMAGE_CASE_PROVIDERS].join('|')}); "settings" uses the deployment's configured imageProvider`,
    env,
  );
  if (!IMAGE_CASE_PROVIDERS.has(provider)) {
    throw new InvalidEnvError(
      IMAGE_CASE_PROVIDER_ENV,
      `expected one of ${[...IMAGE_CASE_PROVIDERS].join(', ')}, got ${JSON.stringify(provider)}`,
    );
  }
  return provider;
}

/** Resolve the provider only when the run selects an image case. */
export function resolveImageCaseProviderForCases({ caseIds, phase }, env = process.env) {
  const selectedExplicitly = [...caseIds].some((caseId) => IMAGE_CASE_IDS.has(caseId));
  const selectedByPhase = caseIds.size === 0 && !PHASES_WITHOUT_IMAGE_CASES.has(phase);
  if (!selectedExplicitly && !selectedByPhase) return null;
  return resolveImageCaseProvider(env);
}

/** The provider argument clause for a case prompt ('' lets settings select). */
export function imageProviderPromptClause(provider) {
  return provider === 'settings' ? '' : `provider "${provider}", `;
}

function toolMessageText(entry) {
  if (typeof entry?.contentText === 'string') return entry.contentText;
  return typeof entry?.contentPreview === 'string' ? entry.contentPreview : '';
}

function toolSucceeded(archiveToolMessages, toolName) {
  return Array.isArray(archiveToolMessages) && archiveToolMessages.some((entry) => (
    entry?.toolName === toolName
    && entry?.isError !== true
    && toolMessageText(entry).trim().length > 0
  ));
}

/**
 * Failures when an explicitly selected provider has no successful tool result
 * that reports it. `settings` and `auto` resolve server-side, so any
 * successful result is proof for them.
 */
export function imageProviderProofFailures(archiveToolMessages, toolName, provider) {
  if (PROVIDERS_WITHOUT_PROOF.has(provider)) return [];
  const successful = Array.isArray(archiveToolMessages)
    ? archiveToolMessages.filter((entry) => entry?.toolName === toolName && entry?.isError !== true)
    : [];
  const reported = successful
    .map((entry) => /"provider"\s*:\s*"([a-z_]+)"/u.exec(toolMessageText(entry))?.[1])
    .filter((value) => typeof value === 'string');
  if (reported.includes(provider)) return [];
  return [
    `${toolName} must succeed on provider "${provider}"; observed ${reported.length > 0 ? reported.join(', ') : 'no successful provider result'}`,
  ];
}

function imageCaseVerdict(caseId, toolName, provider) {
  return ({ parsedAssistant, archiveToolMessages }) => {
    if (!PROVIDERS_WITHOUT_PROOF.has(provider)) {
      return imageProviderProofFailures(archiveToolMessages, toolName, provider);
    }
    return parsedAssistant?.worked === true || toolSucceeded(archiveToolMessages, toolName)
      ? []
      : [`${caseId} worked must be true or have successful ${toolName} tool proof`];
  };
}

/** The image_create, image_edit, and selfie_create cases for one provider. */
export function buildImageGenerationCases({ runToken, provider, editSourceUrls }) {
  if (!IMAGE_CASE_PROVIDERS.has(provider)) {
    throw new Error(`image cases require a resolved provider, got ${JSON.stringify(provider)}`);
  }
  const providerClause = imageProviderPromptClause(provider);
  return [
    {
      id: 'image_create',
      sessionId: `apprentice-image-create-${runToken}`,
      expectedTools: ['generate_image'],
      actionSensitive: true,
      actionSuccessKeys: ['worked'],
      message:
        `Then call generate_image with action "generate", ${providerClause}prompt "a red ceramic mug on a steel workbench, sharp studio lighting", width 512, height 512, aspect_ratio "1:1", num_images 1. `
        + 'Return only a JSON object with keys worked and note.',
      validateParsedAssistant: imageCaseVerdict('image_create', 'generate_image', provider),
      timeoutMs: 90000,
    },
    {
      id: 'image_edit',
      sessionId: `apprentice-image-edit-${runToken}`,
      expectedTools: ['generate_image'],
      actionSensitive: true,
      actionSuccessKeys: ['worked'],
      message:
        `Then call generate_image with action "edit", ${providerClause}input_urls=${JSON.stringify(editSourceUrls)}, prompt "make a photo of the man driving the car down the california coastline", aspect_ratio "auto", resolution "1K", num_images 1. `
        + 'Return only a JSON object with keys worked and note.',
      validateParsedAssistant: imageCaseVerdict('image_edit', 'generate_image', provider),
      timeoutMs: 90000,
    },
    {
      id: 'selfie_create',
      sessionId: `apprentice-selfie-${runToken}`,
      expectedTools: ['selfie_create'],
      suggestTools: ['selfie_create'],
      actionSensitive: true,
      actionSuccessKeys: ['worked'],
      message:
        'selfie_create is a core tool that is already active — call it directly and do not wait for or depend on a toolset activation handshake. '
        + `Call selfie_create with ${providerClause}prompt "close portrait, direct eye contact, neutral lighting, plain background", width 512, height 512, aspect_ratio "1:1", num_images 1. `
        + 'Return only a JSON object with keys worked and note.',
      validateParsedAssistant: imageCaseVerdict('selfie_create', 'selfie_create', provider),
      timeoutMs: 90000,
    },
  ];
}
