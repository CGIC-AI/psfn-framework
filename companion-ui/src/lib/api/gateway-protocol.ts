import {
  SATELLITE_CAPABILITIES as REGISTRY_CAPABILITIES,
  SATELLITE_TELEMETRY_SCOPES as REGISTRY_TELEMETRY_SCOPES,
} from '../../../../src/shared/contracts/satellite-registry.js';
import { isObjectRecord as isRecord } from '../../../../src/shared/utils/types.js';
import type {
  ApprovalResolvedStatus,
  SatelliteCapabilities,
  SatelliteInputCapability,
  SatelliteOutputCapability,
} from '../protocol/events.js';
import type { SatelliteHubSession } from './client.js';
import { COMPANION_APPROVALS_V2_CAPABILITY } from '../../../../src/shared/contracts/companion-relay.js';
import { parseHubToClientMessage } from '../protocol/framing.js';
import type { HubToClientMessage } from '../protocol/events.js';
import { hasExactKeys } from '../protocol/validation.js';

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SATELLITE_CAPABILITIES = new Set<string>(REGISTRY_CAPABILITIES);
const TELEMETRY_SCOPES = new Set<string>(REGISTRY_TELEMETRY_SCOPES);

export type CompanionUiResource =
  | 'conversation.interact'
  | 'conversation.interrupt'
  | 'conversation.touch'
  | 'confirmations.resolve'
  | 'artifact.preview';

export interface AttachmentReady {
  readonly device: Readonly<{ id: string; label: string }>;
  readonly place?: Readonly<{ id: string; label: string }>;
  readonly capabilities: readonly string[];
  readonly telemetryScopes: readonly string[];
  readonly eventCapabilities: readonly string[];
}

export interface GatewayResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
}

function boundedLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function parsePresentation(value: unknown): Readonly<{ id: string; label: string }> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'label'])
    || typeof value.id !== 'string' || !ID.test(value.id) || !boundedLabel(value.label)) return undefined;
  return Object.freeze({ id: value.id, label: value.label });
}

function closedStringArray(value: unknown, allowed: ReadonlySet<string>): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > allowed.size
    || value.some(entry => typeof entry !== 'string' || !allowed.has(entry))
    || new Set(value).size !== value.length) return undefined;
  return Object.freeze([...value] as string[]);
}

export function validCompanionRequestId(value: string): boolean {
  return REQUEST_ID.test(value);
}

export function parseAttachmentReady(value: unknown): AttachmentReady | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.type !== 'session.ready'
    || !hasExactKeys(
      value,
      ['schemaVersion', 'type', 'device', 'capabilities', 'telemetryScopes', 'eventCapabilities'],
      ['place'],
    )) {
    return undefined;
  }
  const device = parsePresentation(value.device);
  const place = value.place === undefined ? undefined : parsePresentation(value.place);
  const capabilities = closedStringArray(value.capabilities, SATELLITE_CAPABILITIES);
  const telemetryScopes = closedStringArray(value.telemetryScopes, TELEMETRY_SCOPES);
  const eventCapabilities = closedStringArray(
    value.eventCapabilities,
    new Set([COMPANION_APPROVALS_V2_CAPABILITY]),
  );
  if (!device || (value.place !== undefined && !place)
    || !capabilities || !telemetryScopes || !eventCapabilities) return undefined;
  return Object.freeze({
    device,
    ...(place ? { place } : {}),
    capabilities,
    telemetryScopes,
    eventCapabilities,
  });
}

export function parseGatewayEvent(value: unknown): HubToClientMessage | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'type', 'event'])
    || value.schemaVersion !== 1
    || value.type !== 'event') return undefined;
  try {
    const event = parseHubToClientMessage(JSON.stringify(value.event));
    if (event.type === 'approval.requested') {
      const data = event.data;
      if (data.sourceSystem === undefined || data.attribution === undefined
        || data.action === undefined || data.scope === undefined
        || data.reason === undefined || data.grantMode === undefined) return undefined;
    }
    return event;
  } catch {
    return undefined;
  }
}

export function parseGatewayResult(value: unknown): GatewayResult | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.type !== 'result' || typeof value.ok !== 'boolean') {
    return undefined;
  }
  if (value.ok) {
    if (!hasExactKeys(value, ['schemaVersion', 'type', 'requestId', 'ok', 'result'])
      || typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) return undefined;
    return { requestId: value.requestId, ok: true, result: value.result };
  }
  if (!hasExactKeys(value, ['schemaVersion', 'type', 'requestId', 'ok', 'error'])
    || value.requestId !== '' || !isRecord(value.error)
    || !hasExactKeys(value.error, ['code']) || value.error.code !== 'denied') return undefined;
  return { requestId: '', ok: false };
}

export function parseAgentResponse(value: unknown): { content: string } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['content', 'channelId', 'inputTokens', 'outputTokens'], ['noReply'])
    || typeof value.content !== 'string' || value.content.length > 65_536
    || typeof value.channelId !== 'string' || value.channelId.length === 0 || value.channelId.length > 256
    || !Number.isSafeInteger(value.inputTokens) || Number(value.inputTokens) < 0
    || !Number.isSafeInteger(value.outputTokens) || Number(value.outputTokens) < 0
    || (value.noReply !== undefined && !validNoReply(value.noReply))) return undefined;
  return { content: value.content };
}

function validNoReply(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(
      value,
      ['schemaVersion', 'disposition', 'source', 'auditId', 'decidedAt', 'turnId'],
      ['requestId', 'channelId', 'toolCallId', 'reason'],
    )
    || value.schemaVersion !== 1 || value.disposition !== 'intentional_no_reply'
    || value.source !== 'response_control_tool' || typeof value.auditId !== 'string'
    || value.auditId.length === 0 || value.auditId.length > 256
    || !Number.isSafeInteger(value.decidedAt) || Number(value.decidedAt) < 0
    || typeof value.turnId !== 'string' || value.turnId.length === 0 || value.turnId.length > 256) return false;
  return ['requestId', 'channelId', 'toolCallId', 'reason'].every((key) => {
    const entry = value[key];
    return entry === undefined || (typeof entry === 'string' && entry.length > 0 && entry.length <= 2048);
  });
}

export function parseInterruptResult(
  value: unknown,
  expectedInteractionId: string | null,
): { interrupted: boolean; interactionId: string } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['interrupted', 'interactionId'])
    || typeof value.interrupted !== 'boolean' || typeof value.interactionId !== 'string'
    || value.interactionId !== expectedInteractionId) return undefined;
  return { interrupted: value.interrupted, interactionId: value.interactionId };
}

export function parseConfirmationResolution(value: unknown): { id: string; status: ApprovalResolvedStatus } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'status', 'message', 'executed'])
    || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.message !== 'string'
    || typeof value.executed !== 'boolean') return undefined;
  const status: ApprovalResolvedStatus | undefined = value.status === 'approved' ? 'approved'
    : value.status === 'denied' ? 'denied'
      : value.status === 'expired' ? 'expired'
        : value.status === 'failed' || value.status === 'not_found' || value.status === 'modified'
          ? 'blocked'
          : undefined;
  return status ? { id: value.id, status } : undefined;
}

export function parseArtifactPreview(
  value: unknown,
  expectedArtifactId: string | undefined,
): { artifactId: string; mediaType: string; dataBase64: string } | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['artifactId', 'mediaType', 'sizeBytes', 'dataBase64'])
    || value.artifactId !== expectedArtifactId || typeof value.artifactId !== 'string'
    || typeof value.mediaType !== 'string' || value.mediaType.length === 0 || value.mediaType.length > 256
    || !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0
    || typeof value.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.dataBase64)) {
    return undefined;
  }
  return { artifactId: value.artifactId, mediaType: value.mediaType, dataBase64: value.dataBase64 };
}

export function mapCapabilities(
  physical: readonly string[],
  telemetry: readonly string[],
): SatelliteCapabilities {
  const input: SatelliteInputCapability[] = [
    ...(physical.includes('text') ? ['text' as const] : []),
    ...(physical.includes('audio_input') ? ['microphone_pcm' as const] : []),
    ...(physical.includes('speech_to_text') ? ['final_transcript' as const] : []),
  ];
  const output: SatelliteOutputCapability[] = [
    'text',
    ...(physical.includes('audio_output') ? ['streamed_audio' as const] : []),
    ...(telemetry.includes('artifacts') ? ['artifact' as const] : []),
    ...(telemetry.includes('tool_activity') ? ['tool_activity' as const] : []),
  ];
  return {
    input,
    output,
    control: [
      ...(physical.includes('audio_output') ? ['interrupt' as const] : []),
      ...(telemetry.includes('approvals') ? ['approvals' as const] : []),
      ...(physical.includes('touch') ? ['touch' as const] : []),
    ],
    safety: ['confirmation_required', 'local_only'],
  };
}

export function cloneGatewaySession(session: SatelliteHubSession): SatelliteHubSession {
  return {
    ...session,
    ...(session.eventCapabilities
      ? { eventCapabilities: [...session.eventCapabilities] }
      : {}),
    ...(session.place ? { place: { ...session.place } } : {}),
    ...(session.capabilities ? {
      capabilities: {
        input: [...(session.capabilities.input ?? [])],
        output: [...(session.capabilities.output ?? [])],
        control: [...(session.capabilities.control ?? [])],
        safety: [...(session.capabilities.safety ?? [])],
      },
    } : {}),
  };
}

export async function decodeSocketText(raw: unknown): Promise<string | null> {
  const payload = isRecord(raw) && 'data' in raw ? raw.data : raw;
  if (typeof payload === 'string') return payload;
  if (payload instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(payload));
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder().decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  }
  if (typeof Blob !== 'undefined' && payload instanceof Blob) return await payload.text();
  return null;
}
