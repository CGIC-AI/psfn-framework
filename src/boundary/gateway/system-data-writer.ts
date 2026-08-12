import type {
  ToolConformanceClassification,
  ToolConformanceProbeKind,
  ToolConformanceProbeResult,
  ToolConformanceRunResult,
  ToolConformanceTrigger,
} from '../../core/agent/tool-conformance/types.js';
import {
  TOOL_CONFORMANCE_SCHEMA_VERSION,
} from '../../core/agent/tool-conformance/types.js';
import { writeToolConformanceResult } from '../../core/agent/tool-conformance/store.js';
import {
  parseSatelliteRegistryConfig,
  saveSatelliteRegistryConfig,
} from '../../channels/backplane/satellite-registry.js';
import {
  executeSharedWorldWikiWrite,
  parseSharedWorldWikiWriteResult,
  parseSharedWorldWikiWriteRequest,
  type SharedWorldWikiWriteResult,
  type SharedWorldWikiWriteRequest,
} from './system-data-writer-wiki.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { ConfigStorePort } from '../../system/config/config-store.js';
import { parseRuntimeSettingsOwnerPayload } from '../../system/settings/schema.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';

export const SYSTEM_OWNER_WRITE_KEYS = [
  'settings',
  'models',
  'providers',
  'channels',
  'trust-policy',
  'intake-policy',
  'partner-affect-shadow',
  'automata-policy',
  'backup',
  'mcp',
] as const;

export type SystemOwnerWriteKey = typeof SYSTEM_OWNER_WRITE_KEYS[number];

export type SystemDataWriteRequest =
  | {
      kind: 'owner_file';
      ownerFile: SystemOwnerWriteKey;
      payload: unknown;
    }
  | {
      kind: 'tool_conformance';
      payload: ToolConformanceRunResult;
    }
  | {
      kind: 'satellites';
      payload: SatelliteRegistryConfig;
    }
  | SharedWorldWikiWriteRequest;

export type SystemDataWriteResult = { ok: true } | SharedWorldWikiWriteResult;

export interface GatewaySystemDataWriterPort {
  writeSystemData(request: SystemDataWriteRequest): Promise<SystemDataWriteResult>;
}

const TOOL_CONFORMANCE_TRIGGERS = new Set(['manual', 'post_rollout', 'scheduled']);
const TOOL_CONFORMANCE_PROBE_KINDS = new Set([
  'read_only',
  'schema_only',
  'rejection_check',
  'safe_read',
  'scoped_mutation',
  'schema_assert',
  'sandbox_helper',
]);
const TOOL_CONFORMANCE_CLASSIFICATIONS = new Set([
  'threw',
  'timeout',
  'malformed_output',
  'returned_error',
  'accepted_empty_args',
  'schema_invalid',
  'missing_required_fields',
  'cleanup_failed',
  'mutation_uncancellable',
  'gate_inconsistent',
  'helper_missing',
]);
const SYSTEM_DATA_WRITE_PROTOCOL_BOUNDS = Object.freeze({
  resultCount: 4_096,
  stringLength: 4_096,
});

function isBoundedProtocolString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SYSTEM_DATA_WRITE_PROTOCOL_BOUNDS.stringLength;
}

function isBoundedProtocolText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= SYSTEM_DATA_WRITE_PROTOCOL_BOUNDS.stringLength;
}

function isToolConformanceTrigger(value: unknown): value is ToolConformanceTrigger {
  return typeof value === 'string' && TOOL_CONFORMANCE_TRIGGERS.has(value);
}

function isToolConformanceProbeKind(value: unknown): value is ToolConformanceProbeKind {
  return typeof value === 'string' && TOOL_CONFORMANCE_PROBE_KINDS.has(value);
}

function isToolConformanceClassification(
  value: unknown,
): value is ToolConformanceClassification {
  return typeof value === 'string' && TOOL_CONFORMANCE_CLASSIFICATIONS.has(value);
}

function unsupportedSystemOwner(ownerFile: never): never {
  throw new Error(`system.data.write owner is not implemented: ${String(ownerFile)}`);
}

function parseToolConformanceResult(value: unknown): ToolConformanceRunResult {
  if (!isRecord(value)) {
    throw new Error('system.data.write tool-conformance payload must be an object');
  }
  assertNoUnknownKeys(
    value,
    ['schemaVersion', 'ranAt', 'trigger', 'results', 'mode'],
    'system.data.write tool-conformance payload',
  );
  if (value.schemaVersion !== TOOL_CONFORMANCE_SCHEMA_VERSION
    || typeof value.ranAt !== 'number'
    || !Number.isSafeInteger(value.ranAt)
    || value.ranAt < 0
    || !isToolConformanceTrigger(value.trigger)
    || !Array.isArray(value.results)
    || value.results.length > SYSTEM_DATA_WRITE_PROTOCOL_BOUNDS.resultCount
    || (value.mode !== undefined && value.mode !== 'extended')) {
    throw new Error('system.data.write tool-conformance payload is invalid');
  }

  const results: ToolConformanceProbeResult[] = [];
  for (const [index, entry] of value.results.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`system.data.write tool-conformance result ${index} must be an object`);
    }
    assertNoUnknownKeys(
      entry,
      [
        'toolName',
        'probeKind',
        'action',
        'ok',
        'durationMs',
        'skipped',
        'classification',
        'error',
      ],
      `system.data.write tool-conformance result ${index}`,
    );
    if (!isBoundedProtocolString(entry.toolName)
      || !isToolConformanceProbeKind(entry.probeKind)
      || typeof entry.ok !== 'boolean'
      || typeof entry.durationMs !== 'number'
      || !Number.isFinite(entry.durationMs)
      || entry.durationMs < 0
      || (entry.action !== undefined && !isBoundedProtocolString(entry.action))
      || (entry.skipped !== undefined && typeof entry.skipped !== 'boolean')
      || (entry.classification !== undefined
        && !isToolConformanceClassification(entry.classification))
      || (entry.error !== undefined && !isBoundedProtocolText(entry.error))) {
      throw new Error(`system.data.write tool-conformance result ${index} is invalid`);
    }
    results.push({
      toolName: entry.toolName,
      probeKind: entry.probeKind,
      ok: entry.ok,
      durationMs: entry.durationMs,
      ...(entry.action !== undefined ? { action: entry.action } : {}),
      ...(entry.skipped !== undefined ? { skipped: entry.skipped } : {}),
      ...(entry.classification !== undefined ? { classification: entry.classification } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    });
  }

  return {
    schemaVersion: TOOL_CONFORMANCE_SCHEMA_VERSION,
    ranAt: value.ranAt,
    trigger: value.trigger,
    results,
    ...(value.mode === 'extended' ? { mode: value.mode } : {}),
  };
}

export function parseSystemDataWriteRequest(value: unknown): SystemDataWriteRequest {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('system.data.write params must be an object with a supported kind');
  }
  if (value.kind === 'owner_file') {
    assertNoUnknownKeys(
      value,
      ['kind', 'ownerFile', 'payload'],
      'system.data.write owner-file params',
    );
    const ownerFile = typeof value.ownerFile === 'string'
      ? SYSTEM_OWNER_WRITE_KEYS.find(candidate => candidate === value.ownerFile)
      : undefined;
    if (!ownerFile) {
      throw new Error('system.data.write ownerFile must name a mutable system owner');
    }
    if (!isRecord(value.payload)) {
      throw new Error('system.data.write owner-file payload must be an object');
    }
    return {
      kind: 'owner_file',
      ownerFile,
      payload: value.payload,
    };
  }
  if (value.kind === 'tool_conformance') {
    assertNoUnknownKeys(
      value,
      ['kind', 'payload'],
      'system.data.write tool-conformance params',
    );
    return {
      kind: 'tool_conformance',
      payload: parseToolConformanceResult(value.payload),
    };
  }
  if (value.kind === 'satellites') {
    assertNoUnknownKeys(
      value,
      ['kind', 'payload'],
      'system.data.write satellites params',
    );
    return {
      kind: 'satellites',
      payload: parseSatelliteRegistryConfig(
        value.payload,
        'system.data.write satellites payload',
      ),
    };
  }
  if (value.kind === 'shared_world_wiki') {
    return parseSharedWorldWikiWriteRequest(value);
  }
  throw new Error('system.data.write kind is unsupported');
}

export function parseSystemDataWriteResult(
  request: SystemDataWriteRequest,
  value: unknown,
): SystemDataWriteResult {
  if (request.kind === 'shared_world_wiki') {
    return parseSharedWorldWikiWriteResult(request, value);
  }
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || value.ok !== true) {
    throw new Error('Gateway system-data writer returned an invalid response');
  }
  return { ok: true };
}

export class GatewaySystemDataWriter implements GatewaySystemDataWriterPort {
  constructor(private readonly deps: {
    configStore: Pick<
      ConfigStorePort,
      | 'saveRuntimeSettings'
      | 'saveModels'
      | 'saveProviders'
      | 'saveChannelsOwnerFile'
      | 'saveTrustPolicy'
      | 'saveIntakePolicy'
      | 'savePartnerAffectShadow'
      | 'saveAutomataPolicy'
      | 'saveBackup'
      | 'saveMcpServers'
    >;
    systemDataDir: string;
  }) {}

  async writeSystemData(input: SystemDataWriteRequest): Promise<SystemDataWriteResult> {
    const request = parseSystemDataWriteRequest(input);
    if (request.kind === 'tool_conformance') {
      writeToolConformanceResult(this.deps.systemDataDir, request.payload);
      return { ok: true };
    }
    if (request.kind === 'satellites') {
      saveSatelliteRegistryConfig(this.deps.systemDataDir, request.payload);
      return { ok: true };
    }
    if (request.kind === 'shared_world_wiki') {
      return executeSharedWorldWikiWrite(request, this.deps.systemDataDir);
    }

    const ownerFile = request.ownerFile;
    switch (ownerFile) {
      case 'settings':
        this.deps.configStore.saveRuntimeSettings(
          parseRuntimeSettingsOwnerPayload(request.payload),
        );
        break;
      case 'models':
        this.deps.configStore.saveModels(request.payload);
        break;
      case 'providers':
        this.deps.configStore.saveProviders(request.payload);
        break;
      case 'channels':
        this.deps.configStore.saveChannelsOwnerFile(request.payload);
        break;
      case 'trust-policy':
        this.deps.configStore.saveTrustPolicy(request.payload);
        break;
      case 'intake-policy':
        this.deps.configStore.saveIntakePolicy(request.payload);
        break;
      case 'partner-affect-shadow':
        this.deps.configStore.savePartnerAffectShadow(request.payload);
        break;
      case 'automata-policy':
        this.deps.configStore.saveAutomataPolicy(request.payload);
        break;
      case 'backup':
        this.deps.configStore.saveBackup(request.payload);
        break;
      case 'mcp':
        this.deps.configStore.saveMcpServers(request.payload);
        break;
      default:
        unsupportedSystemOwner(ownerFile);
    }
    return { ok: true };
  }
}
