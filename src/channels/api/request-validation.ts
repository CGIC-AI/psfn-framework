import { isRecord } from '../../shared/utils/types.js';
import type { ChatCompletionRequest } from './types.js';

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const SYSTEM_PROMPT_MODES = new Set(['default', 'none', 'custom']);
const RESPONSE_STYLES = new Set(['concise', 'expressive']);
const MAX_MESSAGE_COUNT = 1_000;
const MAX_CONTENT_PARTS = 256;
const MAX_STOP_SEQUENCES = 64;
const MAX_CHAT_COMPLETION_TOKENS = 1_000_000;
const MAX_N = 128;
const MAX_SEED_ABS = 9_007_199_254_740_991;
const MAX_LOGIT_BIAS_KEYS = 10_000;

export interface ChatCompletionValidationSuccess {
  ok: true;
  value: ChatCompletionRequest;
}

export interface ChatCompletionValidationError {
  ok: false;
  message: string;
  details?: Record<string, unknown>;
}

export type ChatCompletionValidationResult =
  | ChatCompletionValidationSuccess
  | ChatCompletionValidationError;

export function isPrimaryTrustLevelValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'primary';
}

export function hasCallerProvidedPrimaryTrust(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  if (isPrimaryTrustLevelValue(record.trustLevel) || isPrimaryTrustLevelValue(record.trust_level)) {
    return true;
  }

  const contact = record.contact;
  if (!contact || typeof contact !== 'object') return false;
  const contactRecord = contact as Record<string, unknown>;
  return isPrimaryTrustLevelValue(contactRecord.trustLevel)
    || isPrimaryTrustLevelValue(contactRecord.trust_level);
}

function validationError(message: string, details?: Record<string, unknown>): ChatCompletionValidationError {
  return {
    ok: false,
    message,
    ...(details ? { details } : {}),
  };
}

function validateOptionalString(value: unknown, path: string): ChatCompletionValidationError | null {
  if (value === undefined) return null;
  return typeof value === 'string'
    ? null
    : validationError(`${path} must be a string`, { path });
}

function validateOptionalBoolean(value: unknown, path: string): ChatCompletionValidationError | null {
  if (value === undefined) return null;
  return typeof value === 'boolean'
    ? null
    : validationError(`${path} must be a boolean`, { path });
}

function validateFiniteNumber(
  value: unknown,
  path: string,
  options: {
    min?: number;
    max?: number;
    integer?: boolean;
  } = {},
): ChatCompletionValidationError | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return validationError(`${path} must be a finite number`, { path });
  }
  if (options.integer && !Number.isInteger(value)) {
    return validationError(`${path} must be an integer`, { path });
  }
  if (options.min !== undefined && value < options.min) {
    return validationError(`${path} must be greater than or equal to ${options.min}`, { path, min: options.min });
  }
  if (options.max !== undefined && value > options.max) {
    return validationError(`${path} must be less than or equal to ${options.max}`, { path, max: options.max });
  }
  return null;
}

function validateEnum(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
): ChatCompletionValidationError | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !allowed.has(value)) {
    return validationError(`${path} must be one of: ${Array.from(allowed).join(', ')}`, { path });
  }
  return null;
}

function validateStop(value: unknown): ChatCompletionValidationError | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return null;
  if (!Array.isArray(value)) {
    return validationError('stop must be a string or an array of strings', { path: 'stop' });
  }
  if (value.length > MAX_STOP_SEQUENCES) {
    return validationError(`stop must contain at most ${MAX_STOP_SEQUENCES} strings`, { path: 'stop' });
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      return validationError(`stop[${index}] must be a string`, { path: `stop[${index}]` });
    }
  }
  return null;
}

function validateLogitBias(value: unknown): ChatCompletionValidationError | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    return validationError('logit_bias must be an object mapping token ids to numbers', { path: 'logit_bias' });
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_LOGIT_BIAS_KEYS) {
    return validationError(`logit_bias must contain at most ${MAX_LOGIT_BIAS_KEYS} entries`, { path: 'logit_bias' });
  }
  for (const [token, bias] of entries) {
    if (!/^-?\d+$/.test(token)) {
      return validationError('logit_bias keys must be token id integers', { path: `logit_bias.${token}` });
    }
    if (typeof bias !== 'number' || !Number.isFinite(bias) || bias < -100 || bias > 100) {
      return validationError('logit_bias values must be finite numbers between -100 and 100', {
        path: `logit_bias.${token}`,
      });
    }
  }
  return null;
}

function validateImageUrl(value: unknown, path: string): ChatCompletionValidationError | null {
  if (typeof value === 'string') {
    return value.trim()
      ? null
      : validationError(`${path} must be a non-empty string`, { path });
  }
  if (!isRecord(value)) {
    return validationError(`${path} must be a string or object`, { path });
  }
  if (typeof value.url !== 'string' || !value.url.trim()) {
    return validationError(`${path}.url must be a non-empty string`, { path: `${path}.url` });
  }
  if (value.detail !== undefined && typeof value.detail !== 'string') {
    return validationError(`${path}.detail must be a string`, { path: `${path}.detail` });
  }
  return null;
}

function validateContentPart(value: unknown, path: string): ChatCompletionValidationError | null {
  if (!isRecord(value)) {
    return validationError(`${path} must be an object`, { path });
  }
  const type = value.type;
  if (type === 'text') {
    return typeof value.text === 'string'
      ? null
      : validationError(`${path}.text must be a string`, { path: `${path}.text` });
  }
  if (type === 'image') {
    if (typeof value.data !== 'string' || !value.data.trim()) {
      return validationError(`${path}.data must be a non-empty string`, { path: `${path}.data` });
    }
    if (typeof value.mimeType !== 'string' || !value.mimeType.trim()) {
      return validationError(`${path}.mimeType must be a non-empty string`, { path: `${path}.mimeType` });
    }
    if (value.name !== undefined && typeof value.name !== 'string') {
      return validationError(`${path}.name must be a string`, { path: `${path}.name` });
    }
    return null;
  }
  if (type === 'image_url') {
    return validateImageUrl(value.image_url, `${path}.image_url`);
  }
  return validationError(`${path}.type must be one of: text, image, image_url`, { path: `${path}.type` });
}

function validateMessageContent(value: unknown, path: string): ChatCompletionValidationError | null {
  if (typeof value === 'string') return null;
  if (!Array.isArray(value)) {
    return validationError(`${path} must be a string or an array of content parts`, { path });
  }
  if (value.length === 0) {
    return validationError(`${path} must contain at least one content part`, { path });
  }
  if (value.length > MAX_CONTENT_PARTS) {
    return validationError(`${path} must contain at most ${MAX_CONTENT_PARTS} content parts`, { path });
  }
  for (const [index, part] of value.entries()) {
    const error = validateContentPart(part, `${path}[${index}]`);
    if (error) return error;
  }
  return null;
}

function validateMessages(value: unknown): ChatCompletionValidationError | null {
  if (!Array.isArray(value) || value.length === 0) {
    return validationError('messages field is required and must be a non-empty array', { path: 'messages' });
  }
  if (value.length > MAX_MESSAGE_COUNT) {
    return validationError(`messages must contain at most ${MAX_MESSAGE_COUNT} entries`, { path: 'messages' });
  }
  for (const [index, message] of value.entries()) {
    const path = `messages[${index}]`;
    if (!isRecord(message)) {
      return validationError(`${path} must be an object`, { path });
    }
    if (typeof message.role !== 'string' || !MESSAGE_ROLES.has(message.role)) {
      return validationError(`${path}.role must be one of: system, user, assistant`, { path: `${path}.role` });
    }
    const contentError = validateMessageContent(message.content, `${path}.content`);
    if (contentError) return contentError;
    if (message.name !== undefined && typeof message.name !== 'string') {
      return validationError(`${path}.name must be a string`, { path: `${path}.name` });
    }
  }
  return null;
}

function validateTools(value: unknown): ChatCompletionValidationError | null {
  if (value === undefined) return null;
  return Array.isArray(value)
    ? null
    : validationError('tools must be an array when provided', { path: 'tools' });
}

export function validateChatCompletionRequest(payload: unknown): ChatCompletionValidationResult {
  if (!isRecord(payload)) {
    return validationError('Request body must be a JSON object');
  }
  if (typeof payload.model !== 'string' || !payload.model.trim()) {
    return validationError('model field is required and must be a non-empty string', { path: 'model' });
  }

  const validators: Array<ChatCompletionValidationError | null> = [
    validateMessages(payload.messages),
    validateOptionalString(payload.provider, 'provider'),
    validateOptionalBoolean(payload.stream, 'stream'),
    validateFiniteNumber(payload.max_tokens, 'max_tokens', {
      min: 1,
      max: MAX_CHAT_COMPLETION_TOKENS,
      integer: true,
    }),
    validateFiniteNumber(payload.temperature, 'temperature', { min: 0, max: 2 }),
    validateFiniteNumber(payload.top_p, 'top_p', { min: 0, max: 1 }),
    validateFiniteNumber(payload.n, 'n', { min: 1, max: MAX_N, integer: true }),
    validateFiniteNumber(payload.presence_penalty, 'presence_penalty', { min: -2, max: 2 }),
    validateFiniteNumber(payload.frequency_penalty, 'frequency_penalty', { min: -2, max: 2 }),
    validateFiniteNumber(payload.seed, 'seed', { min: -MAX_SEED_ABS, max: MAX_SEED_ABS, integer: true }),
    validateEnum(payload.system_prompt_mode, 'system_prompt_mode', SYSTEM_PROMPT_MODES),
    validateOptionalString(payload.system_prompt, 'system_prompt'),
    validateEnum(payload.response_style, 'response_style', RESPONSE_STYLES),
    validateStop(payload.stop),
    validateLogitBias(payload.logit_bias),
    validateOptionalString(payload.user, 'user'),
    validateTools(payload.tools),
  ];
  for (const error of validators) {
    if (error) return error;
  }

  return { ok: true, value: payload as unknown as ChatCompletionRequest };
}
