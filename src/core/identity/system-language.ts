import type { PromptLayerStatePort } from './prompt-state-port.js';
import type { PromptLayer } from './prompt-types.js';
import {
  DEFAULT_SYSTEM_LANGUAGE_TEMPLATES,
  SYSTEM_LANGUAGE_LAYER_IDENTIFIER,
  SYSTEM_LANGUAGE_LAYER_NAME,
  SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER,
  SYSTEM_LANGUAGE_LAYER_TYPE,
  cloneDefaultSystemLanguageTemplates,
  composeDefaultSystemLanguageLayerContent,
  parseSystemLanguageLayerContent,
  renderSystemLanguageTemplateText,
  validateSystemLanguageLayerContent,
} from './system-language-contracts.js';
import type {
  SystemLanguageDiagnostic,
  SystemLanguageRenderResult,
  SystemLanguageTemplateKey,
  SystemLanguageTemplateResolution,
} from './system-language-contracts.js';
import { createComponentLogger } from '../../shared/logger.js';

export {
  DEFAULT_SYSTEM_LANGUAGE_TEMPLATES,
  SYSTEM_LANGUAGE_LAYER_IDENTIFIER,
  SYSTEM_LANGUAGE_LAYER_NAME,
  SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER,
  SYSTEM_LANGUAGE_LAYER_TYPE,
  SYSTEM_LANGUAGE_MAX_TEMPLATE_CHARS,
  SYSTEM_LANGUAGE_SCHEMA_VERSION,
  SYSTEM_LANGUAGE_TEMPLATE_KEYS,
  cloneDefaultSystemLanguageTemplates,
  composeDefaultSystemLanguageLayerContent,
  normalizeSystemLanguageTemplateText,
  parseSystemLanguageLayerContent,
  renderSystemLanguageTemplateText,
  validateSystemLanguageLayerContent,
} from './system-language-contracts.js';
export type {
  SystemLanguageDiagnostic,
  SystemLanguageLayerFile,
  SystemLanguageRenderResult,
  SystemLanguageTemplateKey,
  SystemLanguageTemplateMap,
  SystemLanguageTemplateResolution,
} from './system-language-contracts.js';

const log = createComponentLogger('SystemLanguage');
let installedSource: (() => SystemLanguageTemplateResolution) | null = null;
let lastLoggedDiagnosticSignature = '';

function findSystemLanguageLayer(promptStore: PromptLayerStatePort): PromptLayer | undefined {
  return promptStore.getAll().find(layer => (
    layer.type === SYSTEM_LANGUAGE_LAYER_TYPE
    || layer.identifier === SYSTEM_LANGUAGE_LAYER_IDENTIFIER
  ));
}

export function ensureSystemLanguagePromptLayer(promptStore: PromptLayerStatePort): PromptLayer {
  const existing = findSystemLanguageLayer(promptStore);
  if (!existing) {
    return promptStore.create({
      type: SYSTEM_LANGUAGE_LAYER_TYPE,
      name: SYSTEM_LANGUAGE_LAYER_NAME,
      identifier: SYSTEM_LANGUAGE_LAYER_IDENTIFIER,
      role: 'system',
      promptOrder: SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER,
      priority: SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER,
      content: composeDefaultSystemLanguageLayerContent(),
      updatedBy: 'system',
    });
  }

  if (existing.type !== SYSTEM_LANGUAGE_LAYER_TYPE) {
    throw new Error(
      `Prompt layer "${SYSTEM_LANGUAGE_LAYER_IDENTIFIER}" must use type "${SYSTEM_LANGUAGE_LAYER_TYPE}"`,
    );
  }

  validateSystemLanguageLayerContent(existing.content);
  const metadataPatch = {
    ...(existing.identifier !== SYSTEM_LANGUAGE_LAYER_IDENTIFIER ? { identifier: SYSTEM_LANGUAGE_LAYER_IDENTIFIER } : {}),
    ...(existing.role !== 'system' ? { role: 'system' as const } : {}),
    ...(existing.promptOrder !== SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER ? { promptOrder: SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER } : {}),
  };
  const patch = {
    ...(existing.name !== SYSTEM_LANGUAGE_LAYER_NAME ? { name: SYSTEM_LANGUAGE_LAYER_NAME } : {}),
    ...(existing.priority !== SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER ? { priority: SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER } : {}),
    ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
  };

  if (Object.keys(patch).length === 0) {
    return existing;
  }

  return promptStore.update(
    existing.id,
    patch,
    'system:system-language-seed',
    `Normalize seeded system language prompt layer ${SYSTEM_LANGUAGE_LAYER_IDENTIFIER}`,
  );
}

function resolveFromPromptStore(promptStore: PromptLayerStatePort): SystemLanguageTemplateResolution {
  let layer: PromptLayer | undefined;
  try {
    layer = findSystemLanguageLayer(promptStore);
  } catch (error) {
    return {
      templates: cloneDefaultSystemLanguageTemplates(),
      source: 'default',
      diagnostics: [{
        code: 'layer_parse_failed',
        message: `system language layer lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  if (!layer) {
    return {
      templates: cloneDefaultSystemLanguageTemplates(),
      source: 'default',
      diagnostics: [{
        code: 'layer_missing',
        message: `system language prompt layer "${SYSTEM_LANGUAGE_LAYER_IDENTIFIER}" is missing; using defaults`,
      }],
    };
  }

  if (!layer.enabled) {
    return {
      templates: cloneDefaultSystemLanguageTemplates(),
      source: 'default',
      diagnostics: [{
        code: 'layer_disabled',
        key: layer.id,
        message: `system language prompt layer "${SYSTEM_LANGUAGE_LAYER_IDENTIFIER}" is disabled; using defaults`,
      }],
    };
  }

  return parseSystemLanguageLayerContent(layer.content);
}

function logDiagnosticsOnce(diagnostics: readonly SystemLanguageDiagnostic[]): void {
  if (diagnostics.length === 0) return;
  const signature = diagnostics
    .map(diagnostic => `${diagnostic.code}:${diagnostic.key ?? ''}:${diagnostic.message}`)
    .join('|');
  if (signature === lastLoggedDiagnosticSignature) return;
  lastLoggedDiagnosticSignature = signature;
  log.warn('System language templates fell back to defaults', {
    diagnostics,
  });
}

export function installSystemLanguagePromptLayerSource(promptStore: PromptLayerStatePort): () => void {
  const source = () => {
    const resolution = resolveFromPromptStore(promptStore);
    logDiagnosticsOnce(resolution.diagnostics);
    return resolution;
  };
  installedSource = source;
  return () => {
    if (installedSource === source) {
      installedSource = null;
      lastLoggedDiagnosticSignature = '';
    }
  };
}

export function resetSystemLanguageRuntimeForTests(): void {
  installedSource = null;
  lastLoggedDiagnosticSignature = '';
}

export function resolveSystemLanguageTemplates(): SystemLanguageTemplateResolution {
  if (!installedSource) {
    return {
      templates: cloneDefaultSystemLanguageTemplates(),
      source: 'default',
      diagnostics: [{
        code: 'source_missing',
        message: 'system language prompt layer source is not installed; using defaults',
      }],
    };
  }
  return installedSource();
}

export function renderSystemLanguageTemplateWithDiagnostics(
  key: SystemLanguageTemplateKey,
  variables: Record<string, unknown> = {},
): SystemLanguageRenderResult {
  const resolution = resolveSystemLanguageTemplates();
  const sourceTemplate = resolution.templates[key];
  const rendered = renderSystemLanguageTemplateText(key, sourceTemplate, variables);
  if (rendered.diagnostics.length === 0) {
    return {
      text: rendered.text,
      diagnostics: resolution.diagnostics,
    };
  }

  const fallback = renderSystemLanguageTemplateText(key, DEFAULT_SYSTEM_LANGUAGE_TEMPLATES[key], variables);
  return {
    text: fallback.text,
    diagnostics: [
      ...resolution.diagnostics,
      ...rendered.diagnostics,
      ...fallback.diagnostics,
    ],
  };
}

export function renderSystemLanguageTemplate(
  key: SystemLanguageTemplateKey,
  variables: Record<string, unknown> = {},
): string {
  return renderSystemLanguageTemplateWithDiagnostics(key, variables).text;
}
