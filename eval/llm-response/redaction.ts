const SECRET_PATTERN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, 'Bearer [REDACTED:bearer-token]'],
  [/\b(sk|sk-or|sk-ant|rk)-[A-Za-z0-9._-]{8,}\b/g, '[REDACTED:api-key]'],
  [/([?&](?:api[_-]?key|key|token)=)[^&\s"']+/gi, '$1[REDACTED:query-secret]'],
];

export interface RedactionSecret {
  label: string;
  value: string;
}

export function collectEnvSecrets(env: NodeJS.ProcessEnv): RedactionSecret[] {
  return Object.entries(env)
    .filter(([key, value]) => /(?:API|TOKEN|SECRET|KEY|AUTH)/i.test(key) && typeof value === 'string' && value.length >= 6)
    .map(([key, value]) => ({ label: key, value: value as string }));
}

export function redactString(input: string, secrets: readonly RedactionSecret[] = []): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.value.length < 6) continue;
    output = output.split(secret.value).join(`[REDACTED:${secret.label}]`);
  }
  for (const [pattern, replacement] of SECRET_PATTERN_REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactSecrets<T>(value: T, secrets: readonly RedactionSecret[] = []): T {
  if (typeof value === 'string') {
    return redactString(value, secrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, secrets)) as T;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      redacted[key] = redactSecrets(entry, secrets);
    }
    return redacted as T;
  }
  return value;
}
