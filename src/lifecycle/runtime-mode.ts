// ── Runtime Mode + Lifecycle Restart Contract ──
// Canonicalizes runtime modes across entrypoints and resolves restart strategy.

export const RUNTIME_MODE = Object.freeze({
  SPLIT: 'split',
  GATEWAY_AGENT: 'gateway-agent',
} as const);

export type RuntimeMode = (typeof RUNTIME_MODE)[keyof typeof RUNTIME_MODE];
export type RuntimeEntrypoint = RuntimeMode;
export type RuntimeRestartStrategy = 'supervisor' | 'command';
export type RuntimeRestartSource = 'explicit' | 'mode-default' | 'none';

export interface RuntimeRestartContract {
  strategy: RuntimeRestartStrategy;
  source: RuntimeRestartSource;
  command?: string;
}

export interface RuntimeModeContract {
  mode: RuntimeMode;
  restart: RuntimeRestartContract;
}

export interface ResolveRuntimeModeContractOptions {
  entrypoint: RuntimeEntrypoint;
  runtimeModeEnv?: string;
  restartCommandEnv?: string;
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

const DEFAULT_RESTART_COMMAND_BY_MODE: Readonly<Record<RuntimeMode, string | undefined>> = Object.freeze({
  [RUNTIME_MODE.SPLIT]: 'npm run split',
  [RUNTIME_MODE.GATEWAY_AGENT]: undefined,
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

function resolveRuntimeModeForEntrypoint(
  entrypoint: RuntimeEntrypoint,
  runtimeModeEnv: string | undefined,
): RuntimeMode {
  const normalizedRequestedMode = normalizeToken(runtimeModeEnv);
  const requestedMode = normalizeRuntimeMode(runtimeModeEnv);
  if (normalizedRequestedMode && !requestedMode) {
    throw new Error(
      `Unsupported PSFN_RUNTIME_MODE "${runtimeModeEnv}". Expected one of: split, yolo, gateway, gateway-agent.`,
    );
  }
  if (!requestedMode) return entrypoint;

  const allowedModes = ENTRYPOINT_ALLOWED_MODES[entrypoint];
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

  const modeDefaultRestartCommand = DEFAULT_RESTART_COMMAND_BY_MODE[mode];
  if (modeDefaultRestartCommand) {
    return {
      mode,
      restart: {
        strategy: 'command',
        source: 'mode-default',
        command: modeDefaultRestartCommand,
      },
    };
  }

  return {
    mode,
    restart: {
      strategy: 'supervisor',
      source: 'none',
    },
  };
}

export interface RuntimeStatusMetadata extends Record<string, unknown> {
  activeMode: RuntimeMode;
  restartStrategy: RuntimeRestartStrategy;
  restartCommandSource: RuntimeRestartSource;
  restartCommand?: string;
}

export function toRuntimeStatusMetadata(contract: RuntimeModeContract): RuntimeStatusMetadata {
  return {
    activeMode: contract.mode,
    restartStrategy: contract.restart.strategy,
    restartCommandSource: contract.restart.source,
    ...(contract.restart.command ? { restartCommand: contract.restart.command } : {}),
  };
}
