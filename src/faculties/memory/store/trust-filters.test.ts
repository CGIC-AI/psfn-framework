import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildScopeQuerySql } from './trust-filters.js';

// Proves scope-tag LIKE queries cannot be hijacked by % or _ wildcards in the tag.
describe('buildScopeQuerySql wildcard escaping', () => {
  function execMatch(tagQuery: string, storedTags: string): boolean {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (scope_tags TEXT NOT NULL)');
    db.prepare('INSERT INTO t (scope_tags) VALUES (?)').run(storedTags);
    const { clause, params } = buildScopeQuerySql({ mode: 'only', tags: [tagQuery] });
    const row = db.prepare(`SELECT 1 FROM t WHERE 1=1 ${clause}`).get(...params);
    db.close();
    return row !== undefined;
  }

  it('matches an exact tag containing % only when the literal % is present', () => {
    // stored JSON-ish tag list containing a literal "100%" tag
    expect(execMatch('100%', '["100%","other"]')).toBe(true);
    // a row tagged "1005" must NOT match a query for the literal "100%"
    expect(execMatch('100%', '["1005","other"]')).toBe(false);
  });

  it('matches an exact tag containing _ only when the literal _ is present', () => {
    expect(execMatch('v_2', '["v_2","other"]')).toBe(true);
    expect(execMatch('v_2', '["vX2","other"]')).toBe(false);
  });

  it('escapes the backslash escape character itself', () => {
    expect(execMatch('a\\b', '["a\\b","other"]')).toBe(true);
  });
});
