export const CAPABILITY_TOKENS = [
  'identity.read',
  'internal.read',
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
  'memory.write',
  'memory.delete',
  'external.discord',
  'external.email',
  'external.web',
  'git.read',
  'git.write',
  'issue.read',
  'issue.write',
  'issue.close',
  'lifecycle.restart',
  'lifecycle.rebuild',
  'repl.execute',
  'subagent.spawn',
  'shard.spawn',
] as const;

export type CapabilityToken = typeof CAPABILITY_TOKENS[number];

const CAPABILITY_TOKEN_SET = new Set<CapabilityToken>(CAPABILITY_TOKENS);

export function isCapabilityToken(value: unknown): value is CapabilityToken {
  return typeof value === 'string' && CAPABILITY_TOKEN_SET.has(value as CapabilityToken);
}

export function normalizeCapabilityTokens(value: unknown, field: string): CapabilityToken[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid capability config: ${field} must be an array`);
  }

  const unique = new Set<CapabilityToken>();
  for (const entry of value) {
    if (!isCapabilityToken(entry)) {
      throw new Error(`Invalid capability config: ${field} contains unknown token "${String(entry)}"`);
    }
    unique.add(entry);
  }

  return [...unique];
}
