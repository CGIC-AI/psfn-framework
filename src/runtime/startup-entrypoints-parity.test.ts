import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readSource(relativeToThisFile: string): string {
  return readFileSync(new URL(relativeToThisFile, import.meta.url), 'utf-8');
}

describe('startup entrypoint parity wiring', () => {
  const runtimeSource = readSource('../runtime.ts');
  const agentMainSource = readSource('../agent-main.ts');
  const gatewayMainSource = readSource('../gateway-main.ts');
  const chatCliSource = readSource('../chat-cli.ts');

  it('keeps shared canonical startup hydration call in all runtime entrypoints', () => {
    expect(runtimeSource).toContain('hydrateCanonicalStartupConfig(');
    expect(agentMainSource).toContain('hydrateCanonicalStartupConfig(');
    expect(gatewayMainSource).toContain('hydrateCanonicalStartupConfig(');
    expect(chatCliSource).toContain('hydrateCanonicalStartupConfig(');
  });

  it('logs startup hydration diagnostics in long-running runtime entrypoints', () => {
    expect(runtimeSource).toContain('logStartupHydrationDiagnostics(startupHydration.diagnostics)');
    expect(agentMainSource).toContain('logStartupHydrationDiagnostics(startupHydration.diagnostics)');
    expect(gatewayMainSource).toContain('logStartupHydrationDiagnostics(startupHydration.diagnostics)');
  });

  it('warms startup ML services before runtime readiness in the long-running agent entrypoints', () => {
    const runtimeWarmupIndex = runtimeSource.indexOf('await warmRuntimeMlServices(');
    const runtimeInitIndex = runtimeSource.indexOf("await this.eventBus.emit('system.init', {})");
    const agentWarmupIndex = agentMainSource.indexOf('await warmRuntimeMlServices(');
    const agentInitIndex = agentMainSource.indexOf("await eventBus.emit('system.init', {})");

    expect(runtimeWarmupIndex).toBeGreaterThan(-1);
    expect(runtimeInitIndex).toBeGreaterThan(-1);
    expect(runtimeWarmupIndex).toBeLessThan(runtimeInitIndex);

    expect(agentWarmupIndex).toBeGreaterThan(-1);
    expect(agentInitIndex).toBeGreaterThan(-1);
    expect(agentWarmupIndex).toBeLessThan(agentInitIndex);
  });

  it('hydrates chat-cli before constructing model/session runtime dependencies', () => {
    const hydrateIndex = chatCliSource.indexOf('hydrateCanonicalStartupConfig(config, { env: process.env });');
    const llmClientIndex = chatCliSource.indexOf('const llmClient = new LLMClient(config);');
    const sessionRuntimeIndex = chatCliSource.indexOf('const sessionComposition = composeSessionRuntime({ config });');

    expect(hydrateIndex).toBeGreaterThan(-1);
    expect(llmClientIndex).toBeGreaterThan(-1);
    expect(sessionRuntimeIndex).toBeGreaterThan(-1);
    expect(hydrateIndex).toBeLessThan(llmClientIndex);
    expect(hydrateIndex).toBeLessThan(sessionRuntimeIndex);
  });

  it('preserves intentional mode-specific lifecycle hook behavior by entrypoint', () => {
    expect(runtimeSource).toContain('entrypoint: RUNTIME_MODE.SINGLE');
    expect(agentMainSource).toContain('entrypoint: RUNTIME_MODE.GATEWAY_AGENT');
    expect(gatewayMainSource).toContain('resolveGatewayRuntimeMode(process.env.PSFN_RUNTIME_MODE)');
    expect(chatCliSource).not.toContain('resolveRuntimeModeContract(');
  });
});
