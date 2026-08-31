import { buildChatHeaders } from './probe.mjs';

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Prepare a chat dispatch without putting the selected bearer in the public
 * request summary that is persisted into shakedown artifacts.
 */
export function prepareCaseChatDispatch({
  defaultApiKey,
  defaultApiUserId,
  resolveDispatchAuth,
  sessionId,
  privacy = 'private',
  extraHeaders = {},
  resolveAttemptHeaders,
}) {
  const attemptedAuthorizationOverride = Object.keys(extraHeaders)
    .some((name) => name.toLowerCase() === 'authorization');
  if (attemptedAuthorizationOverride) {
    throw new Error('Case extra headers must not override Authorization');
  }

  let apiKey;
  let apiUserId;
  if (resolveDispatchAuth === undefined) {
    apiKey = requireNonEmpty(defaultApiKey, 'chat dispatch API key');
    apiUserId = requireNonEmpty(defaultApiUserId, 'chat dispatch API user id');
  } else {
    const override = typeof resolveDispatchAuth === 'function'
      ? resolveDispatchAuth()
      : null;
    if (
      !override
      || typeof override !== 'object'
      || Array.isArray(override)
      || typeof override.apiKey !== 'string'
      || override.apiKey.trim().length === 0
      || typeof override.apiUserId !== 'string'
      || override.apiUserId.trim().length === 0
    ) {
      throw new Error('Satellite dispatch auth resolver must return complete auth');
    }
    apiKey = override.apiKey.trim();
    apiUserId = override.apiUserId.trim();
  }

  const headers = buildChatHeaders({
    apiKey,
    sessionId,
    privacy,
    extra: extraHeaders,
  });
  const resolveHeaders = () => {
    if (resolveAttemptHeaders === undefined) return { ...headers };
    const attemptHeaders = typeof resolveAttemptHeaders === 'function'
      ? resolveAttemptHeaders()
      : null;
    if (!attemptHeaders || typeof attemptHeaders !== 'object' || Array.isArray(attemptHeaders)) {
      throw new Error('Hub-device attempt header resolver must return an object');
    }
    const entries = Object.entries(attemptHeaders);
    if (
      entries.length !== 1
      || entries[0][0].toLowerCase() !== 'x-psfn-hub-device-assertion'
      || typeof entries[0][1] !== 'string'
      || entries[0][1].trim().length === 0
    ) {
      throw new Error('Hub-device attempt header resolver must return exactly one canonical assertion');
    }
    return { ...headers, [entries[0][0]]: entries[0][1].trim() };
  };

  return {
    apiUserId,
    headers,
    resolveHeaders,
    requestSummary: {
      privacy,
      headers: { ...extraHeaders },
    },
  };
}
