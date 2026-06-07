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
    const agentMainSource = readSource('main.ts');
    expect(agentMainSource).toContain('prepareAgentStartupContext(');
    expect(agentMainSource).toContain('bootstrapAgentCoreRuntime(');
    expect(agentMainSource).toContain('createAgentPersistenceRuntime(');
    expect(agentMainSource).not.toContain('wirePromptRuntime(');
    expect(agentMainSource).not.toContain('wireMemoryRuntime(');
  });

  it('core-runtime owns the prompt/session/memory wiring seam', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain('registerWebTools(');
    expect(coreRuntimeSource).toContain('wirePromptRuntime(');
    expect(coreRuntimeSource).toContain('wireSessionToolsRuntime(');
    expect(coreRuntimeSource).toContain('wireCoreMemoryRuntime(');
    expect(coreRuntimeSource).toContain('wireMemoryRuntime(');
  });

  it('threads injected episodic stores instead of disabling L0.1 when sqlite db is absent', () => {
    const agentMainSource = readSource('main.ts');
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(agentMainSource).toContain('episodicStore: companionEpisodicStore');
    expect(agentMainSource).not.toContain('db ? new EpisodicStore(db) : null');
    expect(coreRuntimeSource).toContain('PostgreSQL core runtime requires an injected episodic store');
    expect(coreRuntimeSource).not.toContain('episodicStore: db ? new EpisodicStore(db) : null');
  });
});
