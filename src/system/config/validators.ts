type PositiveIntegerFailureKind = 'notInteger' | 'belowMin' | 'aboveMax';

interface PositiveIntegerFailureContext {
  fieldLabel: string;
  kind: PositiveIntegerFailureKind;
  min: number;
  max?: number;
  value: unknown;
}

type PositiveIntegerMessage = string | ((context: PositiveIntegerFailureContext) => string);

interface PositiveIntegerValidationOptions {
  min?: number;
  max?: number;
  message?: PositiveIntegerMessage;
  messages?: Partial<Record<PositiveIntegerFailureKind, PositiveIntegerMessage>>;
}

interface UnknownKeysOptions {
  errorPrefix?: string;
}

function formatPositiveIntegerMessage(
  message: PositiveIntegerMessage,
  context: PositiveIntegerFailureContext,
): string {
  return typeof message === 'function' ? message(context) : message;
}

function defaultPositiveIntegerMessage(context: PositiveIntegerFailureContext): string {
  if (context.kind === 'notInteger') {
    return `${context.fieldLabel} must be a positive integer`;
  }
  if (context.max !== undefined) {
    return `${context.fieldLabel} must be between ${context.min} and ${context.max}`;
  }
  return `${context.fieldLabel} must be an integer >= ${context.min}`;
}

function positiveIntegerMessage(
  context: PositiveIntegerFailureContext,
  options: PositiveIntegerValidationOptions,
): string {
  const message = options.messages?.[context.kind] ?? options.message;
  return message
    ? formatPositiveIntegerMessage(message, context)
    : defaultPositiveIntegerMessage(context);
}

export function assertPositiveInteger(
  value: unknown,
  fieldLabel: string,
  options: PositiveIntegerValidationOptions = {},
): number {
  const min = options.min ?? 1;
  const { max } = options;

  if (!Number.isInteger(min) || min < 1) {
    throw new Error(`Invalid positive integer validator minimum for ${fieldLabel}`);
  }
  if (max !== undefined && (!Number.isInteger(max) || max < min)) {
    throw new Error(`Invalid positive integer validator maximum for ${fieldLabel}`);
  }

  const fail = (kind: PositiveIntegerFailureKind): never => {
    throw new Error(positiveIntegerMessage({ fieldLabel, kind, min, max, value }, options));
  };

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail('notInteger');
  }
  const integerValue = Number(value);
  if (integerValue < min) {
    fail('belowMin');
  }
  if (max !== undefined && integerValue > max) {
    fail('aboveMax');
  }
  return integerValue;
}

export function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  fieldPath: string,
  options: UnknownKeysOptions = {},
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    const prefix = options.errorPrefix ? `${options.errorPrefix}: ` : '';
    throw new Error(`${prefix}${fieldPath} contains unknown keys: ${unknown.join(', ')}`);
  }
}
