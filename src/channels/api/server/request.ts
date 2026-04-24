import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  MessageModelOverride,
  MessagePromptOverride,
  ResponseStyle,
} from '../../../shared/contracts/runtime.js';
import { isChannelVisibility, type ChannelVisibility } from '../../../system/trust/types.js';
import { readJsonBodyWithLimit } from '../../backplane/http/primitives.js';
import type { ApiRuntimeChatRequest, ChatCompletionRequest } from '../types.js';
import { hasCallerProvidedPrimaryTrust } from '../request-validation.js';
import {
  clampHttpHeader as clampHeaderValue,
  singleHeader as firstHeaderValue,
} from '../http-policy.js';
import {
  canWriteResponse,
  MAX_BODY_SIZE,
  sendApiError,
  type ApiServerLogger,
} from './http.js';

const DIRECT_PROVIDER_OVERRIDE_ALLOWLIST = new Set(['anthropic', 'openai', 'google']);

export interface TurnRoutingOverrides {
  modelOverride?: MessageModelOverride;
  promptOverride?: MessagePromptOverride;
  responseStyle?: ResponseStyle;
}

export interface ChannelPrivacyResolution {
  ok: true;
  value?: ChannelVisibility;
}

export interface ChannelPrivacyError {
  ok: false;
  error: string;
}

export function singleApiHeader(value: string | string[] | undefined): string | undefined {
  return firstHeaderValue(value);
}

export function clampApiHeader(value: string | undefined, maxLength: number): string | undefined {
  return clampHeaderValue(value, maxLength);
}

export function extractRpcHeaders(req: IncomingMessage): ApiRuntimeChatRequest['headers'] {
  const headers: ApiRuntimeChatRequest['headers'] = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name] = singleApiHeader(value);
  }
  return headers;
}

export async function readChatCompletionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  logger: ApiServerLogger,
): Promise<ChatCompletionRequest | null> {
  const parsedBody = await readJsonBodyWithLimit<ChatCompletionRequest>(req, res, {
    maxBytes: MAX_BODY_SIZE,
    logger,
  });
  if (!parsedBody.ok) {
    if (parsedBody.errorCode === 'payload_too_large') return null;
    if (parsedBody.errorCode === 'read_error') {
      logger.error('Failed reading request body', {
        path: req.url ?? '/v1/chat/completions',
        error: parsedBody.error.message,
      });
      if (canWriteResponse(res)) {
        sendApiError(res, 500, 'internal_error', 'Internal server error');
      }
      return null;
    }

    logger.warn('Rejected request with invalid JSON body', {
      path: req.url ?? '/v1/chat/completions',
      bodySize: Buffer.byteLength(parsedBody.rawBody),
      contentType: req.headers['content-type'],
      remoteAddress: req.socket.remoteAddress,
      error: parsedBody.error.message,
    });
    sendApiError(res, 400, 'invalid_json', 'Request body is not valid JSON');
    return null;
  }

  const parsed = parsedBody.value;
  if (hasCallerProvidedPrimaryTrust(parsed)) {
    logger.warn('Rejected caller-provided primary trust field in API payload', {
      path: req.url ?? '/v1/chat/completions',
      remoteAddress: req.socket.remoteAddress,
    });
    sendApiError(
      res,
      400,
      'invalid_request',
      'Caller-provided primary trust level is not allowed',
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation of untrusted JSON
  if (!parsed.messages || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    sendApiError(res, 400, 'invalid_request', 'messages field is required and must be a non-empty array');
    return null;
  }

  return parsed;
}

export function resolveChannelPrivacy(req: IncomingMessage): ChannelPrivacyResolution | ChannelPrivacyError {
  const rawValue = clampApiHeader(
    singleApiHeader(req.headers['x-channel-privacy']),
    64,
  );
  if (!rawValue) {
    return { ok: true };
  }
  if (!isChannelVisibility(rawValue)) {
    return {
      ok: false,
      error: 'X-Channel-Privacy must be one of: private, semi_private, public, broadcast',
    };
  }
  return { ok: true, value: rawValue };
}

export function parseTurnRoutingOverrides(
  request: ChatCompletionRequest,
): { ok: true; value: TurnRoutingOverrides } | { ok: false; error: string } {
  const provider = typeof request.provider === 'string'
    ? request.provider.trim().toLowerCase()
    : '';
  const model = typeof request.model === 'string'
    ? request.model.trim()
    : '';

  let modelOverride: MessageModelOverride | undefined;
  if (provider) {
    if (!model) {
      return {
        ok: false,
        error: 'provider override requires a non-empty model field',
      };
    }
    if (!DIRECT_PROVIDER_OVERRIDE_ALLOWLIST.has(provider)) {
      return {
        ok: false,
        error: `provider override must be one of ${Array.from(DIRECT_PROVIDER_OVERRIDE_ALLOWLIST).join(', ')}`,
      };
    }

    const maxTokens = typeof request.max_tokens === 'number' && Number.isFinite(request.max_tokens)
      ? Math.max(1, Math.trunc(request.max_tokens))
      : undefined;

    modelOverride = {
      provider,
      model,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  }

  const modeRaw = typeof request.system_prompt_mode === 'string'
    ? request.system_prompt_mode.trim().toLowerCase()
    : '';
  const systemPrompt = typeof request.system_prompt === 'string'
    ? request.system_prompt.trim()
    : '';

  let promptOverride: MessagePromptOverride | undefined;
  if (!modeRaw && modelOverride) {
    promptOverride = { mode: 'none' };
  } else if (modeRaw) {
    if (modeRaw !== 'default' && modeRaw !== 'none' && modeRaw !== 'custom') {
      return {
        ok: false,
        error: 'system_prompt_mode must be one of: default, none, custom',
      };
    }
    if (modeRaw === 'custom') {
      if (!systemPrompt) {
        return { ok: false, error: 'system_prompt is required when system_prompt_mode=custom' };
      }
      promptOverride = { mode: 'custom', systemPrompt };
    } else if (modeRaw === 'none') {
      promptOverride = { mode: 'none' };
    }
  }

  const responseStyleRaw = typeof request.response_style === 'string'
    ? request.response_style.trim().toLowerCase()
    : '';
  let responseStyle: ResponseStyle | undefined;
  if (responseStyleRaw) {
    if (responseStyleRaw !== 'concise' && responseStyleRaw !== 'expressive') {
      return {
        ok: false,
        error: 'response_style must be one of: concise, expressive',
      };
    }
    responseStyle = responseStyleRaw;
  }

  return {
    ok: true,
    value: {
      ...(modelOverride ? { modelOverride } : {}),
      ...(promptOverride ? { promptOverride } : {}),
      ...(responseStyle ? { responseStyle } : {}),
    },
  };
}
