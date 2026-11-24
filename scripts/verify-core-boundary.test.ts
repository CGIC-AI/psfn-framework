import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectCoreToHostEdges,
  evaluateCoreBoundary,
  isHostOnlySourcePath,
} from './verify-core-boundary.js';

describe('verify-core-boundary', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'psfn-core-boundary-'));
    dirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    }
    return root;
  }

  it('classifies host-only subtrees vs core domain paths accurately', () => {
    expect(isHostOnlySourcePath('boundary/gateway/client.ts')).toBe(true);
    expect(isHostOnlySourcePath('channels/discord/adapter.ts')).toBe(true);
    expect(isHostOnlySourcePath('faculties/wiki/active-context.ts')).toBe(true);
    expect(isHostOnlySourcePath('primitives/images/types.ts')).toBe(true);
    expect(isHostOnlySourcePath('operator/tool-health/types.ts')).toBe(true);

    expect(isHostOnlySourcePath('shared/contracts/notification-port.ts')).toBe(false);
    expect(isHostOnlySourcePath('core/agent/substrate-agent.ts')).toBe(false);
    expect(isHostOnlySourcePath('faculties/memory/retrieval.ts')).toBe(false);
    expect(isHostOnlySourcePath('core/cogsec/disclosure/decision.ts')).toBe(false);
  });

  it('flags new core->host edges and stale baseline entries fail-closed', () => {
    const srcRoot = makeTree({
      'shared/contracts/port.ts': 'export interface Port { ok: boolean; }\n',
      'boundary/gateway/impl.ts': "import type { Port } from '../../shared/contracts/port.js';\nexport const impl: Port = { ok: true };\n",
      'core/agent/good.ts': "import type { Port } from '../../shared/contracts/port.js';\nexport type Good = Port;\n",
      'core/agent/bad.ts': "import { impl } from '../../boundary/gateway/impl.js';\nexport const leaked = impl;\n",
    });

    const detected = detectCoreToHostEdges(srcRoot);
    expect(detected.coreFileCount).toBe(3);
    expect(detected.hostFileCount).toBe(1);
    expect(detected.edges).toEqual(['core/agent/bad.ts -> boundary/gateway/impl.ts']);

    const evaluated = evaluateCoreBoundary(srcRoot, {
      schemaVersion: 1,
      remediationTracker: 'psfn-framework-kbdvl.1',
      edges: ['core/agent/old.ts -> boundary/gateway/impl.ts'],
    });
    expect(evaluated.newEdges).toEqual(['core/agent/bad.ts -> boundary/gateway/impl.ts']);
    expect(evaluated.staleEdges).toEqual(['core/agent/old.ts -> boundary/gateway/impl.ts']);
  });
});
