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
