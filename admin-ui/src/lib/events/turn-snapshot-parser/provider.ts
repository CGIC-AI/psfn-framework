import type {
  AdminPromptSectionScopeProvenance,
  AdminPromptSectionTelemetry,
  AdminTurnCapturedWirePayloadData,
  AdminTurnPromptCachingObservabilityData,
  AdminTurnPromptContextSnapshotData,
  AdminTurnPromptResponseSnapshotData,
  AdminTurnProviderObservabilityData,
  AdminTurnProviderSystemRoleData,
  AdminTurnProviderWireMessage,
} from '../../types';
import { parsePromptCacheability, parseContextMessage, parseProvenance } from './plan';
import {
  optionalBoolean,
  optionalNonNegativeInteger,
  optionalString,
  parseArray,
  parseJsonValue,
  parseStringArray,
  reject,
  requireBoolean,
  requireExactRecord,
  requireNonEmptyString,
  requireNonNegativeInteger,
  requireString,
} from './primitives';

function requireScopeClass(
  value: unknown,
  path: string,
): NonNullable<AdminPromptSectionScopeProvenance['scopeClass']> {
  switch (value) {
    case 'dm':
    case 'room':
    case 'global':
      return value;
    default:
      return reject(path, `contains unsupported value ${JSON.stringify(value)}`);
  }
}

function requireScopeVolatility(
  value: unknown,
  path: string,
): NonNullable<AdminPromptSectionScopeProvenance['volatility']> {
  switch (value) {
    case 'static':
    case 'session_stable':
    case 'append_only':
    case 'volatile':
      return value;
    default:
      return reject(path, `contains unsupported value ${JSON.stringify(value)}`);
  }
}

function parseScopeProvenance(
  value: unknown,
  path: string,
): AdminPromptSectionScopeProvenance {
  const source = requireExactRecord(value, path, [
    'producer',
    'scopeKey',
    'scopeClass',
    'volatility',
    'sourceHint',
  ]);
  const producer = optionalString(source, 'producer', path);
  const scopeKey = optionalString(source, 'scopeKey', path);
  const scopeClass = source.scopeClass === undefined
    ? undefined
    : requireScopeClass(source.scopeClass, `${path}.scopeClass`);
  const volatility = source.volatility === undefined
    ? undefined
    : requireScopeVolatility(source.volatility, `${path}.volatility`);
  const sourceHint = optionalString(source, 'sourceHint', path);
  return {
    ...(producer !== undefined ? { producer } : {}),
    ...(scopeKey !== undefined ? { scopeKey } : {}),
    ...(scopeClass !== undefined ? { scopeClass } : {}),
    ...(volatility !== undefined ? { volatility } : {}),
    ...(sourceHint !== undefined ? { sourceHint } : {}),
  };
}

function parsePromptSection(value: unknown, path: string): AdminPromptSectionTelemetry {
  const source = requireExactRecord(value, path, [
    'id',
    'title',
    'content',
    'charCount',
    'tokenCount',
    'provenance',
    'scopeProvenance',
  ]);
  const provenance = source.provenance === undefined
    ? undefined
    : parseProvenance(source.provenance, `${path}.provenance`);
  const scopeProvenance = source.scopeProvenance === undefined
    ? undefined
    : parseScopeProvenance(source.scopeProvenance, `${path}.scopeProvenance`);
  return {
    id: requireNonEmptyString(source.id, `${path}.id`),
    title: requireString(source.title, `${path}.title`),
    content: requireString(source.content, `${path}.content`),
    charCount: requireNonNegativeInteger(source.charCount, `${path}.charCount`),
    tokenCount: requireNonNegativeInteger(source.tokenCount, `${path}.tokenCount`),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(scopeProvenance !== undefined ? { scopeProvenance } : {}),
  };
}

function requireSystemTransport(
  value: unknown,
  path: string,
): AdminTurnProviderSystemRoleData['transport'] {
  switch (value) {
    case 'openai_system':
    case 'openai_developer':
    case 'anthropic_system':
    case 'google_system_instruction':
    case 'system_prompt':
      return value;
    default:
      return reject(path, `contains unsupported transport ${JSON.stringify(value)}`);
  }
}

function parseSystemRole(value: unknown, path: string): AdminTurnProviderSystemRoleData {
  const source = requireExactRecord(value, path, [
    'transport',
    'supportsSystemRole',
    'supportsDeveloperRole',
    'usesOutOfBandSystemPrompt',
  ]);
  return {
    transport: requireSystemTransport(source.transport, `${path}.transport`),
    supportsSystemRole: requireBoolean(source.supportsSystemRole, `${path}.supportsSystemRole`),
    supportsDeveloperRole: requireBoolean(
      source.supportsDeveloperRole,
      `${path}.supportsDeveloperRole`,
    ),
    usesOutOfBandSystemPrompt: requireBoolean(
      source.usesOutOfBandSystemPrompt,
      `${path}.usesOutOfBandSystemPrompt`,
    ),
  };
}

function parsePromptCaching(
  value: unknown,
  path: string,
): AdminTurnPromptCachingObservabilityData {
  const source = requireExactRecord(value, path, [
    'configured',
    'engaged',
    'strategy',
    'retention',
    'scope',
    'sessionId',
    'reason',
    'mechanism',
    'appliedBreakpoints',
    'boundaries',
    'usage',
    'prefixStability',
  ]);
  const strategy = optionalString(source, 'strategy', path);
  if (strategy !== undefined && strategy !== 'openai_responses') {
    reject(`${path}.strategy`, 'contains an unsupported value');
  }
  const retention = optionalString(source, 'retention', path);
  if (retention !== undefined && !['none', 'short', 'long'].includes(retention)) {
    reject(`${path}.retention`, 'contains an unsupported value');
  }
  const scope = optionalString(source, 'scope', path);
  if (scope !== undefined && !['channel', 'request'].includes(scope)) {
    reject(`${path}.scope`, 'contains an unsupported value');
  }
  const reason = optionalString(source, 'reason', path);
  if (
    reason !== undefined
    && !['disabled', 'missing_channel_id', 'missing_companion_id'].includes(reason)
  ) {
    reject(`${path}.reason`, 'contains an unsupported value');
  }
  const mechanism = optionalString(source, 'mechanism', path);
  if (
    mechanism !== undefined
    && ![
      'anthropic_cache_control',
      'openrouter_cache_control_passthrough',
      'openai_prompt_cache_key',
      'implicit_prefix',
    ].includes(mechanism)
  ) {
    reject(`${path}.mechanism`, 'contains an unsupported value');
  }
  const boundaries = source.boundaries === undefined
    ? undefined
    : requireExactRecord(source.boundaries, `${path}.boundaries`, [
      'staticPrefixChars',
      'sessionStablePrefixChars',
    ]);
  const usage = source.usage === undefined
    ? undefined
    : requireExactRecord(source.usage, `${path}.usage`, ['cacheReadTokens', 'cacheWriteTokens']);
  const prefix = source.prefixStability === undefined
    ? undefined
    : requireExactRecord(source.prefixStability, `${path}.prefixStability`, [
      'checked',
      'stable',
      'firstObservation',
      'scopeKey',
      'changedBlockIds',
    ]);
  const sessionId = optionalString(source, 'sessionId', path);
  const appliedBreakpoints = optionalNonNegativeInteger(source, 'appliedBreakpoints', path);
  const stable = prefix ? optionalBoolean(prefix, 'stable', `${path}.prefixStability`) : undefined;
  const firstObservation = prefix
    ? optionalBoolean(prefix, 'firstObservation', `${path}.prefixStability`)
    : undefined;
  const prefixScopeKey = prefix
    ? optionalString(prefix, 'scopeKey', `${path}.prefixStability`)
    : undefined;
  const changedBlockIds = prefix?.changedBlockIds === undefined
    ? undefined
    : parseStringArray(prefix.changedBlockIds, `${path}.prefixStability.changedBlockIds`);
  return {
    configured: requireBoolean(source.configured, `${path}.configured`),
    engaged: requireBoolean(source.engaged, `${path}.engaged`),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(retention !== undefined ? { retention } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(mechanism !== undefined ? { mechanism } : {}),
    ...(appliedBreakpoints !== undefined ? { appliedBreakpoints } : {}),
    ...(boundaries
      ? {
        boundaries: {
          staticPrefixChars: requireNonNegativeInteger(
            boundaries.staticPrefixChars,
            `${path}.boundaries.staticPrefixChars`,
          ),
          sessionStablePrefixChars: requireNonNegativeInteger(
            boundaries.sessionStablePrefixChars,
            `${path}.boundaries.sessionStablePrefixChars`,
          ),
        },
      }
      : {}),
    ...(usage
      ? {
        usage: {
          cacheReadTokens: requireNonNegativeInteger(
            usage.cacheReadTokens,
            `${path}.usage.cacheReadTokens`,
          ),
          cacheWriteTokens: requireNonNegativeInteger(
            usage.cacheWriteTokens,
            `${path}.usage.cacheWriteTokens`,
          ),
        },
      }
      : {}),
    ...(prefix
      ? {
        prefixStability: {
          checked: requireBoolean(prefix.checked, `${path}.prefixStability.checked`),
          ...(stable !== undefined ? { stable } : {}),
          ...(firstObservation !== undefined ? { firstObservation } : {}),
          ...(prefixScopeKey !== undefined ? { scopeKey: prefixScopeKey } : {}),
          ...(changedBlockIds !== undefined ? { changedBlockIds } : {}),
        },
      }
      : {}),
  };
}

function requireWireRole(
  value: unknown,
  path: string,
): AdminTurnProviderWireMessage['role'] {
  switch (value) {
    case 'system':
    case 'developer':
    case 'user':
    case 'assistant':
    case 'tool':
    case 'system_instruction':
      return value;
    default:
      return reject(path, `contains unsupported role ${JSON.stringify(value)}`);
  }
}

function requireWireSource(
  value: unknown,
  path: string,
): AdminTurnProviderWireMessage['source'] {
  switch (value) {
    case 'system_prompt':
    case 'message':
      return value;
    default:
      return reject(path, `contains unsupported source ${JSON.stringify(value)}`);
  }
}

function parseWireMessage(value: unknown, path: string): AdminTurnProviderWireMessage {
  const source = requireExactRecord(value, path, ['role', 'source', 'content']);
  return {
    role: requireWireRole(source.role, `${path}.role`),
    source: requireWireSource(source.source, `${path}.source`),
    content: requireString(source.content, `${path}.content`),
  };
}

function parseCapturedWire(value: unknown, path: string): AdminTurnCapturedWirePayloadData {
  const source = requireExactRecord(value, path, [
    'api',
    'model',
    'capturedAtMs',
    'byteLength',
    'toolCount',
    'body',
    'bodyRef',
  ]);
  if (source.body !== undefined && source.bodyRef !== undefined) {
    reject(path, 'cannot contain both body and bodyRef');
  }
  const bodyRef = optionalString(source, 'bodyRef', path);
  return {
    api: requireNonEmptyString(source.api, `${path}.api`),
    model: requireNonEmptyString(source.model, `${path}.model`),
    capturedAtMs: requireNonNegativeInteger(source.capturedAtMs, `${path}.capturedAtMs`),
    byteLength: requireNonNegativeInteger(source.byteLength, `${path}.byteLength`),
    toolCount: requireNonNegativeInteger(source.toolCount, `${path}.toolCount`),
    ...(source.body !== undefined
      ? { body: parseJsonValue(source.body, `${path}.body`, new WeakSet<object>()) }
      : {}),
    ...(bodyRef !== undefined ? { bodyRef } : {}),
  };
}

function parseProviderObservability(
  value: unknown,
  path: string,
): AdminTurnProviderObservabilityData {
  const source = requireExactRecord(value, path, [
    'routeKind',
    'requestedProvider',
    'requestedModel',
    'backendProvider',
    'backendModel',
    'backendApi',
    'backendBaseUrl',
    'systemRole',
    'promptCaching',
    'providerWireMessages',
    'capturedWirePayload',
  ]);
  const routeKind = requireString(source.routeKind, `${path}.routeKind`);
  if (!['registered_model', 'configured_endpoint', 'configured_litellm_proxy', 'request_base_url'].includes(routeKind)) {
    reject(`${path}.routeKind`, 'contains an unsupported value');
  }
  const backendBaseUrl = optionalString(source, 'backendBaseUrl', path);
  const promptCaching = source.promptCaching === undefined
    ? undefined
    : parsePromptCaching(source.promptCaching, `${path}.promptCaching`);
  const providerWireMessages = source.providerWireMessages === undefined
    ? undefined
    : parseArray(source.providerWireMessages, `${path}.providerWireMessages`, parseWireMessage);
  const capturedWirePayload = source.capturedWirePayload === undefined
    ? undefined
    : parseCapturedWire(source.capturedWirePayload, `${path}.capturedWirePayload`);
  return {
    routeKind,
    requestedProvider: requireNonEmptyString(source.requestedProvider, `${path}.requestedProvider`),
    requestedModel: requireNonEmptyString(source.requestedModel, `${path}.requestedModel`),
    backendProvider: requireNonEmptyString(source.backendProvider, `${path}.backendProvider`),
    backendModel: requireNonEmptyString(source.backendModel, `${path}.backendModel`),
    backendApi: requireNonEmptyString(source.backendApi, `${path}.backendApi`),
    ...(backendBaseUrl !== undefined ? { backendBaseUrl } : {}),
    systemRole: parseSystemRole(source.systemRole, `${path}.systemRole`),
    ...(promptCaching !== undefined ? { promptCaching } : {}),
    ...(providerWireMessages !== undefined ? { providerWireMessages } : {}),
    ...(capturedWirePayload !== undefined ? { capturedWirePayload } : {}),
  };
}

function parsePromptResponse(
  value: unknown,
  path: string,
): AdminTurnPromptResponseSnapshotData {
  const source = requireExactRecord(value, path, [
    'content',
    'reasoning',
    'model',
    'stopReason',
    'errorMessage',
    'toolCallCount',
  ]);
  const reasoning = optionalString(source, 'reasoning', path);
  const model = optionalString(source, 'model', path);
  const stopReason = optionalString(source, 'stopReason', path);
  const errorMessage = optionalString(source, 'errorMessage', path);
  const toolCallCount = optionalNonNegativeInteger(source, 'toolCallCount', path);
  return {
    content: requireString(source.content, `${path}.content`),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
  };
}

export function parsePromptContext(
  value: unknown,
  path: string,
): AdminTurnPromptContextSnapshotData {
  const source = requireExactRecord(value, path, [
    'renderedStaticPrefix',
    'renderedDynamicSuffix',
    'runtimeContext',
    'memoryContextBlock',
    'scratchpadContext',
    'assembledPrompt',
    'finalSystemPrompt',
    'messages',
    'currentTurnInput',
    'providerObservability',
    'response',
    'inputSections',
    'runtimeContextSections',
    'memoryContextSections',
    'finalSystemSections',
    'sectionCacheability',
  ]);
  const renderedStaticPrefix = optionalString(source, 'renderedStaticPrefix', path);
  const renderedDynamicSuffix = optionalString(source, 'renderedDynamicSuffix', path);
  const runtimeContext = optionalString(source, 'runtimeContext', path);
  const memoryContextBlock = optionalString(source, 'memoryContextBlock', path);
  const scratchpadContext = optionalString(source, 'scratchpadContext', path);
  const assembledPrompt = optionalString(source, 'assembledPrompt', path);
  const finalSystemPrompt = optionalString(source, 'finalSystemPrompt', path);
  const currentTurnInput = optionalString(source, 'currentTurnInput', path);
  const messages = source.messages === undefined
    ? undefined
    : parseArray(source.messages, `${path}.messages`, parseContextMessage);
  const providerObservability = source.providerObservability === undefined
    ? undefined
    : parseProviderObservability(source.providerObservability, `${path}.providerObservability`);
  const response = source.response === undefined
    ? undefined
    : parsePromptResponse(source.response, `${path}.response`);
  const inputSections = source.inputSections === undefined
    ? undefined
    : parseArray(source.inputSections, `${path}.inputSections`, parsePromptSection);
  const runtimeContextSections = source.runtimeContextSections === undefined
    ? undefined
    : parseArray(source.runtimeContextSections, `${path}.runtimeContextSections`, parsePromptSection);
  const memoryContextSections = source.memoryContextSections === undefined
    ? undefined
    : parseArray(source.memoryContextSections, `${path}.memoryContextSections`, parsePromptSection);
  const finalSystemSections = source.finalSystemSections === undefined
    ? undefined
    : parseArray(source.finalSystemSections, `${path}.finalSystemSections`, parsePromptSection);
  const sectionCacheability = source.sectionCacheability === undefined
    ? undefined
    : parseArray(source.sectionCacheability, `${path}.sectionCacheability`, parsePromptCacheability);
  return {
    ...(renderedStaticPrefix !== undefined ? { renderedStaticPrefix } : {}),
    ...(renderedDynamicSuffix !== undefined ? { renderedDynamicSuffix } : {}),
    ...(runtimeContext !== undefined ? { runtimeContext } : {}),
    ...(memoryContextBlock !== undefined ? { memoryContextBlock } : {}),
    ...(scratchpadContext !== undefined ? { scratchpadContext } : {}),
    ...(assembledPrompt !== undefined ? { assembledPrompt } : {}),
    ...(finalSystemPrompt !== undefined ? { finalSystemPrompt } : {}),
    ...(messages !== undefined ? { messages } : {}),
    ...(currentTurnInput !== undefined ? { currentTurnInput } : {}),
    ...(providerObservability !== undefined ? { providerObservability } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(inputSections !== undefined ? { inputSections } : {}),
    ...(runtimeContextSections !== undefined ? { runtimeContextSections } : {}),
    ...(memoryContextSections !== undefined ? { memoryContextSections } : {}),
    ...(finalSystemSections !== undefined ? { finalSystemSections } : {}),
    ...(sectionCacheability !== undefined ? { sectionCacheability } : {}),
  };
}
