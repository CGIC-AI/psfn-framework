import type { IncomingHttpHeaders } from 'node:http';
import { CHANNEL_TYPES, type ChannelType, type MessageRoutingMetadata } from '../../shared/contracts/runtime.js';
import type {
  SatelliteRegistryConfig,
  SatelliteRoutingMetadata,
} from '../../shared/contracts/satellite-registry.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { ExternalChannelProfileConfig } from '../backplane/config.js';
import type { ApiAuthPrincipal } from '../backplane/http/auth.js';
import {
  hasSatelliteClaimHeaders,
  resolveSatelliteClaim,
} from '../backplane/satellite-registry.js';
import {
  clampHttpHeader as clampHeaderValue,
  singleHeader as firstHeaderValue,
} from './http-policy.js';

const EXTERNAL_API_CHANNEL_TYPE_ALLOWLIST = new Set<ChannelType>(['psfn-amica']);

type MessageRoutingSource = NonNullable<MessageRoutingMetadata['source']>;

export interface ApiTurnIdentity {
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  source: MessageRoutingSource;
  channelPrivacy?: ChannelPrivacy;
  canonicalContactId?: string;
  satellite?: SatelliteRoutingMetadata;
}

export type ApiTurnIdentityResolution = { ok: true; value: ApiTurnIdentity } | {
  ok: false;
  status: number;
  type: string;
  message: string;
};

export const EXTERNAL_CHANNEL_HEADERS = {
  channelId: 'x-psfn-channel-id',
  channelType: 'x-psfn-channel-type',
  authorId: 'x-psfn-author-id',
  authorName: 'x-psfn-author-name',
} as const;

function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

function readHeader(headers: IncomingHttpHeaders, name: string, maxLength: number): string | undefined {
  return clampHeaderValue(firstHeaderValue(headers[name]), maxLength);
}

function resolveExternalChannelSource(channelType: ChannelType): MessageRoutingSource {
  if (channelType === 'psfn-amica') return 'psfn-amica';
  return 'api';
}

export function resolveApiTurnIdentity(options: {
  headers: IncomingHttpHeaders;
  principal: ApiAuthPrincipal;
  defaultChannelId: string;
  defaultAuthorId: string;
  defaultAuthorName: string;
  externalChannelProfiles?: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  satelliteRegistry?: SatelliteRegistryConfig;
}): ApiTurnIdentityResolution {
  const {
    headers,
    principal,
    defaultChannelId,
    defaultAuthorId,
    defaultAuthorName,
    externalChannelProfiles,
    satelliteRegistry,
  } = options;

  if (hasSatelliteClaimHeaders(headers)) {
    const satelliteClaim = resolveSatelliteClaim({
      headers,
      principal,
      registry: satelliteRegistry,
    });
    if (!satelliteClaim.ok) {
      return satelliteClaim;
    }
    return {
      ok: true,
      value: {
        channelId: satelliteClaim.value.channelId,
        channelType: 'api',
        authorId: satelliteClaim.value.authorId,
        authorName: satelliteClaim.value.authorName,
        source: 'satellite',
        channelPrivacy: satelliteClaim.value.channelPrivacy,
        canonicalContactId: satelliteClaim.value.canonicalContactId,
        satellite: satelliteClaim.value.satellite,
      },
    };
  }

  const claimedChannelId = readHeader(headers, EXTERNAL_CHANNEL_HEADERS.channelId, 256);
  const claimedChannelTypeRaw = readHeader(headers, EXTERNAL_CHANNEL_HEADERS.channelType, 64);
  const claimedAuthorId = readHeader(headers, EXTERNAL_CHANNEL_HEADERS.authorId, 256);
  const claimedAuthorName = readHeader(headers, EXTERNAL_CHANNEL_HEADERS.authorName, 128);
  const hasExternalClaim = Boolean(
    claimedChannelId
    || claimedChannelTypeRaw
    || claimedAuthorId
    || claimedAuthorName,
  );

  if (!hasExternalClaim) {
    return {
      ok: true,
      value: {
        channelId: defaultChannelId,
        channelType: 'api',
        authorId: defaultAuthorId,
        authorName: defaultAuthorName,
        source: 'api',
      },
    };
  }

  if (principal.mode !== 'api_key') {
    return {
      ok: false,
      status: 403,
      type: 'external_channel_claim_requires_api_key',
      message: 'External channel claims require API key authentication',
    };
  }

  if (!claimedChannelId || !claimedChannelTypeRaw) {
    return {
      ok: false,
      status: 400,
      type: 'invalid_request',
      message: 'X-PSFN-Channel-ID and X-PSFN-Channel-Type must be provided together',
    };
  }

  const claimedChannelType = claimedChannelTypeRaw.trim().toLowerCase();
  if (!isChannelType(claimedChannelType)) {
    return {
      ok: false,
      status: 400,
      type: 'invalid_request',
      message: 'X-PSFN-Channel-Type must be a known PSFN channel type',
    };
  }

  if (!EXTERNAL_API_CHANNEL_TYPE_ALLOWLIST.has(claimedChannelType)) {
    return {
      ok: false,
      status: 400,
      type: 'invalid_request',
      message: `X-PSFN-Channel-Type must be one of: ${Array.from(EXTERNAL_API_CHANNEL_TYPE_ALLOWLIST).join(', ')}`,
    };
  }

  if (!claimedChannelId.startsWith(`${claimedChannelType}:`)) {
    return {
      ok: false,
      status: 400,
      type: 'invalid_request',
      message: `X-PSFN-Channel-ID must start with ${claimedChannelType}:`,
    };
  }

  const defaultProfile = externalChannelProfiles?.[claimedChannelType];
  const resolvedAuthorId = claimedAuthorId ?? defaultProfile?.authorId;
  const resolvedAuthorName = claimedAuthorName ?? defaultProfile?.authorName;
  if (claimedChannelType === 'psfn-amica' && (!resolvedAuthorId || !resolvedAuthorName)) {
    return {
      ok: false,
      status: 503,
      type: 'external_channel_not_configured',
      message: 'PSFN Amica claims require configured identity metadata or explicit author headers',
    };
  }

  return {
    ok: true,
    value: {
      channelId: claimedChannelId,
      channelType: claimedChannelType,
      authorId: resolvedAuthorId!,
      authorName: resolvedAuthorName!,
      source: resolveExternalChannelSource(claimedChannelType),
      ...(defaultProfile?.channelPrivacy ? { channelPrivacy: defaultProfile.channelPrivacy } : {}),
      ...(defaultProfile?.canonicalContactId ? { canonicalContactId: defaultProfile.canonicalContactId } : {}),
    },
  };
}
