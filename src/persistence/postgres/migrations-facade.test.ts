import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Module contract for the migration registry facade (psfn-framework-emh3p.10).
 * `migrations.ts` only re-exports chains owned by domain modules, so a new
 * migration must land in its owning domain file: the facade stays small and
 * cannot hold SQL template literals, local declarations, or imports.
 */
const FACADE_MAX_LINES = 500;
const facadeSource = readFileSync(fileURLToPath(new URL('./migrations.ts', import.meta.url)), 'utf8');

describe('Postgres migration registry facade', () => {
  it(`stays at or under ${FACADE_MAX_LINES} lines`, () => {
    expect(facadeSource.split('\n').length).toBeLessThanOrEqual(FACADE_MAX_LINES);
  });

  it('holds no SQL template literals', () => {
    expect(facadeSource).not.toContain('`');
  });

  it('declares nothing and only re-exports from sibling domain modules', () => {
    expect(facadeSource).not.toMatch(/^\s*(?:export\s+)?(?:const|let|var|function|class)\b/m);
    expect(facadeSource).not.toMatch(/^import\b/m);
    const reexportSources = [...facadeSource.matchAll(/^} from '([^']+)';$|^export \{[^}]*\} from '([^']+)';$/gm)].map(
      match => match[1] ?? match[2],
    );
    expect(reexportSources.length).toBeGreaterThan(0);
    for (const source of reexportSources) {
      expect(source).toMatch(/^\.\/[a-z0-9-]+-migrations\.js$/);
    }
  });
});
