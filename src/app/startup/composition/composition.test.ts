import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { EventBus } from '../../../shared/event-bus.js';
import { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import { ModuleLoader } from '../../../system/modules/loader.js';
import { DEFAULT_REPL_CONFIG } from '../../../core/tools/think/types.js';
import {
  DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
  extractGatewayMethods,
  validateAndLogToolWiring,
  type GatewayToolMetadataCoverage,
  type RuntimeMode,
} from '../../../core/agent/tool-wiring-validator.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type { SandboxExecutionPort } from '../../../boundary/sandbox/capabilities/contracts.js';
import { withNodeVmSandboxExecutionPort } from '../../../boundary/sandbox/sandbox-execution-port.js';
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

interface GatewayLLMProvider extends LLMProviderPort {
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

function makeShellExecScript(): string {
  return [
    '```repl',
    'const result = await shell_exec("node", ["-v"]);',
    'FINAL(JSON.stringify({ ok: result.ok, stdout: result.stdout }));',
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
  registrations: Array<{ tool: AgentTool<any>; category: 'core' | 'extended' }> = [];

  registerTool(tool: AgentTool<any>, category: 'core' | 'extended' = 'core'): void {
    this.tools.push(tool);
    this.registrations.push({ tool, category });
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return {
      core: this.registrations
        .filter((entry) => entry.category === 'core')
        .map((entry) => entry.tool),
      extended: this.registrations
        .filter((entry) => entry.category === 'extended')
        .map((entry) => entry.tool),
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
      ...(gatewayClient ? { gatewayClientMethods: extractGatewayMethods(gatewayClient) } : {}),
      requiredGatewayMetadataCoverage,
    });
    if (disabled.length === 0) return;

    const disabledSet = new Set(disabled);
    this.tools = this.tools.filter((tool) => !disabledSet.has(tool.name));
  }
}

function findAnalysisWorkbenchTool(target: FakeSubstrateAgent): AgentTool<any> {
  const tool = target.tools.find((candidate) => candidate.name === 'analysis_workbench');
  if (!tool) {
    throw new Error('analysis_workbench tool was not registered');
  }
  return tool;
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
  executionPort?: SandboxExecutionPort | null;
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
    executionPort: options.executionPort ?? null,
  });
  return target;
}

function makeExecutionPort(
  overrides: Partial<SandboxExecutionPort> = {},
): SandboxExecutionPort {
  const base = withNodeVmSandboxExecutionPort(null);
  return {
    boundary: overrides.boundary ?? base.boundary,
    codeExecutionBoundary: overrides.codeExecutionBoundary ?? base.codeExecutionBoundary,
    shellExec: overrides.shellExec ?? base.shellExec,
    executeCode: overrides.executeCode ?? base.executeCode,
  };
}

describe('wireShardAndThinkRuntime split-mode module wiring', () => {
  it('registers subagent as the canonical core surface and keeps spawn_subagent as extended compatibility', () => {
    const llm: GatewayLLMProvider = {
      stream: vi.fn(),
      complete: vi.fn(async () => mockResponse('FINAL("noop")')),
      fsRead: vi.fn(async () => '[]'),
      fsWrite: vi.fn(async () => undefined),
    };
    const target = wireSplitThinkTool({
      tier: 'autonomous',
      llmProvider: llm,
      eventBus: new EventBus(),
    });

    expect(target.registrations.find((entry) => entry.tool.name === 'subagent')?.category).toBe('core');
    expect(target.registrations.find((entry) => entry.tool.name === 'spawn_subagent')?.category).toBe('extended');
  });

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

      const analysisWorkbench = findAnalysisWorkbenchTool(target);
      const result = await analysisWorkbench.execute('call-1', { task: 'install module' });
      const text = extractText(result);

      expect(text).toContain('module_install is disabled for nursery tier');
      expect(onMutation).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('queues apprentice installs for approval and surfaces activation failure on approval', async () => {
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

      const shardPort = wireShardAndThinkRuntime({
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
      expect(shardPort.getActiveCount()).toBe(0);
      expect(shardPort.getActiveShards()).toEqual([]);

      const analysisWorkbench = findAnalysisWorkbenchTool(target);
      const result = await analysisWorkbench.execute('call-2', { task: 'install module' });
      const text = extractText(result);

      expect(text).toContain('"queued":true');
      expect(onMutation).not.toHaveBeenCalled();

      const pending = queue.listPending();
      expect(pending).toHaveLength(1);

      const resolution = await queue.resolve({
        id: pending[0].id,
        decision: 'approve',
      });
      expect(resolution.status).toBe('failed');
      expect(resolution.executed).toBe(false);
      expect(resolution.message).toContain('registry-backed module source execution is disabled');
      expect(onMutation).toHaveBeenCalledTimes(1);
      expect(target.tools.map((tool) => tool.name)).not.toContain('planner_probe_queue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces autonomous install activation failure and leaves the module inactive', async () => {
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

      const analysisWorkbench = findAnalysisWorkbenchTool(target);
      const result = await analysisWorkbench.execute('call-3', { task: 'install module' });
      const text = extractText(result);

      expect(text).toContain('"ok":false');
      expect(text).toContain('registry-backed module source execution is disabled');
      expect(text).not.toContain('"queued":true');
      expect(onMutation).toHaveBeenCalledTimes(1);
      expect(target.tools.map((tool) => tool.name)).not.toContain('planner_probe_auto');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes shell_exec through the explicit sandbox broker port', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-split-shell-broker-'));
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, '[]', 'utf-8');

    try {
      const llm = makeGatewayLLM([makeShellExecScript()], registryPath);
      const executionPort = makeExecutionPort({
        boundary: {
          kind: 'sandbox_broker',
          isolatedFromGatewaySecrets: true,
          brokerId: 'test-broker',
        },
        shellExec: vi.fn(async () => ({
          command: 'node',
          args: ['-v'],
          cwd: '/sandbox/workspace',
          exitCode: 0,
          stdout: 'v22.0.0',
          stderr: '',
          timedOut: false,
          truncated: false,
          durationMs: 7,
        })),
        codeExecutionBoundary: {
          kind: 'node_vm',
          isolatedFromGatewaySecrets: false,
          securityPosture: 'non_isolated',
          reason: 'test analysis workbench adapter',
        },
      });
      const target = wireSplitThinkTool({
        tier: 'autonomous',
        llmProvider: llm,
        eventBus: new EventBus(),
        executionPort,
      });

      const analysisWorkbench = findAnalysisWorkbenchTool(target);
      const result = await analysisWorkbench.execute('call-shell', { task: 'check brokered shell path' });
      const text = extractText(result);

      expect(text).toContain('"ok":true');
      expect(text).toContain('"stdout":"v22.0.0"');
      expect(executionPort.shellExec).toHaveBeenCalledWith('node', ['-v'], {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes analysis workbench code execution through the sandbox execution port', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-split-code-broker-'));
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, '[]', 'utf-8');

    try {
      const llm = makeGatewayLLM(['```repl\nprint("through-port"); FINAL("done");\n```'], registryPath);
      const fallbackPort = withNodeVmSandboxExecutionPort(null);
      const executeCode = vi.fn(fallbackPort.executeCode);
      const executionPort = makeExecutionPort({
        boundary: {
          kind: 'sandbox_broker',
          isolatedFromGatewaySecrets: true,
          brokerId: 'test-broker',
        },
        codeExecutionBoundary: {
          kind: 'node_vm',
          isolatedFromGatewaySecrets: false,
          securityPosture: 'non_isolated',
          reason: 'test analysis workbench adapter',
        },
        executeCode,
      });
      const target = wireSplitThinkTool({
        tier: 'autonomous',
        llmProvider: llm,
        eventBus: new EventBus(),
        executionPort,
      });

      const analysisWorkbench = findAnalysisWorkbenchTool(target);
      const result = await analysisWorkbench.execute('call-code', { task: 'exercise analysis workbench execution port' });
      const text = extractText(result);

      expect(text).toContain('done');
      expect(executeCode).toHaveBeenCalledTimes(1);
      expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({
        code: expect.stringContaining('FINAL("done");'),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('module loader + tool wiring revalidation', () => {
  it('records blocked startup module activation and leaves invalid tools unavailable', async () => {
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
      expect(summary).toEqual({ attempted: 1, loaded: 0, failed: 1 });
      expect(target.tools.map((tool) => tool.name)).not.toContain('repo_commit');

      target.validateToolWiring('gateway', gateway, DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE);
      expect(target.tools.map((tool) => tool.name)).not.toContain('repo_commit');
    } finally {
      await moduleLoader.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
