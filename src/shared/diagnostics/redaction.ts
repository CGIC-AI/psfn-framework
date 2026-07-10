const SECRET_VALUE = '[REDACTED_SECRET]';
const CONTENT_VALUE = '[REDACTED_CONTENT]';
const MAX_DIAGNOSTIC_TEXT_CHARS = 240;

const SECRET_KEY_PATTERN = /(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|credential|private[_-]?key)/i;
const CONTENT_KEY_PATTERN = /(?:content|conversation|message|messages|prompt|response|transcript|utterance|delta|partialresult|body|text)/i;

function truncateDiagnosticText(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_DIAGNOSTIC_TEXT_CHARS - 15)}...[truncated]`;
}

export function isDiagnosticSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function isDiagnosticContentKey(key: string): boolean {
  return CONTENT_KEY_PATTERN.test(key);
}

export function sanitizeDiagnosticText(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  const redacted = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${SECRET_VALUE}`)
    .replace(/\b(?:sk|rk|pk|ak|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/g, SECRET_VALUE)
    .replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|credential|authorization))\s*[:=]\s*(['"]?)[^\s'",}]+/gi, (_match, key) => `${key}=${SECRET_VALUE}`)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, `$1${SECRET_VALUE}$2`)
    .replace(/\b(user|assistant)\s+(said|wrote|asked)\s*[:=]\s*.+$/gi, (_match, actor, verb) => `${actor} ${verb}: ${CONTENT_VALUE}`)
    .replace(/\b(private\s+message|message\s+body|conversation|transcript|prompt|response|content)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\n\r;]+)/gi, (_match, label) => `${label}=${CONTENT_VALUE}`);

  return truncateDiagnosticText(redacted);
}

export function sanitizeDiagnosticValue(value: unknown, key = ''): string | number | boolean | null {
  if (key && isDiagnosticSecretKey(key)) return SECRET_VALUE;
  if (key && isDiagnosticContentKey(key)) return CONTENT_VALUE;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeDiagnosticText(value);
  return '[REDACTED_OBJECT]';
}
