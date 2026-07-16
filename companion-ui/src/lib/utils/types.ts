// Local, dependency-free copy of the parent repo's isObjectRecord helper so
// companion-ui stays standalone (README: "Keep this package standalone.") and
// does not reach into ../../../../src/shared/utils/types.js.
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
