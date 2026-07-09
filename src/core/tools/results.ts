import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@mariozechner/pi-ai';
import { isRecord } from '../../shared/utils/types.js';
import {
  renderSystemLanguageTemplate,
  type SystemLanguageTemplateKey,
} from '../identity/system-language.js';

export type ToolErrorClass =
  | 'permission_denied'
  | 'policy_blocked'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_input'
  | 'provider_error'
  | 'unavailable';

export type ToolRetryHint =
  | 'do_not_retry'
  | 'try_alternative_input'
  | 'retry_after_delay'
  | 'retry_with_backoff'
  | 'operator_escalation';

export interface StructuredToolErrorDetails {
  isError: true;
  errorClass: ToolErrorClass;
  retryHint: ToolRetryHint;
  retryable: boolean;
  companionMessage: string;
  rawDiagnostic?: string;
}

export interface ToolErrorMetadataInput {
  errorClass?: ToolErrorClass;
  retryHint?: ToolRetryHint;
  companionMessage?: string;
  rawDiagnostic?: unknown;
  cause?: unknown;
}

type TextResultErrorDetails = {
  isError?: boolean;
} & Partial<Omit<StructuredToolErrorDetails, 'isError'>>;

const RAW_DIAGNOSTIC_MAX_CHARS = 512;
const COMPANION_MESSAGE_MAX_CHARS = 320;
const GATEWAY_NEEDS_APPROVAL = -32000;
const GATEWAY_APPROVAL_DENIED = -32001;
const GATEWAY_POLICY_DENIED = -32002;
const GATEWAY_PROVIDER_ERROR = -32003;

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'code',
  'credential',
  'key',
  'password',
  'refresh_token',
  'secret',
  'session',
  'signature',
  'sig',
  'token',
]);

const SENSITIVE_ENV_NAME_PATTERN =
  /\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|AUTH|CREDENTIAL|PASS(?:WORD)?|PRIVATE[_-]?KEY|SECRET|TOKEN)[A-Z0-9_]*\b/g;
const SENSITIVE_ENV_ASSIGNMENT_PATTERN =
  /\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|AUTH|CREDENTIAL|PASS(?:WORD)?|PRIVATE[_-]?KEY|SECRET|TOKEN)[A-Z0-9_]*\s*=\s*["']?[^"',\s;)]+/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|authorization|bearer|client_secret|credential|password|secret|token)\s*[:=]\s*)["']?[^"',\s;)]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9][A-Za-z0-9._~+/-]{47,}\b/g;
const UNIX_INTERNAL_PATH_PATTERN =
  /(^|[\s"'(=])\/(?:home|Users|mnt|var|tmp|private|etc|opt|srv|workspace|workspaces|root|data)\/[^\s"',;)]+/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"',;)]+/g;
const HOME_PATH_PATTERN = /(^|[\s"'(=])~\/[^\s"',;)]+/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>\\)]+/gi;

const TOOL_ERROR_DEFAULT_TEMPLATE_KEYS: Record<ToolErrorClass, SystemLanguageTemplateKey> = {
  permission_denied: 'tool_error.permission_denied.default',
  policy_blocked: 'tool_error.policy_blocked.default',
  rate_limited: 'tool_error.rate_limited.default',
  timeout: 'tool_error.timeout.default',
  invalid_input: 'tool_error.invalid_input.default',
  provider_error: 'tool_error.provider_error.default',
  unavailable: 'tool_error.unavailable.default',
};

const TOOL_ERROR_DIAGNOSTIC_TEMPLATE_KEYS: Record<ToolErrorClass, SystemLanguageTemplateKey> = {
  permission_denied: 'tool_error.permission_denied.diagnostic',
  policy_blocked: 'tool_error.policy_blocked.diagnostic',
  rate_limited: 'tool_error.rate_limited.diagnostic',
  timeout: 'tool_error.timeout.diagnostic',
  invalid_input: 'tool_error.invalid_input.diagnostic',
  provider_error: 'tool_error.provider_error.diagnostic',
  unavailable: 'tool_error.unavailable.diagnostic',
};

const DEFAULT_RETRY_HINTS: Record<ToolErrorClass, ToolRetryHint> = {
  permission_denied: 'operator_escalation',
  policy_blocked: 'try_alternative_input',
  rate_limited: 'retry_after_delay',
  timeout: 'retry_after_delay',
  invalid_input: 'try_alternative_input',
  provider_error: 'retry_with_backoff',
  unavailable: 'retry_with_backoff',
};

export function textResult(text: string): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: 'text', text }] satisfies TextContent[],
    details: {},
  };
}

export function textResultWithError(
  text: string,
  isError = false,
  metadata?: ToolErrorMetadataInput,
): AgentToolResult<TextResultErrorDetails> {
  const details = isError
    ? {
        isError: true,
        ...(metadata ? buildStructuredToolErrorDetails(metadata) : {}),
      }
    : { isError: undefined };
  return {
    content: [{ type: 'text', text }] satisfies TextContent[],
    details,
  };
}

export function textResultFromError(
  prefix: string,
  error: unknown,
  metadata: ToolErrorMetadataInput = {},
): AgentToolResult<TextResultErrorDetails> {
  const details = buildStructuredToolErrorDetails({
    ...metadata,
    cause: metadata.cause ?? error,
    rawDiagnostic: metadata.rawDiagnostic ?? error,
  });
  return {
    content: [{
      type: 'text',
      text: renderSystemLanguageTemplate('tool_error.result', {
        prefix,
        companion_message: details.companionMessage,
      }),
    }] satisfies TextContent[],
    details,
  };
}

export function buildStructuredToolErrorDetails(
  input: ToolErrorMetadataInput,
): StructuredToolErrorDetails {
  const rawDiagnostic = sanitizeToolErrorDiagnostic(
    input.rawDiagnostic ?? input.cause ?? input.companionMessage,
  );
  const errorClass = input.errorClass ?? classifyToolError(input.cause ?? input.rawDiagnostic);
  const retryHint = input.retryHint ?? DEFAULT_RETRY_HINTS[errorClass];
  const companionMessage = sanitizeCompanionMessage(
    input.companionMessage ?? buildDefaultCompanionMessage(errorClass, rawDiagnostic),
  );

  return {
    isError: true,
    errorClass,
    retryHint,
    retryable: isRetryableHint(retryHint),
    companionMessage,
    ...(rawDiagnostic ? { rawDiagnostic } : {}),
  };
}

export function classifyToolError(error: unknown): ToolErrorClass {
  const code = readErrorCode(error);
  const diagnostic = diagnosticToString(error).toLowerCase();

  if (code === GATEWAY_NEEDS_APPROVAL || code === GATEWAY_APPROVAL_DENIED) {
    return 'permission_denied';
  }
  if (code === GATEWAY_POLICY_DENIED) {
    return 'policy_blocked';
  }

  if (/\b(rate[-\s]?limit(?:ed)?|too many requests|http\s*429|\b429\b|quota exceeded)\b/.test(diagnostic)) {
    return 'rate_limited';
  }
  if (/\b(timeout|timed out|etimedout|abort(?:ed)?|deadline exceeded)\b/.test(diagnostic)) {
    return 'timeout';
  }
  if (/\b(circuit open|service unavailable|temporarily unavailable|unavailable|econnrefused|econnreset|enotfound|eai_again|socket hang up|http\s*50[234]|\b50[234]\b)\b/.test(diagnostic)) {
    return 'unavailable';
  }
  if (/\b(permission denied|approval denied|needs approval|requires approval|approval required)\b/.test(diagnostic)) {
    return 'permission_denied';
  }
  if (/\b(policy|blocked|not allowlisted|not allowed|denied|requires approval|approval required|forbidden)\b/.test(diagnostic)) {
    return 'policy_blocked';
  }
  if (/\b(invalid|unsupported|required|requires|must be|expected|non-empty|missing|malformed|cannot be empty)\b/.test(diagnostic)) {
    return 'invalid_input';
  }
  if (code === GATEWAY_PROVIDER_ERROR) {
    return 'provider_error';
  }

  return 'provider_error';
}

export function sanitizeToolErrorDiagnostic(value: unknown): string | undefined {
  const raw = diagnosticToString(value).trim();
  if (!raw) return undefined;
  const redacted = redactSecrets(redactInternalPaths(redactSecretUrls(raw)))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!redacted) return undefined;
  return truncate(redacted, RAW_DIAGNOSTIC_MAX_CHARS);
}

function buildDefaultCompanionMessage(errorClass: ToolErrorClass, rawDiagnostic: string | undefined): string {
  if (!rawDiagnostic) {
    return renderSystemLanguageTemplate(TOOL_ERROR_DEFAULT_TEMPLATE_KEYS[errorClass]);
  }
  return renderSystemLanguageTemplate(TOOL_ERROR_DIAGNOSTIC_TEMPLATE_KEYS[errorClass], {
    diagnostic: rawDiagnostic,
  });
}

function sanitizeCompanionMessage(value: string): string {
  return truncate(
    redactSecrets(redactInternalPaths(redactSecretUrls(value)))
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    COMPANION_MESSAGE_MAX_CHARS,
  );
}

function isRetryableHint(hint: ToolRetryHint): boolean {
  return hint === 'retry_after_delay' || hint === 'retry_with_backoff';
}

function readErrorCode(error: unknown): number | string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === 'number' || typeof code === 'string' ? code : undefined;
}

function diagnosticToString(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    const message = value.message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value === undefined || value === null ? '' : String(value);
}

function redactSecretUrls(value: string): string {
  return value.replace(URL_PATTERN, (match) => {
    try {
      const url = new URL(match);
      if (url.username || url.password) {
        url.username = 'redacted';
        url.password = '';
      }
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
          url.searchParams.set(key, '[redacted]');
        }
      }
      if (url.hash && /token|secret|credential|password|auth/i.test(url.hash)) {
        url.hash = '#[redacted]';
      }
      return url.toString();
    } catch {
      return match;
    }
  });
}

function redactInternalPaths(value: string): string {
  return value
    .replace(UNIX_INTERNAL_PATH_PATTERN, (_match, prefix: string) => `${prefix}[path]`)
    .replace(WINDOWS_PATH_PATTERN, '[path]')
    .replace(HOME_PATH_PATTERN, (_match, prefix: string) => `${prefix}[path]`);
}

function redactSecrets(value: string): string {
  return value
    .replace(SENSITIVE_ENV_ASSIGNMENT_PATTERN, '[env]=[redacted]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1[redacted]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(JWT_PATTERN, '[token]')
    .replace(SENSITIVE_ENV_NAME_PATTERN, '[env]')
    .replace(LONG_TOKEN_PATTERN, '[token]');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16)).trimEnd()}... [truncated]`;
}
