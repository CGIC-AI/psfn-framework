import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readSource(relativeToThisFile: string): string {
  return readFileSync(new URL(relativeToThisFile, import.meta.url), 'utf-8');
}

describe('startup entrypoint wiring', () => {
  const agentMainSource = readSource('../agent-main.ts');
  const gatewayMainSource = readSource('../gateway-main.ts');
  const chatCliSource = readSource('../chat-cli.ts');

  it('keeps shared canonical startup hydration call in supported startup entrypoints', () => {
    expect(agentMainSource).toContain('hydrateCanonicalStartupConfig(');
    expect(gatewayMainSource).toContain('hydrateCanonicalStartupConfig(');
    expect(chatCliSource).toContain('hydrateCanonicalStartupConfig(');
  });

  it('logs startup hydration diagnostics in long-running runtime entrypoints', () => {
    expect(agentMainSource).toContain('logStartupHydrationDiagnostics(startupHydration.diagnostics)');
    expect(gatewayMainSource).toContain('logStartupHydrationDiagnostics(startupHydration.diagnostics)');
  });

  it('warms startup ML services before runtime readiness in the long-running agent entrypoint', () => {
    const agentWarmupIndex = agentMainSource.indexOf('await warmRuntimeMlServices(');
    const agentInitIndex = agentMainSource.indexOf("await eventBus.emit('system.init', {})");

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
    expect(agentMainSource).toContain('entrypoint: RUNTIME_MODE.GATEWAY_AGENT');
    expect(gatewayMainSource).toContain('resolveGatewayRuntimeMode(process.env.PSFN_RUNTIME_MODE)');
    expect(chatCliSource).not.toContain('resolveRuntimeModeContract(');
  });
});
