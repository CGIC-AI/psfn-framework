// ── External channel adapter owner-file contract (psfn-framework-pus8m) ──
//
// `channels.json.external` declares every out-of-process bridge the gateway
// admits. Each adapter is one supervised channel surface (`external:<id>`)
// bound to exactly one companion. Secrets never live here: each adapter names
// the env-owned bearer token it authenticates with. Every isolation bound is
// owner-file data and required — the runtime never invents a default.

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { envCredential } from '../../shared/contracts/credential-contracts.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import type { ChannelPluginParseResult } from '../plugins/types.js';

export const EXTERNAL_CHANNEL_PLUGIN_ID = 'external';

const positiveInteger = Type.Integer({ minimum: 1 });
const nonempty = Type.String({ minLength: 1 });

const limitsSchema = Type.Object({
  /** Largest accepted HTTP request body; larger bodies are refused unread. */
  maxRequestBytes: positiveInteger,
  /** A bridge that stalls while sending a request body is cut off after this. */
  requestReadTimeoutMs: positiveInteger,
  /** Longest accepted inbound message text. */
  maxTextChars: positiveInteger,
  /** Longest accepted message, conversation, or sender identifier. */
  maxIdChars: positiveInteger,
  /** Concurrent companion turns one adapter may hold; beyond it inbound is refused as busy. */
  maxInFlightTurns: positiveInteger,
  /** A companion turn that has not answered by then is abandoned for this adapter. */
  turnTimeoutMs: positiveInteger,
  /** Outbound messages awaiting a bridge pull; a full queue refuses new sends. */
  outboundQueueMax: positiveInteger,
  /** Most outbound messages returned by one pull. */
  outboundPullMax: positiveInteger,
  /** A bridge silent for longer than this is reported as a degraded surface. */
  heartbeatTimeoutMs: positiveInteger,
  /** Minimum spacing between repeated degraded-health reports of one kind. */
  failureReportIntervalMs: positiveInteger,
}, { additionalProperties: false });

export type ExternalChannelLimits = Static<typeof limitsSchema>;

const adapterSchema = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
  label: nonempty,
  companionId: nonempty,
  tokenRef: Type.Object({
    kind: Type.Literal('env'),
    envName: nonempty,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const sectionSchema = Type.Object({
  enabled: Type.Boolean(),
  limits: limitsSchema,
  adapters: Type.Array(adapterSchema),
}, { additionalProperties: false });

/** One adapter instance as the plugin host hands it to `create`. */
export interface ExternalChannelInstanceConfig {
  instanceId: string;
  label: string;
  companionId: CompanionId;
  limits: ExternalChannelLimits;
}

/** Credential id under which the host presents each adapter's bearer token. */
export const EXTERNAL_CHANNEL_TOKEN_CREDENTIAL_ID = 'token';

/**
 * Fail-closed parse of `channels.json.external`. The whole section is
 * validated even when disabled so an owner file never carries a latent error.
 */
export function parseExternalChannelSection(
  raw: unknown,
): ChannelPluginParseResult<ExternalChannelInstanceConfig | null> {
  if (!Value.Check(sectionSchema, raw)) {
    const first = Value.Errors(sectionSchema, raw).First();
    throw new Error(
      `Invalid channels.json.${EXTERNAL_CHANNEL_PLUGIN_ID}`
      + (first ? `: ${first.path || '/'} ${first.message}` : ''),
    );
  }
  if (raw.enabled && raw.adapters.length === 0) {
    throw new Error(`channels.json.${EXTERNAL_CHANNEL_PLUGIN_ID} is enabled but declares no adapters`);
  }
  const ids = new Set<string>();
  const envNames = new Set<string>();
  const instances = raw.adapters.map((adapter) => {
    if (ids.has(adapter.id)) {
      throw new Error(`channels.json.${EXTERNAL_CHANNEL_PLUGIN_ID} declares adapter "${adapter.id}" twice`);
    }
    ids.add(adapter.id);
    const reference = envCredential(adapter.tokenRef.envName);
    if (envNames.has(reference.envName)) {
      throw new Error(
        `channels.json.${EXTERNAL_CHANNEL_PLUGIN_ID} adapters must not share token env "${reference.envName}"`,
      );
    }
    envNames.add(reference.envName);
    const companionId = createCompanionId(
      adapter.companionId,
      `channels.json.${EXTERNAL_CHANNEL_PLUGIN_ID}.adapters.${adapter.id}.companionId`,
    );
    return {
      id: adapter.id,
      companionId,
      config: {
        instanceId: adapter.id,
        label: adapter.label.trim(),
        companionId,
        limits: { ...raw.limits },
      },
      credentials: [{
        id: EXTERNAL_CHANNEL_TOKEN_CREDENTIAL_ID,
        reference,
        description: `external channel adapter "${adapter.id}" bearer token`,
      }],
    };
  });
  return {
    // Adapters run only as per-instance surfaces; the section itself is never instantiated.
    config: null,
    enabled: raw.enabled,
    credentials: [],
    instances,
  };
}
