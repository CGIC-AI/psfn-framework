import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), 'utf-8');
}

describe('agent core runtime builder', () => {
  it('agent-main delegates core wiring to the extracted builder', () => {
    const agentMainSource = readSource('../agent-main.ts');
    expect(agentMainSource).toContain('buildAgentCoreRuntime(');
    expect(agentMainSource).toContain('createSqliteCompanionStore(');
    expect(agentMainSource).not.toContain('wirePromptRuntime(');
    expect(agentMainSource).not.toContain('wireMemoryRuntime(');
  });

  it('core-runtime owns the prompt/session/memory wiring seam', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain('wirePromptRuntime(');
    expect(coreRuntimeSource).toContain('wireSessionToolsRuntime(');
    expect(coreRuntimeSource).toContain('wireCoreMemoryRuntime(');
    expect(coreRuntimeSource).toContain('wireMemoryRuntime(');
  });
});
