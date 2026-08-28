import { isAbsolute, relative, resolve } from 'node:path';
import type { RuntimePathSnapshot } from '../../persistence/layout.js';
import type { SubstrateConfig } from './runtime-config-contracts.js';

/**
 * Bind identity-bearing observer runtime fields to the selected companion's
 * immutable fleet tuple. Shared settings may tune the observer, but in a
 * multi-companion process they can never choose which sidecar/session/agent
 * or storage root owns the state.
 */
export function bindCompanionObserverEvalSidecar(
  config: Pick<
    SubstrateConfig,
    'multiCompanion' | 'companionId' | 'companionRuntimeIdentity' | 'observerEvalSidecar'
  >,
): void {
  const sidecar = config.observerEvalSidecar;
  if (config.multiCompanion !== true || sidecar?.enabled !== true) return;

  const identity = config.companionRuntimeIdentity;
  const companionId = config.companionId;
  if (!identity?.observerEvalSidecar) {
    throw new Error(
      `Enabled observerEvalSidecar for companion ${JSON.stringify(companionId ?? 'unknown')} requires an exact `
      + 'companionRuntimeIdentity.observerEvalSidecar binding; refusing shared or primary fallback',
    );
  }
  if (!companionId || identity.companionId !== companionId) {
    throw new Error(
      `Enabled observerEvalSidecar for companion ${JSON.stringify(companionId ?? 'unknown')} `
      + `received binding owner ${JSON.stringify(identity.companionId)}; identity does not match config.companionId`,
    );
  }

  const binding = identity.observerEvalSidecar;
  config.observerEvalSidecar = {
    ...sidecar,
    sidecarId: binding.sidecarId,
    adapter: {
      ...sidecar.adapter,
      kind: 'emosim_server',
      serverUrl: binding.serverUrl,
      sessionLabel: binding.sessionLabel,
      agentName: binding.agentName,
    },
    persistence: {
      ...sidecar.persistence,
      rootDir: binding.persistenceRootDir,
    },
  };
}

function isSameOrNestedPath(candidate: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (
    relativePath.length > 0
    && !relativePath.startsWith('..')
    && !isAbsolute(relativePath)
  );
}

function assertDoesNotOverlapRuntimeRoot(input: {
  fieldPath: string;
  path: string;
  rootLabel: string;
  rootPath: string;
}): void {
  if (
    isSameOrNestedPath(input.path, input.rootPath)
    || isSameOrNestedPath(input.rootPath, input.path)
  ) {
    throw new Error(
      `${input.fieldPath} (${input.path}) must not overlap runtime root `
      + `"${input.rootLabel}" (${input.rootPath})`,
    );
  }
}

export function validateObserverEvalSidecarStartupConfig(
  config: Pick<SubstrateConfig, 'observerEvalSidecar' | 'emosimProactivity'>,
  pathSnapshot: RuntimePathSnapshot,
): void {
  const sidecar = config.observerEvalSidecar;
  const proactivity = config.emosimProactivity;
  if (proactivity?.mode !== undefined && proactivity.mode !== 'off' && !sidecar?.enabled) {
    throw new Error(
      'emosimProactivity.mode requires the EmoSim source runtime to be enabled when not off',
    );
  }
  if (!sidecar?.enabled) {
    return;
  }

  const mode = String(sidecar.mode);
  if (mode !== 'observe_only') {
    throw new Error(
      'observerEvalSidecar.mode must be observe_only; observer sidecars are not allowed to steer runtime behavior',
    );
  }

  const adapterKind = String(sidecar.adapter.kind);
  if (adapterKind === 'disabled') {
    throw new Error(
      'observerEvalSidecar.adapter.kind must not be disabled when observerEvalSidecar.enabled=true',
    );
  }

  if (adapterKind === 'emosim_server') {
    const serverUrl = sidecar.adapter.serverUrl?.trim();
    if (!serverUrl) {
      throw new Error(
        'observerEvalSidecar.adapter.serverUrl is required when enabled sidecar uses adapter.kind=emosim_server',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw new Error(
        `observerEvalSidecar.adapter.serverUrl (${serverUrl}) must be an absolute http(s) URL`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `observerEvalSidecar.adapter.serverUrl (${serverUrl}) must use http or https`,
      );
    }
    if (!sidecar.adapter.sessionLabel?.trim()) {
      throw new Error(
        'observerEvalSidecar.adapter.sessionLabel is required when enabled sidecar uses adapter.kind=emosim_server',
      );
    }
    if (!sidecar.adapter.agentName?.trim()) {
      throw new Error(
        'observerEvalSidecar.adapter.agentName is required when enabled sidecar uses adapter.kind=emosim_server',
      );
    }
  }

  if (sidecar.levers?.enabled && !sidecar.persistence.enabled) {
    throw new Error(
      'observerEvalSidecar.levers.enabled requires observerEvalSidecar.persistence.enabled=true; '
      + 'lever events are persistence-only, non-authoritative telemetry',
    );
  }
  const persistenceRootDir = sidecar.persistence.rootDir?.trim();
  if (sidecar.persistence.enabled && !persistenceRootDir) {
    throw new Error(
      'observerEvalSidecar.persistence.rootDir is required when observerEvalSidecar.persistence.enabled=true',
    );
  }
  if (!persistenceRootDir) {
    return;
  }

  const runtimeRoots = {
    systemDataDir: pathSnapshot.systemDataDir,
    companionDataDir: pathSnapshot.companionDataDir,
    workspacePath: pathSnapshot.workspacePath,
    logsDir: pathSnapshot.runtimePathLayout.logsDir,
    tempDir: pathSnapshot.runtimePathLayout.tempDir,
    backupsDir: pathSnapshot.runtimePathLayout.backupsDir,
  } satisfies Record<string, string>;

  for (const [rootLabel, rootPath] of Object.entries(runtimeRoots)) {
    assertDoesNotOverlapRuntimeRoot({
      fieldPath: 'observerEvalSidecar.persistence.rootDir',
      path: persistenceRootDir,
      rootLabel,
      rootPath,
    });
  }
}
