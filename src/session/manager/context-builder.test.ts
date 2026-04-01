import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('orientation context surface wiring', () => {
  it('tracks orientation as a first-class manifest section in session context assembly', () => {
    const builderSource = readFileSync(resolve('src/session/manager/context-builder.ts'), 'utf-8');
    const manifestSource = readFileSync(resolve('src/session/context-manifest.ts'), 'utf-8');

    expect(builderSource).toContain("section: 'orientation'");
    expect(builderSource).toContain('orientationTokenCount');
    expect(manifestSource).toContain("| 'orientation'");
  });
});
