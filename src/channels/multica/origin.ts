const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Normalize the control-plane origin and protect the owner bearer token. */
export function normalizeMulticaOrigin(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field} must be an absolute HTTP(S) URL`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${field} must not contain credentials, a path, query, or fragment`);
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${field} must use HTTPS unless the host is loopback`);
  }
  return parsed.origin;
}
