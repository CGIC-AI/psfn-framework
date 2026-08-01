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

  it('finishes contact lifecycle startup recovery before registering contact/admin surfaces', () => {
    const agentMainSource = readSource('main.ts');
    const persistenceIndex = agentMainSource.indexOf('createAgentPersistenceRuntime(');
    const coreIndex = agentMainSource.indexOf('bootstrapAgentCoreRuntime(');
    const adminIndex = agentMainSource.indexOf('startOptionalAdminTransportServer(');
    expect(persistenceIndex).toBeGreaterThan(-1);
    expect(coreIndex).toBeGreaterThan(persistenceIndex);
    expect(adminIndex).toBeGreaterThan(coreIndex);
    expect(agentMainSource).toContain('contactLifecycleRecovery?.stop()');
  });

  it('core-runtime owns the prompt/session/memory wiring seam', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain('registerWebTools(');
    expect(coreRuntimeSource).toContain('wirePromptRuntime(');
    expect(coreRuntimeSource).toContain('wireSessionToolsRuntime(');
    expect(coreRuntimeSource).toContain('wireCoreMemoryRuntime(');
    expect(coreRuntimeSource).toContain('wireMemoryRuntime(');
  });

  it('registers the canonical lazy MCP client with runtime-derived disclosure lineage', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain('agentLoop.registerTool(createMcpTool({');
    expect(coreRuntimeSource).toContain(
      'getDisclosureLineage: () => agentLoop.getCurrentTurnDisclosureLineage()',
    );
  });

  it('wires concern resolution through isolated startup reconciliation and scoped emotion state', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain('createConcernResolutionArcRecorder({');
    expect(coreRuntimeSource).toContain('agentLoop.applyConcernResolutionDelta(');
    expect(coreRuntimeSource).toContain('await reconcileConcernResolutionArcsAtStartup({');
    expect(coreRuntimeSource).not.toContain('await reconcileConcernResolutionArcs({');
    expect(coreRuntimeSource).toContain(
      "eventBus.on('intention.concern.resolution_appraisal', concernResolutionArcRecorder)",
    );
  });

  it('wires live self_status statistics through the trusted subject provider', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain(
      'getMemoryStats: createSelfStatusMemoryStatsProvider(memoryStore)',
    );
    expect(coreRuntimeSource).not.toContain('getMemoryStats: () => memoryStore.getStats()');
  });

  it('wires fatigue accounting into the live agent runtime', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain('composeFatigueBudgetRuntime({ config, eventBus })');
    expect(coreRuntimeSource).toContain('fatigueBudget: fatigueRuntime.fatigueBudget');
    expect(coreRuntimeSource).toContain('fatigueLedger: fatigueRuntime.fatigueLedger');
  });

  it('threads scheduler-owned durable background-work tuning and welfare into every live runtime layer', () => {
    const agentMainSource = readSource('main.ts');
    const coreBootstrapSource = readSource('core-bootstrap.ts');
    const coreRuntimeSource = readSource('core-runtime.ts');
    const compositionSource = readFileSync(
      join(SRC_DIR, '../startup/composition/composition.ts'),
      'utf-8',
    );
    const icpCertificationAgentSource = readFileSync(
      join(SRC_DIR, '../e2e/icp-certification/agent-process.ts'),
      'utf-8',
    );
    const substrateAgentSource = readFileSync(
      join(SRC_DIR, '../../core/agent/substrate-agent.ts'),
      'utf-8',
    );

    expect(agentMainSource).toContain(
      'backgroundWorkTuning: schedulerConfig.backgroundWork',
    );
    expect(agentMainSource).toContain(
      'schedulerConfig.backgroundWorkWelfare ?? DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG',
    );
    expect(coreBootstrapSource).toContain('backgroundWorkTuning,');
    expect(coreBootstrapSource).toContain('backgroundWorkWelfare: options.backgroundWorkWelfare');
    expect(coreRuntimeSource).toContain(
      'backgroundWorkTuning: options.backgroundWorkTuning',
    );
    expect(coreRuntimeSource).toContain(
      'backgroundWorkWelfare: options.backgroundWorkWelfare',
    );
    expect(compositionSource).toContain(
      'backgroundWorkTuning: options.backgroundWorkTuning',
    );
    expect(compositionSource).toContain(
      'backgroundWorkWelfare: options.backgroundWorkWelfare',
    );
    expect(icpCertificationAgentSource).toContain(
      'backgroundWorkWelfare: startup.schedulerConfig.backgroundWorkWelfare',
    );
    expect(substrateAgentSource).toContain('...backgroundWorkTuning.supervisor');
    expect(substrateAgentSource).toContain('tuning: backgroundWorkTuning.postTurn');
    expect(substrateAgentSource).toContain('welfare: backgroundWorkWelfare');
    expect(substrateAgentSource).toContain(
      'SubstrateAgent requires scheduler-owned durable background work tuning',
    );
    expect(substrateAgentSource).toContain(
      'SubstrateAgent requires scheduler-owned durable background work welfare policy',
    );
  });

  it('threads injected episodic stores instead of disabling L0.1 when sqlite db is absent', () => {
    const agentMainSource = readSource('main.ts');
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(agentMainSource).toContain('episodicStore: companionEpisodicStore');
    expect(agentMainSource).not.toContain('db ? new EpisodicStore(db) : null');
    expect(coreRuntimeSource).toContain('PostgreSQL core runtime requires an injected episodic store');
    expect(coreRuntimeSource).not.toContain('episodicStore: db ? new EpisodicStore(db) : null');
  });

  it('fails closed instead of using sqlite fallbacks for postgres-owned runtime stores', () => {
    const coreRuntimeSource = readSource('core-runtime.ts');
    expect(coreRuntimeSource).toContain('PostgreSQL core runtime requires an injected memory store');
    expect(coreRuntimeSource).toContain('PostgreSQL core runtime requires an injected contact store');
    expect(coreRuntimeSource).toContain('PostgreSQL core runtime requires injected intention persistence stores');
  });

  it('threads shared-world caretaker maintenance and shutdown handles through agent main', () => {
    const agentMainSource = readSource('main.ts');
    const coreRuntimeSource = readSource('core-runtime.ts');

    expect(coreRuntimeSource).toContain(
      'sharedWorldWikiCaretaker: wikiRuntime.sharedWorldCaretaker',
    );
    expect(coreRuntimeSource).toContain('closeWikiRuntime: wikiRuntime.close');
    expect(agentMainSource).toContain(
      'sharedWorldWikiCaretaker: coreRuntime.sharedWorldWikiCaretaker',
    );
    expect(agentMainSource).toContain('await coreRuntime.closeWikiRuntime()');
  });
});
