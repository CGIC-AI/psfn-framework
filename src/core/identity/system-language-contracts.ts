import { isRecord } from '../../shared/utils/types.js';

export const SYSTEM_LANGUAGE_LAYER_TYPE = 'system_language' as const;
export const SYSTEM_LANGUAGE_LAYER_IDENTIFIER = 'system.language';
export const SYSTEM_LANGUAGE_LAYER_NAME = 'System Language Templates';
export const SYSTEM_LANGUAGE_LAYER_PROMPT_ORDER = 880;
export const SYSTEM_LANGUAGE_SCHEMA_VERSION = 1 as const;
export const SYSTEM_LANGUAGE_MAX_TEMPLATE_CHARS = 800;

const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const SYSTEM_LANGUAGE_TEMPLATE_KEYS = [
  'compaction.header',
  'memory_context_note.header',
  'memory_context_note.withheld_count',
  'memory_context_note.reasons',
  'memory_context_note.relevance',
  'memory_context_note.safe_next_actions',
  'tool_error.result',
  'tool_error.permission_denied.default',
  'tool_error.permission_denied.diagnostic',
  'tool_error.policy_blocked.default',
  'tool_error.policy_blocked.diagnostic',
  'tool_error.rate_limited.default',
  'tool_error.rate_limited.diagnostic',
  'tool_error.timeout.default',
  'tool_error.timeout.diagnostic',
  'tool_error.invalid_input.default',
  'tool_error.invalid_input.diagnostic',
  'tool_error.provider_error.default',
  'tool_error.provider_error.diagnostic',
  'tool_error.unavailable.default',
  'tool_error.unavailable.diagnostic',
  'wake_return.header',
  'wake_return.elapsed',
  'wake_return.last_time_here',
  'wake_return.recent_continuity',
  'wake_return.default_pending_intent',
] as const;

export type SystemLanguageTemplateKey = typeof SYSTEM_LANGUAGE_TEMPLATE_KEYS[number];
export type SystemLanguageTemplateMap = Record<SystemLanguageTemplateKey, string>;

export interface SystemLanguageLayerFile {
  version: typeof SYSTEM_LANGUAGE_SCHEMA_VERSION;
  templates: SystemLanguageTemplateMap;
}

export interface SystemLanguageDiagnostic {
  code:
    | 'source_missing'
    | 'layer_missing'
    | 'layer_disabled'
    | 'layer_parse_failed'
    | 'missing_key'
    | 'unknown_key'
    | 'invalid_template'
    | 'unknown_placeholder'
    | 'missing_placeholder'
    | 'missing_variable';
  message: string;
  key?: string;
}

export interface SystemLanguageTemplateResolution {
  templates: SystemLanguageTemplateMap;
  source: 'layer' | 'default';
  diagnostics: SystemLanguageDiagnostic[];
}

export interface SystemLanguageRenderResult {
  text: string;
  diagnostics: SystemLanguageDiagnostic[];
}

export const DEFAULT_SYSTEM_LANGUAGE_TEMPLATES: Readonly<SystemLanguageTemplateMap> = Object.freeze({
  'compaction.header': '[Previous conversation summary]',
  'memory_context_note.header': 'Memory context note:',
  'memory_context_note.withheld_count': '- {{total_count}} candidate {{memory_noun}} kept out of this turn\'s memory context.',
  'memory_context_note.reasons': '- Broad trust/privacy reasons: {{detail_line}}.',
  'memory_context_note.relevance': '- Coarse relevance bands: {{relevance_line}}.',
  'memory_context_note.safe_next_actions': '- Safe next actions: do not infer or disclose missing details; ask for consent, clarification, or a more private/higher-trust channel if needed.',
  'tool_error.result': '{{prefix}}: {{companion_message}}',
  'tool_error.permission_denied.default': 'Permission or approval is required before this tool can run.',
  'tool_error.permission_denied.diagnostic': 'Permission denied: {{diagnostic}}',
  'tool_error.policy_blocked.default': 'The request was blocked by runtime policy. Try a different target or ask the operator to change policy.',
  'tool_error.policy_blocked.diagnostic': 'Blocked by runtime policy: {{diagnostic}}',
  'tool_error.rate_limited.default': 'The provider is rate limited. Wait before retrying or reduce request volume.',
  'tool_error.rate_limited.diagnostic': 'Rate limited: {{diagnostic}}',
  'tool_error.timeout.default': 'The operation timed out. Retry later or narrow the request.',
  'tool_error.timeout.diagnostic': 'Timed out: {{diagnostic}}',
  'tool_error.invalid_input.default': 'The tool input is invalid. Adjust the arguments and try again.',
  'tool_error.invalid_input.diagnostic': 'Invalid input: {{diagnostic}}',
  'tool_error.provider_error.default': 'The provider returned an error. Retry with backoff or use an alternative if it persists.',
  'tool_error.provider_error.diagnostic': 'Provider error: {{diagnostic}}',
  'tool_error.unavailable.default': 'The backing service is unavailable. Retry with backoff or ask the operator if it persists.',
  'tool_error.unavailable.diagnostic': 'Service unavailable: {{diagnostic}}',
  'wake_return.header': '[Welcome back]',
  'wake_return.elapsed': 'It has been about {{elapsed}} since this channel was last active.',
  'wake_return.last_time_here': 'Last time here: {{summary}}.',
  'wake_return.recent_continuity': 'Recent continuity: {{summary}}.',
  'wake_return.default_pending_intent': 'No urgent follow-up or pending intent found in available continuity context.',
});

const ALLOWED_PLACEHOLDERS: Record<SystemLanguageTemplateKey, readonly string[]> = {
  'compaction.header': [],
  'memory_context_note.header': [],
  'memory_context_note.withheld_count': ['total_count', 'memory_noun'],
  'memory_context_note.reasons': ['detail_line'],
  'memory_context_note.relevance': ['relevance_line'],
  'memory_context_note.safe_next_actions': [],
  'tool_error.result': ['prefix', 'companion_message'],
  'tool_error.permission_denied.default': [],
  'tool_error.permission_denied.diagnostic': ['diagnostic'],
  'tool_error.policy_blocked.default': [],
  'tool_error.policy_blocked.diagnostic': ['diagnostic'],
  'tool_error.rate_limited.default': [],
  'tool_error.rate_limited.diagnostic': ['diagnostic'],
  'tool_error.timeout.default': [],
  'tool_error.timeout.diagnostic': ['diagnostic'],
  'tool_error.invalid_input.default': [],
  'tool_error.invalid_input.diagnostic': ['diagnostic'],
  'tool_error.provider_error.default': [],
  'tool_error.provider_error.diagnostic': ['diagnostic'],
  'tool_error.unavailable.default': [],
  'tool_error.unavailable.diagnostic': ['diagnostic'],
  'wake_return.header': [],
  'wake_return.elapsed': ['elapsed'],
  'wake_return.last_time_here': ['summary'],
  'wake_return.recent_continuity': ['summary'],
  'wake_return.default_pending_intent': [],
};

const REQUIRED_PLACEHOLDERS: Partial<Record<SystemLanguageTemplateKey, readonly string[]>> = {
  'memory_context_note.withheld_count': ['total_count', 'memory_noun'],
  'memory_context_note.reasons': ['detail_line'],
  'memory_context_note.relevance': ['relevance_line'],
  'tool_error.result': ['prefix', 'companion_message'],
  'tool_error.permission_denied.diagnostic': ['diagnostic'],
  'tool_error.policy_blocked.diagnostic': ['diagnostic'],
  'tool_error.rate_limited.diagnostic': ['diagnostic'],
  'tool_error.timeout.diagnostic': ['diagnostic'],
  'tool_error.invalid_input.diagnostic': ['diagnostic'],
  'tool_error.provider_error.diagnostic': ['diagnostic'],
  'tool_error.unavailable.diagnostic': ['diagnostic'],
  'wake_return.elapsed': ['elapsed'],
  'wake_return.last_time_here': ['summary'],
  'wake_return.recent_continuity': ['summary'],
};

const TEMPLATE_KEY_SET = new Set<SystemLanguageTemplateKey>(SYSTEM_LANGUAGE_TEMPLATE_KEYS);
const RETIRED_SYSTEM_LANGUAGE_TEMPLATE_KEYS = [
  'substrate_health.header',
  'substrate_health.overall.healthy',
  'substrate_health.overall.degraded',
  'substrate_health.overall.unavailable',
  'substrate_health.subsystem_missing_probe',
  'substrate_health.subsystem_degraded_suffix',
  'substrate_health.gateway_degraded_suffix',
] as const;
const RETIRED_SYSTEM_LANGUAGE_TEMPLATE_KEY_SET = new Set<string>(RETIRED_SYSTEM_LANGUAGE_TEMPLATE_KEYS);

export function cloneDefaultSystemLanguageTemplates(): SystemLanguageTemplateMap {
  return { ...DEFAULT_SYSTEM_LANGUAGE_TEMPLATES };
}

export interface RetiredSystemLanguageLayerNormalization {
  content: string;
  removedKeys: string[];
}

export function normalizeRetiredSystemLanguageLayerContent(
  content: string,
): RetiredSystemLanguageLayerNormalization | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== SYSTEM_LANGUAGE_SCHEMA_VERSION || !isRecord(parsed.templates)) {
    return null;
  }

  const templates: Record<string, unknown> = { ...parsed.templates };
  const removedKeys: string[] = [];
  for (const key of Object.keys(templates)) {
    if (TEMPLATE_KEY_SET.has(key as SystemLanguageTemplateKey)) {
      continue;
    }
    if (!RETIRED_SYSTEM_LANGUAGE_TEMPLATE_KEY_SET.has(key)) {
      return null;
    }
    delete templates[key];
    removedKeys.push(key);
  }

  if (removedKeys.length === 0) {
    return null;
  }

  const contentCandidate = JSON.stringify({
    version: SYSTEM_LANGUAGE_SCHEMA_VERSION,
    templates,
  } satisfies SystemLanguageLayerFile, null, 2);
  if (parseSystemLanguageLayerContent(contentCandidate).diagnostics.length > 0) {
    return null;
  }

  return {
    content: contentCandidate,
    removedKeys,
  };
}

function extractTemplateTokens(template: string): string[] {
  const tokens = new Set<string>();
  template.replace(TEMPLATE_TOKEN_PATTERN, (_full, token: string) => {
    tokens.add(token.trim());
    return '';
  });
  return [...tokens];
}

export function normalizeSystemLanguageTemplateText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .trim();
}

function sanitizeInterpolationValue(value: unknown): string {
  const raw = value == null ? '' : String(value);
  return normalizeSystemLanguageTemplateText(raw)
    .replace(/```/g, '`\u200b``')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function validateTemplateValue(
  key: SystemLanguageTemplateKey,
  rawValue: unknown,
): { value?: string; diagnostics: SystemLanguageDiagnostic[] } {
  const diagnostics: SystemLanguageDiagnostic[] = [];
  if (typeof rawValue !== 'string') {
    diagnostics.push({
      code: 'invalid_template',
      key,
      message: `system language template "${key}" must be a string`,
    });
    return { diagnostics };
  }

  const value = normalizeSystemLanguageTemplateText(rawValue);
  if (!value) {
    diagnostics.push({
      code: 'invalid_template',
      key,
      message: `system language template "${key}" must not be empty`,
    });
  }
  if (value.length > SYSTEM_LANGUAGE_MAX_TEMPLATE_CHARS) {
    diagnostics.push({
      code: 'invalid_template',
      key,
      message: `system language template "${key}" exceeds ${SYSTEM_LANGUAGE_MAX_TEMPLATE_CHARS} characters`,
    });
  }

  const allowed = new Set(ALLOWED_PLACEHOLDERS[key]);
  const tokens = extractTemplateTokens(value);
  for (const token of tokens) {
    if (!allowed.has(token)) {
      diagnostics.push({
        code: 'unknown_placeholder',
        key,
        message: `system language template "${key}" contains unsupported placeholder "{{${token}}}"`,
      });
    }
  }

  for (const placeholder of REQUIRED_PLACEHOLDERS[key] ?? []) {
    if (!tokens.includes(placeholder)) {
      diagnostics.push({
        code: 'missing_placeholder',
        key,
        message: `system language template "${key}" must include "{{${placeholder}}}"`,
      });
    }
  }

  return { value, diagnostics };
}

export function parseSystemLanguageLayerContent(content: string): SystemLanguageTemplateResolution {
  const diagnostics: SystemLanguageDiagnostic[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      templates: cloneDefaultSystemLanguageTemplates(),
      source: 'default',
      diagnostics: [{
        code: 'layer_parse_failed',
        message: `system language layer JSON failed to parse: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  if (!isRecord(parsed)) {
    return {
      templates: cloneDefaultSystemLanguageTemplates(),
      source: 'default',
      diagnostics: [{
        code: 'layer_parse_failed',
        message: 'system language layer must be a JSON object',
      }],
    };
  }

  if (parsed.version !== SYSTEM_LANGUAGE_SCHEMA_VERSION) {
    diagnostics.push({
      code: 'layer_parse_failed',
      message: `system language layer version must be ${SYSTEM_LANGUAGE_SCHEMA_VERSION}`,
    });
  }

  const rawTemplates = parsed.templates;
  if (!isRecord(rawTemplates)) {
    diagnostics.push({
      code: 'layer_parse_failed',
      message: 'system language layer must include a templates object',
    });
  }

  const templates: Partial<SystemLanguageTemplateMap> = {};
  if (isRecord(rawTemplates)) {
    for (const key of Object.keys(rawTemplates)) {
      if (!TEMPLATE_KEY_SET.has(key as SystemLanguageTemplateKey)) {
        diagnostics.push({
          code: 'unknown_key',
          key,
          message: `system language layer contains unknown template key "${key}"`,
        });
        continue;
      }

      const typedKey = key as SystemLanguageTemplateKey;
      const validation = validateTemplateValue(typedKey, rawTemplates[key]);
      diagnostics.push(...validation.diagnostics);
      if (validation.value !== undefined) {
        templates[typedKey] = validation.value;
      }
    }
  }

  for (const key of SYSTEM_LANGUAGE_TEMPLATE_KEYS) {
    if (templates[key] === undefined) {
      diagnostics.push({
        code: 'missing_key',
        key,
        message: `system language layer is missing required template key "${key}"`,
      });
    }
  }

  if (diagnostics.length > 0) {
    return {
      templates: cloneDefaultSystemLanguageTemplates(),
      source: 'default',
      diagnostics,
    };
  }

  return {
    templates: templates as SystemLanguageTemplateMap,
    source: 'layer',
    diagnostics: [],
  };
}

export function validateSystemLanguageLayerContent(content: string): SystemLanguageTemplateMap {
  const resolution = parseSystemLanguageLayerContent(content);
  if (resolution.diagnostics.length > 0) {
    throw new Error(
      `Invalid system language templates: ${resolution.diagnostics.map(diagnostic => diagnostic.message).join('; ')}`,
    );
  }
  return resolution.templates;
}

export function composeDefaultSystemLanguageLayerContent(): string {
  return JSON.stringify({
    version: SYSTEM_LANGUAGE_SCHEMA_VERSION,
    templates: cloneDefaultSystemLanguageTemplates(),
  } satisfies SystemLanguageLayerFile, null, 2);
}

export function renderSystemLanguageTemplateText(
  key: SystemLanguageTemplateKey,
  template: string,
  variables: Record<string, unknown>,
): SystemLanguageRenderResult {
  const diagnostics: SystemLanguageDiagnostic[] = [];
  const safeVariables = new Map<string, string>();
  for (const [name, value] of Object.entries(variables)) {
    safeVariables.set(name, sanitizeInterpolationValue(value));
  }

  const text = template.replace(TEMPLATE_TOKEN_PATTERN, (_full, token: string) => {
    const value = safeVariables.get(token);
    if (value === undefined) {
      diagnostics.push({
        code: 'missing_variable',
        key,
        message: `system language template "${key}" was rendered without variable "${token}"`,
      });
      return '';
    }
    return value;
  });

  return {
    text: normalizeSystemLanguageTemplateText(text),
    diagnostics,
  };
}
