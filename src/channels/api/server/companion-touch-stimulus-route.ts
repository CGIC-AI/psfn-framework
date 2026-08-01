import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';
import type { CompanionTouchStimulusRequest } from '../../../shared/contracts/companion-relay.js';
import {
  COMPANION_TOUCH_REGIONS,
  COMPANION_TOUCH_STIMULUS_KINDS,
} from '../../../shared/contracts/companion-relay.js';
import {
  resolveSatelliteClaim,
  SATELLITE_CLAIM_HEADERS,
} from '../../backplane/satellite-registry.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { buildSatellitePresenceMetadata } from '../../../core/agent/presence-metadata.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';
import { sendApiError } from './http.js';
import type { CompanionStimulusPort } from './companion-stimuli.js';

const log = createComponentLogger('CompanionTouchStimulusRoute');
const TOUCH_STIMULUS_MAX_BODY_BYTES = 16 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export interface CompanionTouchStimulusRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  principal: ApiAuthPrincipal;
  registry?: SatelliteRegistryConfig;
  clientCert?: SatelliteClientCertIdentity;
  companionId: string;
  deps: { stimuli: CompanionStimulusPort };
}

const TOUCH_STIMULUS_FIELDS = new Set([
  'satelliteId',
  'endpointId',
  'claimType',
  'sessionId',
  'deviceId',
  'kind',
  'region',
  'count',
  'durationMs',
  'responseMode',
]);

function parseTouchStimulusBody(body: unknown): CompanionTouchStimulusRequest {
  if (!isRecord(body)) {
    throw new Error('Request body must be a JSON object');
  }
  const unknownFields = Object.keys(body).filter((field) => !TOUCH_STIMULUS_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`Unknown request fields: ${unknownFields.join(', ')}`);
  }
  const requiredString = (field: keyof CompanionTouchStimulusRequest): string => {
    const value = body[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${field} must be a non-empty string`);
    }
    return value.trim();
  };
  const satelliteId = requiredString('satelliteId');
  const endpointId = requiredString('endpointId');
  const claimType = requiredString('claimType');
  const sessionId = requiredString('sessionId');
  const deviceId = requiredString('deviceId');
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('deviceId must be 1-128 characters of letters, numbers, dot, underscore, dash, colon, or @');
  }
  const kind = body.kind;
  if (typeof kind !== 'string' || !(COMPANION_TOUCH_STIMULUS_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of: ${COMPANION_TOUCH_STIMULUS_KINDS.join(', ')}`);
  }
  const region = body.region;
  if (typeof region !== 'string' || !(COMPANION_TOUCH_REGIONS as readonly string[]).includes(region)) {
    throw new Error(`region must be one of: ${COMPANION_TOUCH_REGIONS.join(', ')}`);
  }
  const count = body.count;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 20) {
    throw new Error('count must be an integer from 1 through 20');
  }
  const durationMs = body.durationMs;
  if (!Number.isInteger(durationMs) || (durationMs as number) < 0 || (durationMs as number) > 60_000) {
    throw new Error('durationMs must be an integer from 0 through 60000');
  }
  const responseMode = body.responseMode;
  if (responseMode !== 'respond' && responseMode !== 'observe') {
    throw new Error('responseMode must be "respond" or "observe"');
  }
  return {
    satelliteId,
    endpointId,
    claimType,
    sessionId,
    deviceId,
    kind: kind as CompanionTouchStimulusRequest['kind'],
    region: region as CompanionTouchStimulusRequest['region'],
    count: count as number,
    durationMs: durationMs as number,
    responseMode,
  };
}

function describeTouchStimulus(stimulus: CompanionTouchStimulusRequest): string {
  if (stimulus.kind === 'headpat') {
    return stimulus.count === 1
      ? 'Your primary user gives you a gentle headpat.'
      : `Your primary user gives you ${stimulus.count} gentle headpats.`;
  }
  if (stimulus.kind === 'petting') {
    return `Your primary user gently pets your ${stimulus.region}.`;
  }
  if (stimulus.kind === 'hug') {
    return 'Your primary user gives you a gentle hug.';
  }
  return `Your primary user gives you a gentle kiss on the ${stimulus.region}.`;
}

/** Authenticated typed physical interaction; caller prose is never accepted. */
export async function handleCompanionTouchStimulus(
  ctx: CompanionTouchStimulusRequestContext,
): Promise<void> {
  const bodyResult = await readJsonBodyWithLimit(ctx.req, ctx.res, {
    maxBytes: TOUCH_STIMULUS_MAX_BODY_BYTES,
    logger: log,
    logMeta: { route: 'companion.touch.stimulus' },
  });
  if (!bodyResult.ok) {
    if (bodyResult.errorCode === 'payload_too_large') return;
    sendApiError(ctx.res, 400, 'invalid_request', 'Request body must be valid JSON');
    return;
  }

  let stimulus: CompanionTouchStimulusRequest;
  try {
    stimulus = parseTouchStimulusBody(bodyResult.value);
  } catch (error) {
    sendApiError(ctx.res, 400, 'invalid_request', toErrorMessage(error));
    return;
  }

  const claim = resolveSatelliteClaim({
    headers: {
      [SATELLITE_CLAIM_HEADERS.claimType]: stimulus.claimType,
      [SATELLITE_CLAIM_HEADERS.satelliteId]: stimulus.satelliteId,
      [SATELLITE_CLAIM_HEADERS.endpointId]: stimulus.endpointId,
      [SATELLITE_CLAIM_HEADERS.sessionId]: stimulus.sessionId,
      [SATELLITE_CLAIM_HEADERS.capabilities]: 'touch',
    },
    principal: ctx.principal,
    registry: ctx.registry,
    ...(ctx.clientCert ? { clientCert: ctx.clientCert } : {}),
  });
  if (!claim.ok) {
    sendApiError(ctx.res, claim.status, claim.type, claim.message);
    return;
  }

  const message: SubstrateMessage = {
    id: `companion-stimulus-${randomUUID()}`,
    channelId: claim.value.channelId,
    channelType: 'api',
    authorId: claim.value.authorId,
    authorName: claim.value.authorName,
    content: describeTouchStimulus(stimulus),
    isDirectMessage: true,
    routing: {
      source: 'satellite',
      responseMode: stimulus.responseMode,
      responseStyle: 'concise',
      channelPrivacy: claim.value.channelPrivacy,
      canonicalContactId: claim.value.canonicalContactId,
      stimulus: {
        schemaVersion: 1,
        kind: stimulus.kind,
        region: stimulus.region,
        count: stimulus.count,
        durationMs: stimulus.durationMs,
        deviceId: stimulus.deviceId,
      },
      presence: buildSatellitePresenceMetadata({
        satelliteId: claim.value.satellite.satelliteId,
        companionId: ctx.companionId,
        ...(claim.value.satellite.placeId ? { siteId: claim.value.satellite.placeId } : {}),
        channelId: claim.value.channelId,
        channelPrivacy: claim.value.channelPrivacy,
        label: claim.value.satellite.endpointDisplayName,
        isActive: true,
      }),
      satellite: claim.value.satellite,
    },
    timestamp: new Date(),
  };
  const result = await ctx.deps.stimuli.submit(message);
  if (result.status === 'cooldown') {
    ctx.res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1_000)));
    sendApiError(
      ctx.res,
      429,
      'companion_stimulus_cooldown',
      'Companion stimulus is cooling down',
      { retryAfterMs: result.retryAfterMs },
    );
    return;
  }
  sendJson(ctx.res, 200, {
    status: 'accepted',
    messageId: message.id,
    ...(result.response ? { response: result.response } : {}),
  });
}
