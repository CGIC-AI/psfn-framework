import type { MemoryScopeQuery } from '../types.js';

export function buildScopeQuerySql(
  scopeQuery: MemoryScopeQuery | undefined,
): { clause: string; params: unknown[] } {
  if (!scopeQuery || scopeQuery.mode !== 'only') {
    return { clause: '', params: [] };
  }

  const fragments: string[] = [];
  const params: unknown[] = [];

  for (const ref of scopeQuery.refs ?? []) {
    fragments.push('(scope_ref_kind = ? AND scope_ref_id = ?)');
    params.push(ref.kind, ref.id);
  }
  for (const tag of scopeQuery.tags ?? []) {
    fragments.push('LOWER(scope_tags) LIKE ?');
    params.push(`%\"${tag}\"%`);
  }

  if (fragments.length === 0) {
    return { clause: '', params: [] };
  }

  return {
    clause: `AND (${fragments.join(' OR ')})`,
    params,
  };
}
