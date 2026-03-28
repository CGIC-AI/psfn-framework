import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), 'utf-8');
}

describe('startup harness sqlite companion store wiring', () => {
  it('routes sqlite companion store assembly through the focused factory', () => {
    const source = readSource('startup-harness.ts');
    expect(source).toContain('createSqliteCompanionStore(');
    expect(source).not.toContain('new MemoryStore(');
    expect(source).not.toContain('initDatabase(');
  });
});
