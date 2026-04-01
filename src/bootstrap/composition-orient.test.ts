import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('wireCoreMemoryRuntime orientation wiring', () => {
  it('registers the unified orient tool while keeping core-memory storage wiring', () => {
    const source = readFileSync(resolve('src/bootstrap/composition.ts'), 'utf-8');
    expect(source).toContain('createOrientTool');
    expect(source).toContain('registerTool(createOrientTool(store))');
    expect(source).toContain('resolveCoreMemoryPath(companionDataDir)');
  });
});
