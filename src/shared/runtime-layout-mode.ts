/**
 * Runtime layout mode constants and resolution. Lives in shared/ so that
 * shared/cache/redis-cache.ts can enforce production guards without importing
 * upward into persistence/.
 */

export const RUNTIME_LAYOUT_MODE = Object.freeze({
  CONTINUOUS: 'continuous',
  PRODUCTION: 'production',
} as const);

export type RuntimeLayoutMode = (typeof RUNTIME_LAYOUT_MODE)[keyof typeof RUNTIME_LAYOUT_MODE];

const RUNTIME_LAYOUT_MODE_ALIASES: Readonly<Record<string, RuntimeLayoutMode>> = Object.freeze({
  continuous: RUNTIME_LAYOUT_MODE.CONTINUOUS,
  dev: RUNTIME_LAYOUT_MODE.CONTINUOUS,
  development: RUNTIME_LAYOUT_MODE.CONTINUOUS,
  production: RUNTIME_LAYOUT_MODE.PRODUCTION,
  prod: RUNTIME_LAYOUT_MODE.PRODUCTION,
  live: RUNTIME_LAYOUT_MODE.PRODUCTION,
});

export function normalizeDir(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeRuntimeLayoutMode(value: string | undefined): RuntimeLayoutMode | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  return RUNTIME_LAYOUT_MODE_ALIASES[normalized] ?? null;
}

export function resolveRuntimeLayoutMode(
  options: { mode?: string; nodeEnv?: string } = {},
): RuntimeLayoutMode {
  const normalizedMode = normalizeRuntimeLayoutMode(options.mode);
  if (normalizedMode) {
    return normalizedMode;
  }

  if (normalizeDir(options.mode)) {
    throw new Error(
      `Unsupported PSFN_RUNTIME_LAYOUT_MODE "${options.mode}". ` +
      'Expected one of: continuous, dev, production, prod.',
    );
  }

  if ((options.nodeEnv ?? '').trim().toLowerCase() === 'production') {
    return RUNTIME_LAYOUT_MODE.PRODUCTION;
  }

  return RUNTIME_LAYOUT_MODE.CONTINUOUS;
}
