import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), 'utf-8');
}

describe('agent control plane', () => {
  it('agent-main delegates operator surfaces to the extracted helper', () => {
    const agentMainSource = readSource('main.ts');
    expect(agentMainSource).toContain('buildAgentControlPlane(');
    expect(agentMainSource).not.toContain('createSystemTool(');
    expect(agentMainSource).not.toContain('createNotifyOperatorTool(');
    expect(agentMainSource).not.toContain('createDiscordLifecycleNotifier(');
  });

  it('control-plane owns lifecycle notifier, tools, and shutdown sequencing', () => {
    const controlPlaneSource = readSource('control-plane.ts');
    expect(controlPlaneSource).toContain('createDiscordLifecycleNotifier');
    expect(controlPlaneSource).toContain('createSystemTool(');
    expect(controlPlaneSource).toContain('createNotifyOperatorTool(');
    expect(controlPlaneSource).toContain('runShutdownSequence(');
    expect(controlPlaneSource).toContain('resolveRuntimeCommandInvocation');
    expect(controlPlaneSource).toContain("gateway.shellExec('npm', ['run', 'build']");
    expect(controlPlaneSource).toContain('unregister gateway disconnect hook');
    expect(controlPlaneSource).toContain('write graceful shutdown markers');
  });
});
