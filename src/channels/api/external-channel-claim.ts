import type { IncomingHttpHeaders } from 'node:http';
import {
  CHANNEL_TYPES,
  type ChannelType,
  type MessageRoutingMetadata,
} from '../../types.js';
import type { ApiAuthPrincipal } from '../http/auth.js';
import {
  clampHttpHeader as clampHeaderValue,
  singleHeader as firstHeaderValue,
} from './http-policy.js';

const EXTERNAL_API_CHANNEL_TYPE_ALLOWLIST = new Set<ChannelType>(['openhome']);

type MessageRoutingSource = NonNullable<MessageRoutingMetadata['source']>;

export interface ApiTurnIdentity {
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  source: MessageRoutingSource;
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
  if (channelType === 'openhome') return 'openhome';
  return 'api';
}

function defaultExternalAuthorId(channelType: ChannelType): string {
  return `${channelType}-user:owner`;
}

function defaultExternalAuthorName(channelType: ChannelType): string {
  if (channelType === 'openhome') return 'OpenHome User';
  return 'External Channel User';
}

export function resolveApiTurnIdentity(options: {
  headers: IncomingHttpHeaders;
  principal: ApiAuthPrincipal;
  defaultChannelId: string;
  defaultAuthorId: string;
  defaultAuthorName: string;
}): ApiTurnIdentityResolution {
  const {
    headers,
    principal,
    defaultChannelId,
    defaultAuthorId,
    defaultAuthorName,
  } = options;

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

  return {
    ok: true,
    value: {
      channelId: claimedChannelId,
      channelType: claimedChannelType,
      authorId: claimedAuthorId ?? defaultExternalAuthorId(claimedChannelType),
      authorName: claimedAuthorName ?? defaultExternalAuthorName(claimedChannelType),
      source: resolveExternalChannelSource(claimedChannelType),
    },
  };
}
