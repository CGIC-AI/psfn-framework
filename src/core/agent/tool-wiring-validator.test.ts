import { describe, it, expect } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
  validateToolWiring,
  validateAndLogToolWiring,
  extractGatewayMethods,
  resolveClientMethod,
  type ToolConcurrencyMeta,
  type WirableTool,
} from './tool-wiring-validator.js';

// ── Helpers ──

function makeTool(name: string, meta?: WirableTool['wiringMeta']): AgentTool<any> {
  const tool: WirableTool = {
    name,
    label: name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object' as const, properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
  if (meta) {
    tool.wiringMeta = meta;
  }
  return tool;
}

function makeConcurrencyMeta(
  toolClass: ToolConcurrencyMeta['class'],
  overrides?: Partial<ToolConcurrencyMeta>,
): ToolConcurrencyMeta {
  const eligibility = {
    foreground: true,
    background: true,
    ...(overrides?.eligibility ?? {}),
  };

  const base: ToolConcurrencyMeta = {
    class: toolClass,
    exclusivityKeyPolicy: toolClass === 'exclusive' ? 'category_tool_name' : 'none',
    ...(toolClass === 'exclusive' ? { exclusivityKey: 'core:test_tool' } : {}),
    ...(toolClass === 'exclusive' ? {} : { maxParallel: 3 }),
    interruptibility: toolClass === 'spawn_subagent' ? 'non_interruptible' : 'cooperative',
    eligibility,
  };

  return {
    ...base,
    ...overrides,
    ...(overrides?.eligibility ? { eligibility: { ...eligibility, ...overrides.eligibility } } : {}),
  };
}

// ── Tests ──

describe('resolveClientMethod', () => {
  it('maps known RPC methods to client method names', () => {
    expect(resolveClientMethod('git.status')).toBe('gitStatus');
    expect(resolveClientMethod('git.diff')).toBe('gitDiff');
    expect(resolveClientMethod('git.create_branch')).toBe('gitCreateBranch');
    expect(resolveClientMethod('git.apply_patch')).toBe('gitApplyPatch');
    expect(resolveClientMethod('git.commit')).toBe('gitCommit');
    expect(resolveClientMethod('git.open_pr')).toBe('gitOpenPR');
    expect(resolveClientMethod('beads.ready')).toBe('beadsReady');
    expect(resolveClientMethod('beads.create')).toBe('beadsCreate');
    expect(resolveClientMethod('fs.search')).toBe('fsSearch');
    expect(resolveClientMethod('fs.edit')).toBe('fsEdit');
    expect(resolveClientMethod('image.create')).toBe('imageCreate');
    expect(resolveClientMethod('image.edit')).toBe('imageEdit');
    expect(resolveClientMethod('llm.chat')).toBe('stream');
    expect(resolveClientMethod('llm.complete')).toBe('complete');
    expect(resolveClientMethod('discord.send')).toBe('discordSend');
  });

  it('falls back to the RPC name for unknown methods', () => {
    expect(resolveClientMethod('unknown.method')).toBe('unknown.method');
  });
});

describe('extractGatewayMethods', () => {
  it('extracts method names from an object prototype', () => {
    class FakeClient {
      gitStatus(): void { /* noop */ }
      gitDiff(): void { /* noop */ }
      embed(): void { /* noop */ }
    }
    const client = new FakeClient();
    const methods = extractGatewayMethods(client);
    expect(methods.has('gitStatus')).toBe(true);
    expect(methods.has('gitDiff')).toBe(true);
    expect(methods.has('embed')).toBe(true);
    // constructor should be excluded
    expect(methods.has('constructor')).toBe(false);
  });

  it('returns Object.prototype methods for plain objects', () => {
    const methods = extractGatewayMethods({});
    // Plain objects inherit from Object.prototype — they will have toString, etc.
    // The important thing is that custom client methods are included
    expect(methods.has('toString')).toBe(true);
    // But no custom methods
    expect(methods.has('gitStatus')).toBe(false);
  });
});

describe('validateToolWiring', () => {
  it('passes tools without wiringMeta', () => {
    const tools = [
      makeTool('memory_write'),
      makeTool('think'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
    });
    expect(report.totalTools).toBe(2);
    expect(report.validTools).toBe(2);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('passes tools with satisfied gateway dependencies', () => {
    const tools = [
      makeTool('repo_status', {
        requiredGatewayMethods: ['git.status'],
      }),
      makeTool('repo_diff', {
        requiredGatewayMethods: ['git.diff'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus', 'gitDiff', 'gitCommit']),
    });
    expect(report.totalTools).toBe(2);
    expect(report.validTools).toBe(2);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('flags tools with missing gateway dependencies', () => {
    const tools = [
      makeTool('repo_status', {
        requiredGatewayMethods: ['git.status'],
      }),
      makeTool('repo_commit', {
        requiredGatewayMethods: ['git.commit'],
      }),
    ];
    // Client only has gitStatus, not gitCommit
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
    });
    expect(report.totalTools).toBe(2);
    expect(report.validTools).toBe(1);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('repo_commit');
    expect(report.invalidTools[0].missingGatewayMethods).toEqual(['git.commit (client: gitCommit)']);
  });

  it('flags gateway-dependent tools with missing required metadata coverage', () => {
    const tools = [
      makeTool('repo_commit'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitCommit']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('repo_commit');
    expect(report.invalidTools[0].missingGatewayMetadataCoverage[0]).toContain('git.commit');
  });

  it('requires gateway metadata coverage for the unified web tool', () => {
    const tools = [
      makeTool('web'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['webFetch']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('web');
    expect(report.invalidTools[0].missingGatewayMetadataCoverage[0]).toContain('web.fetch');
  });

  it('flags gateway-dependent tools with partial metadata coverage', () => {
    const tools = [
      makeTool('repo_commit', {
        requiredGatewayMethods: ['git.status'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus', 'gitCommit']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].missingGatewayMetadataCoverage).toEqual([
      'requiredGatewayMethods missing "git.commit"',
    ]);
  });

  it('skips gateway method checks in disabled parity mode', () => {
    const tools = [
      makeTool('repo_status', {
        requiredGatewayMethods: ['git.status'],
      }),
    ];
    // In parity mode, gateway methods are irrelevant
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(1);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('flags tools with missing service dependencies', () => {
    const tools = [
      makeTool('custom_tool', {
        requiredServices: ['memoryStore', 'embeddingService'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      availableServices: new Set(['memoryStore']),
    });
    expect(report.totalTools).toBe(1);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].missingServices).toEqual(['embeddingService']);
  });

  it('validates multiple missing dependencies on a single tool', () => {
    const tools = [
      makeTool('multi_dep_tool', {
        requiredGatewayMethods: ['git.status', 'git.nonexistent'],
        requiredServices: ['missing_service'],
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
      availableServices: new Set(),
    });
    expect(report.invalidTools).toHaveLength(1);
    const invalid = report.invalidTools[0];
    expect(invalid.missingGatewayMethods).toHaveLength(1);
    expect(invalid.missingGatewayMethods[0]).toContain('git.nonexistent');
    expect(invalid.missingServices).toEqual(['missing_service']);
  });

  it('handles empty tool list', () => {
    const report = validateToolWiring({
      mode: 'gateway',
      tools: [],
      gatewayClientMethods: new Set(),
    });
    expect(report.totalTools).toBe(0);
    expect(report.validTools).toBe(0);
    expect(report.invalidTools).toHaveLength(0);
  });

  it('handles mix of annotated and unannotated tools', () => {
    const tools = [
      makeTool('plain_tool'),
      makeTool('annotated_ok', { requiredGatewayMethods: ['git.status'] }),
      makeTool('annotated_bad', { requiredGatewayMethods: ['git.nonexistent'] }),
      makeTool('another_plain'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
    });
    expect(report.totalTools).toBe(4);
    expect(report.validTools).toBe(3);
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('annotated_bad');
  });

  it('fails closed when concurrency metadata is required and missing', () => {
    const tools = [
      makeTool('repo_status', { requiredGatewayMethods: ['git.status'] }),
      makeTool('memory_write'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      requireConcurrencyMetadata: true,
    });
    expect(report.invalidTools).toHaveLength(2);
    expect(report.invalidTools[0].missingConcurrencyMetadata).toContain('concurrency metadata missing');
    expect(report.invalidTools[1].missingConcurrencyMetadata).toContain('concurrency metadata missing');
  });

  it('accepts valid concurrency metadata when required', () => {
    const tools = [
      makeTool('repo_status', {
        requiredGatewayMethods: ['git.status'],
        concurrency: makeConcurrencyMeta('read_only', { maxParallel: 3 }),
      }),
      makeTool('memory_write', {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKey: 'core:memory_write',
          exclusivityKeyPolicy: 'static_key',
        }),
      }),
      makeTool('spawn_subagent', {
        concurrency: makeConcurrencyMeta('spawn_subagent', { maxParallel: 5 }),
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
      requireConcurrencyMetadata: true,
    });
    expect(report.invalidTools).toHaveLength(0);
  });

  it('rejects invalid exclusive concurrency metadata when required', () => {
    const tools = [
      makeTool('memory_delete', {
        concurrency: {
          ...makeConcurrencyMeta('exclusive', {
            exclusivityKey: undefined,
            exclusivityKeyPolicy: 'none',
          }),
          // explicit any-casts verify validator fail-closed behavior for invalid metadata
          interruptibility: 'invalid' as any,
        },
      }),
      makeTool('repo_diff', {
        concurrency: makeConcurrencyMeta('read_only', {
          maxParallel: 0,
          exclusivityKeyPolicy: 'static_key' as any,
          exclusivityKey: 'extended:repo_diff',
          eligibility: { foreground: false, background: false },
        }),
      }),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      requireConcurrencyMetadata: true,
    });
    expect(report.invalidTools).toHaveLength(2);
    expect(report.invalidTools[0].missingConcurrencyMetadata.join(' ')).toContain('exclusive tools require');
    expect(report.invalidTools[0].missingConcurrencyMetadata.join(' ')).toContain('interruptibility');
    expect(report.invalidTools[1].missingConcurrencyMetadata.join(' ')).toContain('maxParallel');
    expect(report.invalidTools[1].missingConcurrencyMetadata.join(' ')).toContain('eligibility');
  });
});

describe('validateAndLogToolWiring', () => {
  it('returns empty array when all tools are valid', () => {
    const tools = [
      makeTool('ok_tool'),
    ];
    const disabled = validateAndLogToolWiring({
      mode: 'gateway',
      tools,
    });
    expect(disabled).toEqual([]);
  });

  it('returns names of disabled tools', () => {
    const tools = [
      makeTool('good_tool'),
      makeTool('bad_tool', {
        requiredGatewayMethods: ['nonexistent.method'],
      }),
    ];
    const disabled = validateAndLogToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(),
    });
    expect(disabled).toEqual(['bad_tool']);
  });

  it('disables tools with missing gateway metadata coverage', () => {
    const tools = [
      makeTool('repo_status'),
    ];
    const disabled = validateAndLogToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: new Set(['gitStatus']),
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(disabled).toEqual(['repo_status']);
  });
});

describe('production tools validation', () => {
  it('unified fs and repo tools pass validation in gateway mode with full client', () => {
    const tools = [
      makeTool('fs', {
        requiredGatewayMethods: ['fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.edit'],
      }),
      makeTool('repo', {
        requiredGatewayMethods: [
          'git.status',
          'git.diff',
          'git.apply_patch',
          'git.commit',
          'git.create_branch',
          'git.open_pr',
        ],
      }),
    ];

    const fullClientMethods = new Set([
      'fsRead',
      'fsList',
      'fsSearch',
      'fsWrite',
      'fsEdit',
      'gitStatus',
      'gitDiff',
      'gitApplyPatch',
      'gitCommit',
      'gitCreateBranch',
      'gitOpenPR',
    ]);

    const report = validateToolWiring({
      mode: 'gateway',
      tools,
      gatewayClientMethods: fullClientMethods,
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });

    expect(report.invalidTools).toHaveLength(0);
  });

  it('all git tools pass validation in parity mode', () => {
    // In parity mode, git tools use GitOps directly and do not depend on gateway transport
    const gitTools = [
      makeTool('repo_status'),
      makeTool('repo_diff'),
      makeTool('repo_apply_patch'),
      makeTool('repo_commit'),
      makeTool('repo_create_branch'),
      makeTool('repo_open_pr'),
    ];
    const report = validateToolWiring({
      mode: 'gateway',
      tools: gitTools,
    });
    expect(report.invalidTools).toHaveLength(0);
  });

  it('all git tools pass validation in gateway mode with full client', () => {
    // Simulate git tools annotated with gateway requirements
    const gitTools = [
      makeTool('repo_status', { requiredGatewayMethods: ['git.status'] }),
      makeTool('repo_diff', { requiredGatewayMethods: ['git.diff'] }),
      makeTool('repo_apply_patch', { requiredGatewayMethods: ['git.apply_patch'] }),
      makeTool('repo_commit', { requiredGatewayMethods: ['git.commit'] }),
      makeTool('repo_create_branch', { requiredGatewayMethods: ['git.create_branch'] }),
      makeTool('repo_open_pr', { requiredGatewayMethods: ['git.open_pr'] }),
    ];

    // A full GatewayClient has all these methods
    const fullClientMethods = new Set([
      'gitStatus',
      'gitDiff',
      'gitCreateBranch',
      'gitApplyPatch',
      'gitCommit',
      'gitOpenPR',
      'stream',
      'complete',
      'embed',
      'embedBatch',
      'discordSend',
      'discordTyping',
      'webFetch',
      'shellExec',
      'fsRead',
      'fsWrite',
      'fsList',
    ]);

    const report = validateToolWiring({
      mode: 'gateway',
      tools: gitTools,
      gatewayClientMethods: fullClientMethods,
      requiredGatewayMetadataCoverage: DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE,
    });
    expect(report.invalidTools).toHaveLength(0);
  });

  it('detects git tools that would fail against incomplete client', () => {
    const gitTools = [
      makeTool('repo_status', { requiredGatewayMethods: ['git.status'] }),
      makeTool('repo_diff', { requiredGatewayMethods: ['git.diff'] }),
      makeTool('repo_commit', { requiredGatewayMethods: ['git.commit'] }),
    ];

    // Client missing gitCommit method
    const incompleteClient = new Set([
      'gitStatus',
      'gitDiff',
    ]);

    const report = validateToolWiring({
      mode: 'gateway',
      tools: gitTools,
      gatewayClientMethods: incompleteClient,
    });
    expect(report.invalidTools).toHaveLength(1);
    expect(report.invalidTools[0].toolName).toBe('repo_commit');
  });
});

describe('extractGatewayMethods with GatewayClient shape', () => {
  it('extracts all expected methods from a GatewayClient-like object', () => {
    // This mirrors the real GatewayClient's public method surface
    class FakeGatewayClient {
      stream(): void { /* noop */ }
      complete(): void { /* noop */ }
      embed(): void { /* noop */ }
      embedBatch(): void { /* noop */ }
      discordSend(): void { /* noop */ }
      discordTyping(): void { /* noop */ }
      webFetch(): void { /* noop */ }
      shellExec(): void { /* noop */ }
      fsRead(): void { /* noop */ }
      fsWrite(): void { /* noop */ }
      fsList(): void { /* noop */ }
      fsSearch(): void { /* noop */ }
      fsEdit(): void { /* noop */ }
      gitStatus(): void { /* noop */ }
      gitDiff(): void { /* noop */ }
      gitCreateBranch(): void { /* noop */ }
      gitApplyPatch(): void { /* noop */ }
      gitCommit(): void { /* noop */ }
      gitOpenPR(): void { /* noop */ }
      notifyNtfy(): void { /* noop */ }
      beadsReady(): void { /* noop */ }
      beadsShow(): void { /* noop */ }
      beadsCreate(): void { /* noop */ }
      beadsUpdate(): void { /* noop */ }
      beadsClose(): void { /* noop */ }
      beadsSync(): void { /* noop */ }
      imageCreate(): void { /* noop */ }
      imageEdit(): void { /* noop */ }
    }

    const methods = extractGatewayMethods(new FakeGatewayClient());

    // Verify all git methods are found
    expect(methods.has('gitStatus')).toBe(true);
    expect(methods.has('gitDiff')).toBe(true);
    expect(methods.has('gitCreateBranch')).toBe(true);
    expect(methods.has('gitApplyPatch')).toBe(true);
    expect(methods.has('gitCommit')).toBe(true);
    expect(methods.has('gitOpenPR')).toBe(true);
    expect(methods.has('beadsReady')).toBe(true);
    expect(methods.has('beadsCreate')).toBe(true);
    expect(methods.has('imageCreate')).toBe(true);
    expect(methods.has('imageEdit')).toBe(true);

    // Verify LLM methods
    expect(methods.has('stream')).toBe(true);
    expect(methods.has('complete')).toBe(true);
    expect(methods.has('embed')).toBe(true);
    expect(methods.has('fsSearch')).toBe(true);
    expect(methods.has('fsEdit')).toBe(true);
  });
});
