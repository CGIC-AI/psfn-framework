import type { MemoryScopeQuery } from '../types.js';

// ponytail: SQLite LIKE treats % and _ as wildcards. Scope tags are user/agent
// supplied, so escape them with a backslash and declare ESCAPE on the clause.
// Without this, a tag like "100%" or "v_2" matches unintended rows.
// String.fromCharCode avoids a literal backslash in source.
const LIKE_ESCAPE_CHARACTER = String.fromCharCode(0x5c);

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => LIKE_ESCAPE_CHARACTER + match);
}

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
    fragments.push(`LOWER(scope_tags) LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'`);
    params.push(`%"${escapeLikePattern(tag)}"%`);
  }

  if (fragments.length === 0) {
    return { clause: '', params: [] };
  }

  return {
    clause: `AND (${fragments.join(' OR ')})`,
    params,
  };
}
