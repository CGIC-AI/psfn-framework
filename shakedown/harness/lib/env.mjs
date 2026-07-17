// Fail-closed environment access for the shakedown harness.
//
// Harness rule (docs/shakedown.md, "Harness rules"): all configuration comes
// from env and fails closed. There are no fallback path defaults and no
// defaults pointing at a previous sprint tree. A missing required variable is
// an immediate, named error — every entrypoint that reads one of these throws
// before doing any work, so an unset variable exits non-zero naming the
// variable.

export class MissingEnvError extends Error {
  constructor(name, hint) {
    super(
      `Missing required environment variable: ${name}`
      + (hint ? ` (${hint})` : '')
      + '. Source the shakedown env (docs/shakedown.md) before running the harness.',
    );
    this.name = 'MissingEnvError';
    this.variable = name;
  }
}

export class InvalidEnvError extends Error {
  constructor(name, detail) {
    super(`Invalid environment variable: ${name} — ${detail}`);
    this.name = 'InvalidEnvError';
    this.variable = name;
  }
}

function firstNonEmpty(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { name, value: value.trim() };
    }
  }
  return null;
}

/** Require a single named variable; throws MissingEnvError naming it. */
export function requireEnv(name, hint) {
  const found = firstNonEmpty([name]);
  if (!found) throw new MissingEnvError(name, hint);
  return found.value;
}

/**
 * Require the first present of an ordered alias list (e.g. API_KEY then
 * PSFN_API_KEY). Throws naming the canonical (first) variable so the operator
 * always sees a stable name to set.
 */
export function requireEnvOneOf(names, hint) {
  const found = firstNonEmpty(names);
  if (!found) {
    throw new MissingEnvError(
      names[0],
      hint ? `${hint}; accepts ${names.join(' or ')}` : `accepts ${names.join(' or ')}`,
    );
  }
  return found.value;
}

/** Optional variable with an explicit default; never a filesystem fallback. */
export function optionalEnv(name, fallback = null) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function optionalEnvOneOf(names, fallback = null) {
  const found = firstNonEmpty(names);
  return found ? found.value : fallback;
}

export function requireIntEnv(name, hint) {
  const raw = requireEnv(name, hint);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new InvalidEnvError(name, `expected an integer, got ${JSON.stringify(raw)}`);
  return parsed;
}

export function optionalIntEnv(name, fallback) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) throw new InvalidEnvError(name, `expected an integer, got ${JSON.stringify(value)}`);
  return parsed;
}

export function optionalBoolEnv(name, fallback = false) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new InvalidEnvError(name, `expected a boolean, got ${JSON.stringify(value)}`);
}

/**
 * Install a top-level handler so a MissingEnvError thrown during module
 * evaluation (or in an async main) exits non-zero with a single, clear line
 * naming the variable instead of a noisy stack. Call once per entrypoint.
 */
export function failClosedOnEnv(error) {
  if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
