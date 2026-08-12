export type AutomataTextValidator = (value: unknown, field: string) => string;
export type AutomataPositiveIntegerValidator = (value: unknown, field: string) => number;

function requireDomain(domain: string): string {
  const normalized = domain.trim();
  if (!normalized) throw new Error('Automata validation domain must be non-empty');
  return normalized;
}

export function createAutomataTextValidator(domain: string): AutomataTextValidator {
  const normalizedDomain = requireDomain(domain);
  return (value, field) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${normalizedDomain} ${field} must be a non-empty string`);
    }
    return value.trim();
  };
}

export function createAutomataPositiveIntegerValidator(
  domain: string,
): AutomataPositiveIntegerValidator {
  const normalizedDomain = requireDomain(domain);
  return (value, field) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${normalizedDomain} ${field} must be a positive safe integer`);
    }
    return value;
  };
}

export function normalizeAutomataStringList(
  values: readonly string[] | undefined,
  field: string,
  validateText: AutomataTextValidator,
): string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = values.map((value, index) => validateText(value, `${field}[${index}]`));
  return [...new Set(normalized)].sort();
}

export function normalizeAutomataTimestamp(
  value: string | undefined,
  field: string,
  validateText: AutomataTextValidator,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = validateText(value, field);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${field} must be a canonical UTC ISO-8601 timestamp`);
  }
  return normalized;
}
