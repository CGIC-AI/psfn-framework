import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, AgentToolResult } from '../../../boundary/pi-agent/index.js';
import { createToolConformanceRunner } from './runner.js';
import { readToolConformanceLatest } from './store.js';
import { ToolConformanceHarnessError } from './types.js';

function okResult(): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text: 'ok' }], details: {} };
}

// Uses real canonical tool names so the default probe registry classifies them.
function tool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => okResult(),
  } as AgentTool<any>;
}

describe('tool conformance runner', () => {
  let systemDataDir: string;

  beforeEach(() => {
    systemDataDir = mkdtempSync(join(tmpdir(), 'tool-conformance-runner-'));
  });

  afterEach(() => {
    rmSync(systemDataDir, { recursive: true, force: true });
  });

  it('runs the sweep, persists the result, and reads it back', async () => {
    const runner = createToolConformanceRunner({
      getToolCatalog: () => ({ core: [tool('memory'), tool('notify')], extended: [tool('vault')] }),
      systemDataDir,
      now: () => 12_345,
    });

    const result = await runner.run('post_rollout');
    expect(result.trigger).toBe('post_rollout');
    expect(result.ranAt).toBe(12_345);
    expect(result.results.map(r => r.toolName)).toContain('memory');

    const persisted = readToolConformanceLatest(systemDataDir);
    expect(persisted).toEqual(result);
    expect(runner.getLatest()).toEqual(result);
  });

  it('propagates a harness fault (unclassified live tool) and writes nothing', async () => {
    const runner = createToolConformanceRunner({
      getToolCatalog: () => ({ core: [tool('definitely_not_a_real_tool')], extended: [] }),
      systemDataDir,
    });
    await expect(runner.run('manual')).rejects.toBeInstanceOf(ToolConformanceHarnessError);
    expect(readToolConformanceLatest(systemDataDir)).toBeNull();
  });
});
