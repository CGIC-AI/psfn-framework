// ── Runtime Mode + Lifecycle Restart Contract ──
// Canonicalizes runtime modes across entrypoints and resolves restart strategy.

export const RUNTIME_MODE = Object.freeze({
  SPLIT: 'split',
  GATEWAY_AGENT: 'gateway-agent',
} as const);

export type RuntimeMode = (typeof RUNTIME_MODE)[keyof typeof RUNTIME_MODE];
export type RuntimeEntrypoint = RuntimeMode;
export type RuntimeRestartStrategy = 'supervisor' | 'command' | 'reexec' | 'unsupported';
export type RuntimeRestartSource = 'explicit' | 'mode-default' | 'none';

export interface RuntimeRestartContract {
  strategy: RuntimeRestartStrategy;
  source: RuntimeRestartSource;
  command?: string;
  exitCode?: number;
}

export interface RuntimeModeContract {
  mode: RuntimeMode;
  restart: RuntimeRestartContract;
}

export interface RuntimeCommandInvocation {
  command: string;
  args: string[];
}

export interface ResolveRuntimeModeContractOptions {
  entrypoint: RuntimeEntrypoint;
  runtimeModeEnv?: string;
  restartCommandEnv?: string;
  restartExitCodeEnv?: string;
}

const RUNTIME_MODE_ALIASES: Readonly<Record<string, RuntimeMode>> = Object.freeze({
  split: RUNTIME_MODE.SPLIT,
  yolo: RUNTIME_MODE.SPLIT,
  gateway: RUNTIME_MODE.GATEWAY_AGENT,
  agent: RUNTIME_MODE.GATEWAY_AGENT,
  gateway_agent: RUNTIME_MODE.GATEWAY_AGENT,
  gatewayagent: RUNTIME_MODE.GATEWAY_AGENT,
  'gateway-agent': RUNTIME_MODE.GATEWAY_AGENT,
});

const ENTRYPOINT_ALLOWED_MODES: Readonly<Record<RuntimeEntrypoint, readonly RuntimeMode[]>> = Object.freeze({
  [RUNTIME_MODE.SPLIT]: Object.freeze([RUNTIME_MODE.SPLIT]),
  [RUNTIME_MODE.GATEWAY_AGENT]: Object.freeze([RUNTIME_MODE.GATEWAY_AGENT, RUNTIME_MODE.SPLIT]),
});

export const DEFAULT_REEXEC_RESTART_EXIT_CODE = 75;

const DEFAULT_RESTART_BY_MODE: Readonly<Record<RuntimeMode, RuntimeRestartContract>> = Object.freeze({
  [RUNTIME_MODE.SPLIT]: Object.freeze({
    strategy: 'reexec',
    source: 'mode-default',
    exitCode: DEFAULT_REEXEC_RESTART_EXIT_CODE,
  }),
  [RUNTIME_MODE.GATEWAY_AGENT]: Object.freeze({
    strategy: 'supervisor',
    source: 'none',
  }),
});

function normalizeToken(raw: string | undefined): string {
  return raw?.trim().toLowerCase() ?? '';
}

export function normalizeRuntimeMode(raw: string | undefined): RuntimeMode | null {
  const normalized = normalizeToken(raw);
  if (!normalized) return null;
  return RUNTIME_MODE_ALIASES[normalized] ?? null;
}

export function normalizeRestartCommand(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function normalizeRestartExitCode(raw: string | undefined): number | undefined {
  const normalized = raw?.trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid PSFN_LIFECYCLE_RESTART_EXIT_CODE "${raw}". Expected an integer from 0 to 255.`);
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error(`Invalid PSFN_LIFECYCLE_RESTART_EXIT_CODE "${raw}". Expected an integer from 0 to 255.`);
  }
  return parsed;
}

export function resolveRuntimeCommandInvocation(raw: string | undefined): RuntimeCommandInvocation | undefined {
  const normalized = normalizeRestartCommand(raw);
  if (!normalized) return undefined;

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error(`Invalid runtime command "${normalized}": unmatched quote`);
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return undefined;
  }

  const [command, ...args] = tokens;
  return {
    command,
    args,
  };
}

function resolveRuntimeModeForEntrypoint(
  entrypoint: RuntimeEntrypoint,
  runtimeModeEnv: string | undefined,
): RuntimeMode {
  if (!Object.prototype.hasOwnProperty.call(ENTRYPOINT_ALLOWED_MODES, entrypoint)) {
    throw new Error(
      `Unsupported runtime entrypoint "${entrypoint}". Use the split runtime or the gateway and agent entrypoints.`,
    );
  }
  const allowedModes = ENTRYPOINT_ALLOWED_MODES[entrypoint];

  const normalizedRequestedMode = normalizeToken(runtimeModeEnv);
  const requestedMode = normalizeRuntimeMode(runtimeModeEnv);
  if (normalizedRequestedMode && !requestedMode) {
    throw new Error(
      `Unsupported PSFN_RUNTIME_MODE "${runtimeModeEnv}". Expected one of: split, yolo, gateway, or gateway-agent.`,
    );
  }
  if (!requestedMode) return entrypoint;

  if (!allowedModes.includes(requestedMode)) {
    throw new Error(
      `Runtime mode "${requestedMode}" is not allowed for entrypoint "${entrypoint}".`,
    );
  }
  return requestedMode;
}

export function resolveRuntimeModeContract(
  options: ResolveRuntimeModeContractOptions,
): RuntimeModeContract {
  const mode = resolveRuntimeModeForEntrypoint(options.entrypoint, options.runtimeModeEnv);
  const explicitRestartCommand = normalizeRestartCommand(options.restartCommandEnv);
  if (explicitRestartCommand) {
    return {
      mode,
      restart: {
        strategy: 'command',
        source: 'explicit',
        command: explicitRestartCommand,
      },
    };
  }

  const defaultRestart = DEFAULT_RESTART_BY_MODE[mode];
  if (defaultRestart.strategy === 'reexec') {
    const restartExitCode = normalizeRestartExitCode(options.restartExitCodeEnv)
      ?? defaultRestart.exitCode
      ?? DEFAULT_REEXEC_RESTART_EXIT_CODE;
    return {
      mode,
      restart: {
        ...defaultRestart,
        exitCode: restartExitCode,
      },
    };
  }

  return {
    mode,
    restart: defaultRestart,
  };
}

export interface RuntimeStatusMetadata extends Record<string, unknown> {
  activeMode: RuntimeMode;
  restartStrategy: RuntimeRestartStrategy;
  restartCommandSource: RuntimeRestartSource;
  restartCommand?: string;
  restartExitCode?: number;
}

export function toRuntimeStatusMetadata(contract: RuntimeModeContract): RuntimeStatusMetadata {
  return {
    activeMode: contract.mode,
    restartStrategy: contract.restart.strategy,
    restartCommandSource: contract.restart.source,
    ...(contract.restart.command ? { restartCommand: contract.restart.command } : {}),
    ...(typeof contract.restart.exitCode === 'number' ? { restartExitCode: contract.restart.exitCode } : {}),
  };
}
