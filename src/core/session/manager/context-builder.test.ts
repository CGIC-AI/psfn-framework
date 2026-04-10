import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('orientation context surface wiring', () => {
  it('threads orientation telemetry into continuity assembly without relying on legacy token-section labels', () => {
    const builderSource = readFileSync(resolve('src/core/session/manager/context-builder.ts'), 'utf-8');
    const manifestSource = readFileSync(resolve('src/core/session/context-manifest.ts'), 'utf-8');

    expect(builderSource).toContain('buildOrientationNoteTelemetry');
    expect(builderSource).toContain('params.turnSnapshot?.orientation');
    expect(builderSource).toContain('continuitySectionText = orientationTelemetry.noteText');
    expect(manifestSource).toContain("| 'orientation'");
  });
});
