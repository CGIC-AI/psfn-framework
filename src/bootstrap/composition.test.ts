import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { EventBus } from '../event-bus.js';
import { ConfirmationQueue } from '../capabilities/confirmation-queue.js';
import { ModuleLoader } from '../modules/loader.js';
import { DEFAULT_REPL_CONFIG } from '../repl/types.js';
import {
  DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
  extractGatewayMethods,
  validateAndLogToolWiring,
  type GatewayToolMetadataCoverage,
  type RuntimeMode,
} from '../agent/tool-wiring-validator.js';
import type { LLMProvider } from '../agent/contracts.js';
import type { LLMResponse } from '../types.js';
import type { ModuleRegistryMutation } from '../modules/types.js';
import { wireShardAndThinkRuntime } from './composition.js';

type CapabilityTier = 'nursery' | 'apprentice' | 'autonomous';
const EMPTY_MEMORY_STORE = {
  getStats: () => ({
    total: 0,
    avgSalience: 0,
    byType: {},
  }),
};
const ORIGINAL_MODULE_REGISTRY_PATH = process.env.MODULE_REGISTRY_PATH;

beforeEach(() => {
  process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH ?? 'companion/modules/repl-registry.json';
});

afterEach(() => {
  if (ORIGINAL_MODULE_REGISTRY_PATH === undefined) {
    delete process.env.MODULE_REGISTRY_PATH;
  } else {
    process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH;
  }
});

interface GatewayLLMProvider extends LLMProvider {
  fsRead: (path: string) => Promise<string>;
  fsWrite: (path: string, content: string) => Promise<void>;
}

function mockResponse(content: string, inputTokens = 10, outputTokens = 20): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'mock',
    inputTokens,
    outputTokens,
    stopReason: 'stop',
  };
}

function makeInstallScript(source: string): string {
  return [
    '```repl',
    `const result = await module_install("planner", ${JSON.stringify(source)}, true);`,
    'FINAL(JSON.stringify(result));',
    '```',
  ].join('\n');
}

function makeGatewayLLM(
  responses: string[],
  registryPath: string,
): GatewayLLMProvider {
  let callIndex = 0;
  return {
    stream: vi.fn(),
    complete: vi.fn(async () => {
      const response = responses[callIndex] ?? 'FINAL("fallback")';
      callIndex += 1;
      return mockResponse(response);
    }),
    fsRead: vi.fn(async () => readFileSync(registryPath, 'utf-8')),
    fsWrite: vi.fn(async (_path: string, content: string) => {
      writeFileSync(registryPath, content, 'utf-8');
    }),
  };
}

class FakeSubstrateAgent {
  memoryProvider = null;
  tools: AgentTool<any>[] = [];

  registerTool(tool: AgentTool<any>, _category?: 'core' | 'extended'): void {
    this.tools.push(tool);
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return {
      core: this.tools,
      extended: [],
    };
  }

  validateToolWiring(
    mode: RuntimeMode,
    gatewayClient?: object,
    requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage,
  ): void {
    const disabled = validateAndLogToolWiring({
      mode,
      tools: this.tools,
      ...(mode === 'gateway' && gatewayClient
        ? { gatewayClientMethods: extractGatewayMethods(gatewayClient) }
        : {}),
      requiredGatewayMetadataCoverage,
    });
    if (disabled.length === 0) return;

    const disabledSet = new Set(disabled);
    this.tools = this.tools.filter((tool) => !disabledSet.has(tool.name));
  }
}

function findThinkTool(target: FakeSubstrateAgent): AgentTool<any> {
  const think = target.tools.find((tool) => tool.name === 'think');
  if (!think) {
    throw new Error('think tool was not registered');
  }
  return think;
}

function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return '';
  const first = content.find((entry) => entry.type === 'text');
  return first?.text ?? '';
}

function moduleWithActivation(toolName: string): string {
  return [
    'export default {',
    '  name: "planner",',
    '  activate(ctx) {',
    '    ctx.registerTool({',
    `      name: "${toolName}",`,
    '      label: "planner_probe",',
    '      description: "module probe",',
    '      parameters: { type: "object", properties: {}, additionalProperties: false },',
    '      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),',
    '    });',
    '  },',
    '};',
  ].join('\n');
}

function moduleWithMismatchedGatewayMetadata(toolName: string): string {
  return [
    'export default {',
    '  name: "planner",',
    '  activate(ctx) {',
    '    const tool = {',
    `      name: "${toolName}",`,
    '      label: "planner_probe_gateway",',
    '      description: "module probe with wrong gateway metadata",',
    '      parameters: { type: "object", properties: {}, additionalProperties: false },',
    '      execute: async () => ({ content: [{ type: "text", text: "should-not-run" }], details: {} }),',
    '      wiringMeta: { requiredGatewayMethods: ["git.status"] },',
    '    };',
    '    ctx.registerTool(tool);',
    '  },',
    '};',
  ].join('\n');
}

function wireSplitThinkTool(options: {
  tier: CapabilityTier;
  llmProvider: GatewayLLMProvider;
  eventBus: EventBus;
  moduleInstallConfirmationQueue?: ConfirmationQueue | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
}): FakeSubstrateAgent {
  const target = new FakeSubstrateAgent();
  wireShardAndThinkRuntime({
    agentLoop: target as any,
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: {} as any,
    embeddingService: null,
    memoryStore: EMPTY_MEMORY_STORE as any,
    sessionManager: {} as any,
    config: { capabilityTier: options.tier } as any,
    parentSystemPrompt: 'test',
    scheduler: null,
    replConfig: DEFAULT_REPL_CONFIG,
    getCapabilityTier: () => options.tier,
    moduleInstallConfirmationQueue: options.moduleInstallConfirmationQueue ?? null,
    onModuleRegistryMutation: options.onModuleRegistryMutation,
  });
  return target;
}

describe('wireShardAndThinkRuntime split-mode module wiring', () => {
  it('denies module_install for nursery tier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-split-nursery-'));
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, '[]', 'utf-8');

    try {
      const llm = makeGatewayLLM([makeInstallScript('export default {};')], registryPath);
      const onMutation = vi.fn();
      const target = wireSplitThinkTool({
        tier: 'nursery',
        llmProvider: llm,
        eventBus: new EventBus(),
        onModuleRegistryMutation: onMutation,
      });

      const think = findThinkTool(target);
      const result = await think.execute('call-1', { task: 'install module' });
      const text = extractText(result);

      expect(text).toContain('module_install is disabled for nursery tier');
      expect(onMutation).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('queues apprentice installs for approval and activates module on approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-split-apprentice-'));
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, '[]', 'utf-8');

    try {
      const eventBus = new EventBus();
      const queue = new ConfirmationQueue({ idFactory: () => 'confirm-1' });
      const llm = makeGatewayLLM([makeInstallScript(moduleWithActivation('planner_probe_queue'))], registryPath);
      const target = new FakeSubstrateAgent();
      const moduleLoader = new ModuleLoader({
        eventBus,
        registerTool: (tool, category) => target.registerTool(tool, category),
        registryPath,
      });
      const onMutation = vi.fn(async (mutation) => {
        await moduleLoader.applyRegistryMutation(mutation);
      });

      wireShardAndThinkRuntime({
        agentLoop: target as any,
        eventBus,
        llmProvider: llm,
        sessionStore: {} as any,
        embeddingService: null,
        memoryStore: EMPTY_MEMORY_STORE as any,
        sessionManager: {} as any,
        config: { capabilityTier: 'apprentice' } as any,
        parentSystemPrompt: 'test',
        scheduler: null,
        replConfig: DEFAULT_REPL_CONFIG,
        getCapabilityTier: () => 'apprentice',
        moduleInstallConfirmationQueue: queue,
        onModuleRegistryMutation: onMutation,
      });

      const think = findThinkTool(target);
      const result = await think.execute('call-2', { task: 'install module' });
      const text = extractText(result);

      expect(text).toContain('"queued":true');
      expect(onMutation).not.toHaveBeenCalled();

      const pending = queue.listPending();
      expect(pending).toHaveLength(1);

      const resolution = await queue.resolve({
        id: pending[0].id,
        decision: 'approve',
      });
      expect(resolution.status).toBe('approved');
      expect(resolution.executed).toBe(true);
      expect(onMutation).toHaveBeenCalledTimes(1);
      expect(target.tools.map((tool) => tool.name)).toContain('planner_probe_queue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows autonomous installs immediately and activates enabled module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-split-autonomous-'));
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, '[]', 'utf-8');

    try {
      const eventBus = new EventBus();
      const llm = makeGatewayLLM([makeInstallScript(moduleWithActivation('planner_probe_auto'))], registryPath);
      const target = new FakeSubstrateAgent();
      const moduleLoader = new ModuleLoader({
        eventBus,
        registerTool: (tool, category) => target.registerTool(tool, category),
        registryPath,
      });
      const onMutation = vi.fn(async (mutation) => {
        await moduleLoader.applyRegistryMutation(mutation);
      });

      wireShardAndThinkRuntime({
        agentLoop: target as any,
        eventBus,
        llmProvider: llm,
        sessionStore: {} as any,
        embeddingService: null,
        memoryStore: EMPTY_MEMORY_STORE as any,
        sessionManager: {} as any,
        config: { capabilityTier: 'autonomous' } as any,
        parentSystemPrompt: 'test',
        scheduler: null,
        replConfig: DEFAULT_REPL_CONFIG,
        getCapabilityTier: () => 'autonomous',
        onModuleRegistryMutation: onMutation,
      });

      const think = findThinkTool(target);
      const result = await think.execute('call-3', { task: 'install module' });
      const text = extractText(result);

      expect(text).toContain('"ok":true');
      expect(text).not.toContain('"queued":true');
      expect(onMutation).toHaveBeenCalledTimes(1);
      expect(target.tools.map((tool) => tool.name)).toContain('planner_probe_auto');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('module loader + tool wiring revalidation', () => {
  it('disables dynamically loaded invalid gateway-dependent tools before use', async () => {
    class FakeGatewayClient {
      gitStatus(): void { /* noop */ }
      gitCommit(): void { /* noop */ }
    }

    const root = mkdtempSync(join(tmpdir(), 'psfn-module-post-validate-'));
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, JSON.stringify([
      {
        id: 'mod-1',
        name: 'planner',
        source: moduleWithMismatchedGatewayMetadata('repo_commit'),
        enabled: true,
        installedAt: 100,
        updatedAt: 100,
        version: 1,
      },
    ], null, 2), 'utf-8');

    const eventBus = new EventBus();
    const target = new FakeSubstrateAgent();
    const moduleLoader = new ModuleLoader({
      eventBus,
      registerTool: (tool, category) => target.registerTool(tool, category),
      registryPath,
    });

    try {
      const gateway = new FakeGatewayClient();

      // Mirrors startup flow: pre-load validation, module activation, post-load validation.
      target.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);
      const summary = await moduleLoader.loadEnabledModules();
      expect(summary).toEqual({ attempted: 1, loaded: 1, failed: 0 });
      expect(target.tools.map((tool) => tool.name)).toContain('repo_commit');

      target.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);
      expect(target.tools.map((tool) => tool.name)).not.toContain('repo_commit');
    } finally {
      await moduleLoader.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('agent-main split wiring', () => {
  it('wires module lifecycle + tier-gated think deps in split mode', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('new ModuleLoader(');
    expect(source).toContain('moduleLoader.loadEnabledModules()');
    expect(source).toContain('moduleInstallConfirmationQueue: cardProposalQueue');
    expect(source).toContain('onModuleRegistryMutation: async (mutation) =>');
  });

  it('uses deterministic workspace-root module registry paths in split mode', () => {
    const agentSource = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    const gatewaySource = readFileSync(resolve('src/gateway-main.ts'), 'utf-8');
    expect(agentSource).toContain('resolveModuleRegistryPathFromWorkspace(');
    expect(agentSource).toContain('ensureRegistryFile(moduleRegistryPath)');
    expect(agentSource).toContain('registryPath: moduleRegistryPath');
    expect(gatewaySource).toContain('resolveModuleRegistryPathFromWorkspace(');
  });

  it('passes split memory extraction dependencies through composition wiring', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    const wireIndex = source.indexOf('wireMemoryRuntime({');
    expect(wireIndex).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('sessionStore,', wireIndex)).toBeGreaterThan(wireIndex);
    expect(source.indexOf('contactStore,', wireIndex)).toBeGreaterThan(wireIndex);
  });

  it('wires core memory runtime in split mode', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('wireCoreMemoryRuntime({');
    expect(source).toContain('sessionManager,');
  });

  it('gates API voice websocket endpoint on fully wired runtime in split mode', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('createApiVoiceWebSocketRuntime({');
    expect(source).toContain('voiceWebSocketPath = voiceWebSocketRuntime');
    expect(source).toContain('voiceWebSocketRuntime,');
  });

  it('uses durable split shutdown sequence with module + marker teardown', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain("runShutdownStep('shutdown module loader'");
    expect(source).toContain('moduleLoader.shutdown()');
    expect(source).toContain('sessionStore.markGracefulShutdownForActiveChannels()');
  });

  it('re-validates tool wiring after module load in split mode', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    const preIndex = source.indexOf("agentLoop.validateToolWiring('gateway'");
    const moduleLoadIndex = source.indexOf('moduleLoader.loadEnabledModules()');
    const postIndex = source.indexOf("agentLoop.validateToolWiring('gateway'", preIndex + 1);

    expect(preIndex).toBeGreaterThanOrEqual(0);
    expect(moduleLoadIndex).toBeGreaterThan(preIndex);
    expect(postIndex).toBeGreaterThan(moduleLoadIndex);
  });
});

describe('runtime composition wiring', () => {
  it('routes runtime bootstrap through composition helpers', () => {
    const source = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    expect(source).toContain('composeIdentity(this.config)');
    expect(source).toContain('composeSessionRuntime({');
    expect(source).toContain('createEmbeddingProviderFromEnv()');
    expect(source).toContain('composeSubstrateAgent({');
    expect(source).toContain('wireSelfModelRuntime(');
    expect(source).toContain('wireCoreMemoryRuntime({');
    expect(source).toContain('wireMemoryRuntime({');
    expect(source).toContain('wireShardAndThinkRuntime({');
  });

  it('passes sleeptime memory dependencies into shared heartbeat wiring in both runtime modes', () => {
    const runtimeSource = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    const runtimeHeartbeatIndex = runtimeSource.indexOf('wireHeartbeatRuntime(');
    expect(runtimeHeartbeatIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeSource.indexOf('sessionManager: this.sessionManager', runtimeHeartbeatIndex))
      .toBeGreaterThan(runtimeHeartbeatIndex);
    expect(runtimeSource.indexOf('coreMemoryStore,', runtimeHeartbeatIndex))
      .toBeGreaterThan(runtimeHeartbeatIndex);

    const agentSource = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(agentSource).toContain('wireSelfModelRuntime(');
    const agentHeartbeatIndex = agentSource.indexOf('wireHeartbeatRuntime(');
    expect(agentHeartbeatIndex).toBeGreaterThanOrEqual(0);
    expect(agentSource.indexOf('sessionManager,', agentHeartbeatIndex))
      .toBeGreaterThan(agentHeartbeatIndex);
    expect(agentSource.indexOf('coreMemoryStore,', agentHeartbeatIndex))
      .toBeGreaterThan(agentHeartbeatIndex);
  });

  it('routes gateway embedding bootstrap through env provider factory', () => {
    const source = readFileSync(resolve('src/gateway-main.ts'), 'utf-8');
    expect(source).toContain('createEmbeddingProviderFromEnv(process.env)');
    expect(source).not.toContain('new EmbeddingProvider(');
  });

  it('uses shared runtime voice provider gate for gateway Wyoming adapters', () => {
    const source = readFileSync(resolve('src/gateway-main.ts'), 'utf-8');
    expect(source).toContain('resolveRuntimeVoiceProviderGate(config)');
    expect(source).toContain('voiceProviderGate.sttEnabled');
    expect(source).toContain('voiceProviderGate.ttsEnabled');
  });

  it('routes channel adapter bootstrap through shared channel runtime helpers', () => {
    const runtimeSource = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    const agentSource = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    const gatewaySource = readFileSync(resolve('src/gateway-main.ts'), 'utf-8');

    expect(runtimeSource).toContain('createDiscordChannelAdapterFactoryEntry({');
    expect(runtimeSource).toContain('createTelegramChannelAdapterFactoryEntry({');
    expect(runtimeSource).toContain('createApiServerChannelAdapterFactoryEntry({');
    expect(agentSource).toContain('createApiServerChannelAdapterFactoryEntry({');
    expect(gatewaySource).toContain('createDiscordChannelAdapterFactoryEntry({');
    expect(gatewaySource).toContain('createTelegramChannelAdapterFactoryEntry({');

    expect(runtimeSource).not.toContain('new DiscordAdapter(');
    expect(runtimeSource).not.toContain('new TelegramAdapter(');
    expect(runtimeSource).not.toContain('new ApiServer(');
    expect(agentSource).not.toContain('new ApiServer(');
    expect(gatewaySource).not.toContain('new DiscordAdapter(');
    expect(gatewaySource).not.toContain('new TelegramAdapter(');
  });

  it('uses durable gateway shutdown sequencing in split mode', () => {
    const source = readFileSync(resolve('src/gateway-main.ts'), 'utf-8');
    expect(source).toContain('let stopPromise: Promise<void> | null = null;');
    expect(source).toContain("runShutdownStep('stop gateway server'");
    expect(source).toContain('Shutdown step failed; continuing shutdown');
  });

  it('avoids duplicating composition-owned constructor wiring', () => {
    const source = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    expect(source).not.toContain('new SessionStore(');
    expect(source).not.toContain('new SessionManager(');
    expect(source).not.toContain('new AgentLoop(');
    expect(source).not.toContain('new MemoryRetriever(');
    expect(source).not.toContain('new MemoryExtractor(');
    expect(source).not.toContain('new ShardManager(');
    expect(source).not.toContain('createSpawnShardTool(');
    expect(source).not.toContain('createThinkTool(');
  });

  it('re-validates tool wiring after module load in single-process mode', () => {
    const source = readFileSync(resolve('src/runtime.ts'), 'utf-8');
    const preIndex = source.indexOf("this.agentLoop.validateToolWiring('single')");
    const moduleLoadIndex = source.indexOf('this.moduleLoader.loadEnabledModules()');
    const postIndex = source.indexOf("this.agentLoop.validateToolWiring('single')", preIndex + 1);

    expect(preIndex).toBeGreaterThanOrEqual(0);
    expect(moduleLoadIndex).toBeGreaterThan(preIndex);
    expect(postIndex).toBeGreaterThan(moduleLoadIndex);
  });
});
