export function isExplicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function parseCommaSeparatedEnv(value: string | undefined): string[] {
  if (!value) return [];
  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  return [...new Set(entries)];
}
