import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  wireIntentionRuntime,
  type IntentionRuntimeTarget,
} from './runtime-wiring.js';

class FakeTarget implements IntentionRuntimeTarget {
  activeConcernProvider: IntentionRuntimeTarget['activeConcernProvider'] = null;
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
  }
}

describe('wireIntentionRuntime', () => {
  it('injects ActiveConcernStore and registers concern tools', () => {
    const db = new Database(':memory:');
    const target = new FakeTarget();

    const store = wireIntentionRuntime(target, db);

    expect(target.activeConcernProvider).toBe(store);
    expect(target.tools.map(tool => tool.name).sort()).toEqual([
      'create_concern',
      'list_concerns',
      'resolve_concern',
    ]);
  });
});

describe('entrypoint composition', () => {
  it('runtime.ts uses shared intention runtime wiring', () => {
    const runtimeSource = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    expect(runtimeSource).toContain('wireIntentionRuntime(');
  });

  it('agent-main.ts uses shared intention runtime wiring', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('wireIntentionRuntime(');
  });
});
