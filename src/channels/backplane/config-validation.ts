/**
 * Shared fail-closed config validation for the backplane registries
 * (`places-registry`, `satellite-registry`).
 *
 * Root cause fixed here (H9/T1, 03-M2, 08-L3): the `parse*Config` functions
 * validate the KNOWN keys they read but never reject UNKNOWN ones. A misspelled
 * key (e.g. `"privicy":"private"` instead of `"privacy"`) is silently dropped —
 * the intended value is never read, the field defaults, and a private room can
 * be demoted to public delivery. Any typo'd or stray key is a silent
 * fail-open.
 *
 * {@link assertNoUnknownKeys} closes that class of bug: it asserts that every
 * key present on a parsed object is one the parser legitimately reads, and
 * THROWS naming the offending key(s) otherwise. Call it at the top of every
 * record parser with the exact allow-list of keys that parser consumes, so a
 * typo fails closed at config load instead of silently changing behavior.
 */
export function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  contextLabel: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${contextLabel} has unknown key(s): ${unknownKeys.map((key) => `"${key}"`).join(', ')}. `
      + `Allowed keys: ${[...allowedKeys].join(', ')}`,
    );
  }
}
