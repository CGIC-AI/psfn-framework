// ── Gateway RPC: image intake screening (htm9.8) ──
//
// `intake.screen_image` is the single chokepoint the agent process calls
// BEFORE any inbound image becomes a vision block in the main model context
// (src/core/agent/substrate-agent/vision-attachments.ts). The gateway is the
// secret holder: the vision screener's OpenRouter backend never leaves this
// process, and flagged transcripts stay gateway-side (only the decision,
// notice, and labeled benign transcript travel back).
//
// When the vision intake screener is not composed (firewall off, policy
// disabled, or shadow mode without a backend) the method answers 'skipped' —
// an explicit, auditable pass-through, never a silent one.

import { JSONRPCErrorException } from 'json-rpc-2.0';
import { GatewayErrors } from '../protocol.js';
import type { VisionIntakeImageScreenResult } from '../intake/vision-screener.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

/** Decoded-size cap for inline screening payloads (vision attachment parity). */
export const INTAKE_SCREEN_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export interface IntakeScreenImageParams {
  /** http(s) URL of the image (URL-addressed attachments). */
  imageUrl?: string;
  /** Inline base64 payload (no `data:` prefix). */
  imageBase64?: string;
  /** MIME type; required with imageBase64. */
  mimeType?: string;
  /** Origin locator, e.g. `discord:<channel>:<message>:attachment:<n>`. */
  originRef: string;
  originDetail?: string;
  /** Attachment index on the carrying message (envelope subject). */
  subjectIndex?: number;
  canonicalContactId?: string;
}

function invalidParams(detail: string): JSONRPCErrorException {
  return new JSONRPCErrorException(
    `intake.screen_image: ${detail}`,
    GatewayErrors.POLICY_DENIED,
  );
}

function validateParams(params: unknown): IntakeScreenImageParams {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalidParams('params must be an object');
  }
  const record = params as Record<string, unknown>;
  const originRef = typeof record.originRef === 'string' ? record.originRef.trim() : '';
  if (!originRef) {
    throw invalidParams('originRef is required');
  }
  const imageUrl = typeof record.imageUrl === 'string' ? record.imageUrl.trim() : '';
  const imageBase64 = typeof record.imageBase64 === 'string'
    ? record.imageBase64.replace(/\s+/gu, '')
    : '';
  if ((imageUrl.length > 0) === (imageBase64.length > 0)) {
    throw invalidParams('exactly one of imageUrl or imageBase64 is required');
  }
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim() : '';
  if (imageBase64) {
    if (!mimeType || !mimeType.toLowerCase().startsWith('image/')) {
      throw invalidParams('imageBase64 requires an image/* mimeType');
    }
    // Base64 length bound (decoded ≈ 3/4 of encoded length).
    if ((imageBase64.length * 3) / 4 > INTAKE_SCREEN_IMAGE_MAX_BYTES) {
      throw invalidParams(
        `inline image exceeds the ${String(INTAKE_SCREEN_IMAGE_MAX_BYTES)}-byte screening cap`,
      );
    }
  }
  return {
    ...(imageUrl ? { imageUrl } : {}),
    ...(imageBase64 ? { imageBase64 } : {}),
    ...(mimeType ? { mimeType } : {}),
    originRef,
    ...(typeof record.originDetail === 'string' && record.originDetail.trim()
      ? { originDetail: record.originDetail.trim() }
      : {}),
    ...(typeof record.subjectIndex === 'number' && Number.isInteger(record.subjectIndex)
      && record.subjectIndex >= 0
      ? { subjectIndex: record.subjectIndex }
      : {}),
    ...(typeof record.canonicalContactId === 'string' && record.canonicalContactId.trim()
      ? { canonicalContactId: record.canonicalContactId.trim() }
      : {}),
  };
}

const INTAKE_IMAGE_METHODS: ReadonlyArray<
  AuditedMethodDescriptor<unknown, VisionIntakeImageScreenResult>
> = [
  {
    name: 'intake.screen_image',
    handler: async (rawParams: unknown, runtime: GatewayMethodRuntime) => {
      const params = validateParams(rawParams);
      if (!runtime.visionIntake) {
        return {
          kind: 'skipped',
          flagged: false,
          withheld: false,
          reason: 'vision intake screening is not composed on this gateway',
        };
      }
      return await runtime.visionIntake.screenImage({
        image: {
          ...(params.imageUrl ? { url: params.imageUrl } : {}),
          ...(params.imageBase64 ? { dataBase64: params.imageBase64 } : {}),
          ...(params.mimeType ? { mimeType: params.mimeType } : {}),
        },
        originRef: params.originRef,
        ...(params.originDetail !== undefined ? { originDetail: params.originDetail } : {}),
        ...(params.subjectIndex !== undefined ? { subjectIndex: params.subjectIndex } : {}),
        ...(params.canonicalContactId !== undefined
          ? { canonicalContactId: params.canonicalContactId }
          : {}),
      });
    },
    summary: (rawParams: unknown) => {
      const record = (typeof rawParams === 'object' && rawParams !== null)
        ? rawParams as Record<string, unknown>
        : {};
      return {
        originRef: typeof record.originRef === 'string' ? record.originRef.slice(0, 512) : '(missing)',
        hasUrl: typeof record.imageUrl === 'string' && record.imageUrl.trim().length > 0,
        inlineChars: typeof record.imageBase64 === 'string' ? record.imageBase64.length : 0,
      };
    },
  },
];

export function registerIntakeImageMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, INTAKE_IMAGE_METHODS);
}
