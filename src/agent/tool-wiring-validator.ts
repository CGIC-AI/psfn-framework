// ── Tool Wiring Validator ──
// Startup-time contract check to prevent tools from being registered
// when their runtime dependencies are missing. Catches the class of bugs
// where a tool appears available but crashes at invocation because its
// backing service (e.g. gateway RPC method) is not wired.

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ToolWiringValidator');

/**
 * Metadata that a tool can optionally declare to describe its runtime
 * dependencies. Tools that operate purely on injected closures (most tools)
 * don't need this — only tools whose execute() delegates to a service object
 * whose methods might not exist (e.g. GatewayClient).
 */
export interface ToolWiringMeta {
  /**
   * Gateway RPC method names this tool requires (e.g. 'git.status', 'git.diff').
   * Validated in gateway mode by checking that the gateway client exposes
   * corresponding methods.
   */
  requiredGatewayMethods?: string[];

  /**
   * Arbitrary named service dependencies this tool requires.
   * Validated against a provided set of available service names.
   */
  requiredServices?: string[];
}

/** An AgentTool that optionally carries wiring metadata */
export type WirableTool = AgentTool<any> & {
  wiringMeta?: ToolWiringMeta;
};

/**
 * Expected requiredGatewayMethods coverage for known gateway-dependent tools.
 * If a tool appears in this map in gateway mode, it must declare matching
 * requiredGatewayMethods metadata or it is disabled.
 */
export type GatewayToolMetadataCoverage = Readonly<Record<string, readonly string[]>>;

export const DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE: GatewayToolMetadataCoverage = Object.freeze({
  repo_status: Object.freeze(['git.status']),
  repo_diff: Object.freeze(['git.diff']),
  repo_apply_patch: Object.freeze(['git.apply_patch']),
  repo_commit: Object.freeze(['git.commit']),
  repo_create_branch: Object.freeze(['git.create_branch']),
  repo_open_pr: Object.freeze(['git.open_pr']),
  issue_ready: Object.freeze(['beads.ready']),
  issue_show: Object.freeze(['beads.show']),
  issue_create: Object.freeze(['beads.create']),
  issue_update: Object.freeze(['beads.update']),
  issue_close: Object.freeze(['beads.close']),
  issue_sync: Object.freeze(['beads.sync']),
});

// ── Validation Types ──

export type RuntimeMode = 'single' | 'gateway';

export interface ToolValidationResult {
  toolName: string;
  valid: boolean;
  missingGatewayMethods: string[];
  missingServices: string[];
  missingGatewayMetadataCoverage: string[];
}

export interface ValidationReport {
  mode: RuntimeMode;
  totalTools: number;
  validTools: number;
  invalidTools: ToolValidationResult[];
}

// ── Gateway Method Probing ──

/**
 * Extracts the set of method names that a gateway client exposes.
 * Works by inspecting own property names that are functions, filtering
 * out private/lifecycle methods.
 */
export function extractGatewayMethods(client: object): Set<string> {
  const methods = new Set<string>();
  const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
  if (!proto) return methods;

  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    if (typeof (proto as Record<string, unknown>)[key] === 'function') {
      methods.add(key);
    }
  }
  return methods;
}

/**
 * Maps well-known gateway RPC method names to their corresponding
 * GatewayClient method names. The RPC protocol uses dot-notation
 * (e.g. 'git.status') while the client uses camelCase (e.g. 'gitStatus').
 */
const RPC_TO_CLIENT_METHOD: Record<string, string> = {
  'git.status': 'gitStatus',
  'git.diff': 'gitDiff',
  'git.create_branch': 'gitCreateBranch',
  'git.apply_patch': 'gitApplyPatch',
  'git.commit': 'gitCommit',
  'git.open_pr': 'gitOpenPR',
  'beads.ready': 'beadsReady',
  'beads.show': 'beadsShow',
  'beads.create': 'beadsCreate',
  'beads.update': 'beadsUpdate',
  'beads.close': 'beadsClose',
  'beads.sync': 'beadsSync',
  'llm.chat': 'stream',
  'llm.complete': 'complete',
  'llm.embed': 'embed',
  'discord.send': 'discordSend',
  'discord.typing': 'discordTyping',
  'web.fetch': 'webFetch',
  'shell.exec': 'shellExec',
  'fs.read': 'fsRead',
  'fs.write': 'fsWrite',
  'fs.list': 'fsList',
  'notify.ntfy': 'notifyNtfy',
  'session.hmac.sign': 'sessionHmacSign',
  'session.hmac.verify': 'sessionHmacVerify',
  'confirmation.list': 'listConfirmationQueue',
  'confirmation.resolve': 'resolveConfirmationQueue',
};

/**
 * Resolves an RPC method name to the corresponding GatewayClient method name.
 * Falls back to the RPC name itself if no mapping is found.
 */
export function resolveClientMethod(rpcMethod: string): string {
  return RPC_TO_CLIENT_METHOD[rpcMethod] ?? rpcMethod;
}

// ── Validation Logic ──

export interface ValidateToolsOptions {
  mode: RuntimeMode;
  tools: readonly AgentTool<any>[];
  /** Available gateway client methods (gateway mode only) */
  gatewayClientMethods?: Set<string>;
  /** Expected metadata coverage for known gateway-dependent tools */
  requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage;
  /** Available service names */
  availableServices?: Set<string>;
}

/**
 * Validates that all registered tools have their runtime dependencies satisfied.
 * Returns a report describing which tools are valid and which have missing deps.
 */
export function validateToolWiring(options: ValidateToolsOptions): ValidationReport {
  const {
    mode,
    tools,
    gatewayClientMethods,
    requiredGatewayMetadataCoverage,
    availableServices,
  } = options;
  const results: ToolValidationResult[] = [];

  for (const tool of tools) {
    const wirable = tool as WirableTool;
    const meta = wirable.wiringMeta;
    const missingGatewayMethods: string[] = [];
    const missingServices: string[] = [];
    const missingGatewayMetadataCoverage: string[] = [];

    // Check gateway method dependencies
    if (mode === 'gateway' && meta?.requiredGatewayMethods && gatewayClientMethods) {
      for (const rpcMethod of meta.requiredGatewayMethods) {
        const clientMethod = resolveClientMethod(rpcMethod);
        if (!gatewayClientMethods.has(clientMethod)) {
          missingGatewayMethods.push(`${rpcMethod} (client: ${clientMethod})`);
        }
      }
    }

    // Enforce metadata coverage for known gateway-dependent tools.
    if (mode === 'gateway') {
      const expectedCoverage = requiredGatewayMetadataCoverage?.[tool.name];
      if (expectedCoverage && expectedCoverage.length > 0) {
        if (!meta?.requiredGatewayMethods || meta.requiredGatewayMethods.length === 0) {
          missingGatewayMetadataCoverage.push(
            `requiredGatewayMethods metadata missing (expected: ${expectedCoverage.join(', ')})`,
          );
        } else {
          const declared = new Set(meta.requiredGatewayMethods);
          for (const expectedRpcMethod of expectedCoverage) {
            if (!declared.has(expectedRpcMethod)) {
              missingGatewayMetadataCoverage.push(
                `requiredGatewayMethods missing "${expectedRpcMethod}"`,
              );
            }
          }
        }
      }
    }

    // Check service dependencies
    if (meta?.requiredServices && availableServices) {
      for (const service of meta.requiredServices) {
        if (!availableServices.has(service)) {
          missingServices.push(service);
        }
      }
    }

    if (
      missingGatewayMethods.length > 0
      || missingServices.length > 0
      || missingGatewayMetadataCoverage.length > 0
    ) {
      results.push({
        toolName: tool.name,
        valid: false,
        missingGatewayMethods,
        missingServices,
        missingGatewayMetadataCoverage,
      });
    }
  }

  return {
    mode,
    totalTools: tools.length,
    validTools: tools.length - results.length,
    invalidTools: results,
  };
}

/**
 * Runs validation and logs results. Returns tool names that should be disabled.
 * Does NOT mutate the tool list — caller is responsible for removing invalid tools.
 */
export function validateAndLogToolWiring(options: ValidateToolsOptions): string[] {
  const report = validateToolWiring(options);

  if (report.invalidTools.length === 0) {
    log.info('Tool wiring validation passed', {
      mode: report.mode,
      toolCount: report.totalTools,
    });
    return [];
  }

  const disabledNames: string[] = [];
  for (const invalid of report.invalidTools) {
    const reasons: string[] = [];
    if (invalid.missingGatewayMethods.length > 0) {
      reasons.push(`missing gateway methods: ${invalid.missingGatewayMethods.join(', ')}`);
    }
    if (invalid.missingServices.length > 0) {
      reasons.push(`missing services: ${invalid.missingServices.join(', ')}`);
    }
    if (invalid.missingGatewayMetadataCoverage.length > 0) {
      reasons.push(
        `missing gateway metadata coverage: ${invalid.missingGatewayMetadataCoverage.join(', ')}`,
      );
    }
    log.warn(`Tool "${invalid.toolName}" disabled — ${reasons.join('; ')}`, {
      tool: invalid.toolName,
      missingGatewayMethods: invalid.missingGatewayMethods,
      missingServices: invalid.missingServices,
      missingGatewayMetadataCoverage: invalid.missingGatewayMetadataCoverage,
    });
    disabledNames.push(invalid.toolName);
  }

  log.warn('Tool wiring validation completed with disabled tools', {
    mode: report.mode,
    totalTools: report.totalTools,
    validTools: report.validTools,
    disabledCount: disabledNames.length,
    disabledTools: disabledNames,
  });

  return disabledNames;
}
