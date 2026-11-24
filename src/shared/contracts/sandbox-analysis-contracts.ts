import { PARENT_TURN_MAX_WALL_TIME_MS } from '../../core/agent/turn-limits.js';

export interface ShellExecView {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface SandboxFileReadOptions {
  maxBytes?: number;
  offsetBytes?: number;
}

export interface SandboxFileReadPage {
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
  eof: boolean;
  truncated: boolean;
}

/**
 * Narrow governed file-page seam for Analysis Workbench. Production supplies
 * the gateway filesystem operation; the LLM provider carries no filesystem
 * authority.
 */
export type SandboxFileRead = (
  path: string,
  options?: SandboxFileReadOptions,
) => Promise<SandboxFileReadPage>;

export interface SandboxBrokerExecutionBoundary {
  kind: 'sandbox_broker';
  isolatedFromGatewaySecrets: true;
  brokerId?: string;
}

export interface GatewayProcessExecutionBoundary {
  kind: 'gateway_process';
  isolatedFromGatewaySecrets: false;
  reason: string;
}

export type SandboxExecutionBoundary =
  | SandboxBrokerExecutionBoundary
  | GatewayProcessExecutionBoundary;

export type SandboxDeniedCapability =
  | 'filesystem'
  | 'network'
  | 'process'
  | 'module_import'
  | 'global_escape'
  | 'child_process'
  | 'environment';

export interface ChildProcessCodeExecutionBoundary {
  kind: 'child_process';
  isolatedFromGatewaySecrets: true;
  securityPosture: 'out_of_process_default_deny';
  protocol: 'analysis-workbench-child-v1';
  deniedCapabilities: readonly SandboxDeniedCapability[];
  reason: string;
}

export type SandboxCodeExecutionBoundary = ChildProcessCodeExecutionBoundary;

export type SandboxHostHelper = (...args: any[]) => unknown | Promise<unknown>;

export interface SandboxCodeExecutionRequest {
  code: string;
  timeoutMs: number;
  memoryCeilingBytes?: number;
  initialLocals: Record<string, unknown>;
  helperNames: readonly string[];
  hostHelpers: Readonly<Record<string, SandboxHostHelper>>;
}

export interface SandboxCodeExecutionResponse {
  output: string[];
  error: string | null;
  finalAnswer: string | null;
  locals: Record<string, unknown>;
}

export interface SandboxExecutionPort {
  readonly boundary: SandboxExecutionBoundary;
  readonly codeExecutionBoundary: SandboxCodeExecutionBoundary;
  shellExec: (
    command: string,
    args?: string[],
    options?: { cwd?: string; timeoutMs?: number; maxOutputChars?: number },
  ) => Promise<ShellExecView>;
  executeCode: (
    request: SandboxCodeExecutionRequest,
  ) => Promise<SandboxCodeExecutionResponse>;
}

/**
 * Minimal execution-port seed a runtime can supply: the shell boundary plus
 * its audited shellExec entrypoint. Code execution defaults to the local
 * child-process sandbox unless the seed overrides it.
 */
export type SandboxExecutionPortSeed =
  Pick<SandboxExecutionPort, 'boundary' | 'shellExec'>
  & Partial<Pick<SandboxExecutionPort, 'codeExecutionBoundary' | 'executeCode'>>;

export interface NestedAnalysisOptions {
  maxIterations?: number;
  maxTokens?: number;
  maxWallTimeMs?: number;
}

export type NestedAnalysisRunner = (
  task: string,
  options?: NestedAnalysisOptions,
) => Promise<string>;

export interface AnalysisWorkbenchBudget {
  maxIterations: number;      // default 60
  maxTokens?: number;         // total input+output tokens, default 256_000
  maxWallTimeMs?: number;     // total elapsed before tier clamp, default 600_000 (10 min)
  maxSubQueries?: number;     // llm_query calls, default 60
  maxToolCalls?: number;      // sandbox tool calls (file/web helpers), default 50
}

export interface TierAnalysisWorkbenchBudget {
  maxIterations: number;
  maxWallTimeMs: number;
  maxSubQueries: number;
  maxToolCalls: number;
  memoryCeilingMb: number;
}

export interface AnalysisWorkbenchRateLimitConfig {
  maxInvocationsPerMinute: number;
  windowMs: number;
}

export interface AnalysisWorkbenchCostConfig {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  nurseryDailyCapUsd: number;
  autonomousDailyWarningUsd: number;
}

export interface REPLConfig {
  budget: AnalysisWorkbenchBudget;
  tierBudgets: Record<'nursery' | 'apprentice' | 'autonomous', TierAnalysisWorkbenchBudget>;
  rateLimit: AnalysisWorkbenchRateLimitConfig;
  cost: AnalysisWorkbenchCostConfig;
  /**
   * Total response-wait window for a Workbench invoked directly on a parent
   * turn. Every direct root, nested, and sandbox completion shares this window;
   * bounded workers retain the full tier wall budget. Expiry always releases
   * the local tool wait and forwards an abort signal. Embedded providers honor
   * that signal directly; split GatewayClient transport currently abandons its
   * local RPC wait but requires a separate cancellable-RPC contract to tear
   * down the gateway-side provider request.
   */
  directResponseTimeoutMs: number;
  outputTruncation: number;
  executionTimeoutMs: number;
}

export const DEFAULT_REPL_TIER_BUDGETS: REPLConfig['tierBudgets'] = {
  nursery: {
    maxIterations: 5,
    maxWallTimeMs: 30_000,
    maxSubQueries: 10,
    maxToolCalls: 25,
    memoryCeilingMb: 128,
  },
  apprentice: {
    maxIterations: 10,
    maxWallTimeMs: 60_000,
    maxSubQueries: 15,
    maxToolCalls: 40,
    memoryCeilingMb: 192,
  },
  autonomous: {
    maxIterations: 60,
    maxWallTimeMs: 600_000,
    maxSubQueries: 60,
    maxToolCalls: 50,
    memoryCeilingMb: 256,
  },
};

export function validateAnalysisWorkbenchDirectResponseTimeoutMs(value: number): number {
  const maximumMs = PARENT_TURN_MAX_WALL_TIME_MS - 60_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumMs) {
    throw new Error(
      'Analysis Workbench directResponseTimeoutMs must be a positive safe integer '
      + `no greater than ${maximumMs}ms so the parent turn retains 60000ms of response headroom`,
    );
  }
  return value;
}

export const DEFAULT_REPL_CONFIG: REPLConfig = {
  budget: {
    maxIterations: 60,
    maxTokens: 256_000,
    maxWallTimeMs: 600_000,
    maxSubQueries: 60,
    maxToolCalls: 50,
  },
  tierBudgets: DEFAULT_REPL_TIER_BUDGETS,
  rateLimit: {
    maxInvocationsPerMinute: 5,
    windowMs: 60_000,
  },
  cost: {
    inputUsdPerMillionTokens: 2.0,
    outputUsdPerMillionTokens: 8.0,
    nurseryDailyCapUsd: 0.5,
    autonomousDailyWarningUsd: 5.0,
  },
  directResponseTimeoutMs: validateAnalysisWorkbenchDirectResponseTimeoutMs(
    PARENT_TURN_MAX_WALL_TIME_MS - 60_000,
  ),
  outputTruncation: 8192,
  executionTimeoutMs: 5000,
};
