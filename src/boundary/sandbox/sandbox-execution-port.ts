import vm from 'node:vm';
import type {
  GatewayProcessExecutionBoundary,
  SandboxCodeExecutionBoundary,
  SandboxCodeExecutionRequest,
  SandboxExecutionPort,
} from './capabilities/contracts.js';

type SandboxExecutionPortSeed =
  Pick<SandboxExecutionPort, 'boundary' | 'shellExec'>
  & Partial<Pick<SandboxExecutionPort, 'codeExecutionBoundary' | 'executeCode'>>;

const DEFAULT_SHELL_UNAVAILABLE_REASON = 'shell_exec unavailable: requires sandbox broker boundary and audit path';

function createUnavailableShellBoundary(): GatewayProcessExecutionBoundary {
  return {
    kind: 'gateway_process',
    isolatedFromGatewaySecrets: false,
    reason: DEFAULT_SHELL_UNAVAILABLE_REASON,
  };
}

function deriveCodeExecutionBoundary(
  port: SandboxExecutionPortSeed | null,
): SandboxCodeExecutionBoundary {
  if (port?.codeExecutionBoundary) {
    return port.codeExecutionBoundary;
  }

  const isolatedFromGatewaySecrets = port?.boundary.isolatedFromGatewaySecrets === true;
  return {
    kind: 'node_vm',
    isolatedFromGatewaySecrets,
    reason: isolatedFromGatewaySecrets
      ? 'in-process node:vm execution inside isolated agent runtime'
      : 'in-process node:vm execution without isolated sandbox boundary',
  };
}

async function executeCodeWithNodeVm(request: SandboxCodeExecutionRequest): Promise<void> {
  request.assertMemoryCeiling?.();

  const script = new vm.Script(request.code, { filename: 'repl' });
  const execution = Promise.resolve(script.runInContext(request.context, { timeout: request.timeoutMs }));

  let timeoutHandle: NodeJS.Timeout | undefined;
  let memoryGuardHandle: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Execution timed out after ${request.timeoutMs}ms`));
    }, request.timeoutMs);
  });

  const memoryGuard = new Promise<never>((_resolve, reject) => {
    if (!request.memoryCeilingBytes || request.memoryCeilingBytes <= 0) {
      return;
    }
    memoryGuardHandle = setInterval(() => {
      try {
        request.assertMemoryCeiling?.();
      } catch (error) {
        if (memoryGuardHandle) {
          clearInterval(memoryGuardHandle);
          memoryGuardHandle = undefined;
        }
        reject(error);
      }
    }, 20);
  });

  try {
    await Promise.race([execution, timeout, memoryGuard]);
    request.assertMemoryCeiling?.();
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (memoryGuardHandle) {
      clearInterval(memoryGuardHandle);
    }
  }
}

async function unavailableShellExec(): Promise<never> {
  throw new Error(DEFAULT_SHELL_UNAVAILABLE_REASON);
}

export function withNodeVmSandboxExecutionPort(
  port: SandboxExecutionPortSeed | null,
): SandboxExecutionPort {
  if (port?.executeCode && port.codeExecutionBoundary) {
    return {
      boundary: port.boundary,
      codeExecutionBoundary: port.codeExecutionBoundary,
      shellExec: port.shellExec,
      executeCode: port.executeCode,
    };
  }

  return {
    boundary: port?.boundary ?? createUnavailableShellBoundary(),
    codeExecutionBoundary: deriveCodeExecutionBoundary(port),
    shellExec: port?.shellExec ?? unavailableShellExec,
    executeCode: port?.executeCode ?? executeCodeWithNodeVm,
  };
}
