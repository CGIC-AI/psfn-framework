export type RouteParams = Record<string, string>;
export interface RouteMatcher {
  (path: string): RouteParams | null;
  /** Canonical catalogue pattern used by the fleet request-target boundary. */
  readonly capabilityPattern: string;
}

interface PrefixedParamPathOptions {
  exclude?: (path: string) => boolean;
}

export function exactPath(expected: string): RouteMatcher {
  return attachCapabilityPattern(
    (path) => (path === expected ? {} : null),
    expected,
  );
}

function decodeCanonicalSegment(raw: string): string | null {
  if (!raw || raw.includes('/') || raw.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    !decoded
    || decoded === '.'
    || decoded === '..'
    || decoded.includes('/')
    || decoded.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(decoded)
    || (
      encodeURIComponent(decoded) !== raw
      && encodeURIComponent(decoded).replaceAll('%3A', ':') !== raw
    )
  ) return null;
  return decoded;
}

function attachCapabilityPattern(
  matcher: (path: string) => RouteParams | null,
  capabilityPattern: string,
): RouteMatcher {
  return Object.assign(matcher, { capabilityPattern });
}

export function prefixedParamPath(
  prefix: string,
  paramName: string,
  options?: PrefixedParamPathOptions,
): RouteMatcher {
  return attachCapabilityPattern((path) => {
    if (!path.startsWith(prefix)) return null;
    if (options?.exclude?.(path)) return null;
    const raw = path.slice(prefix.length);
    const decoded = decodeCanonicalSegment(raw);
    return decoded === null ? null : { [paramName]: decoded };
  }, `${prefix}:${paramName}`);
}

export function wrappedParamPath(prefix: string, suffix: string, paramName: string): RouteMatcher {
  return attachCapabilityPattern((path) => {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
    const raw = path.slice(prefix.length, path.length - suffix.length);
    const decoded = decodeCanonicalSegment(raw);
    return decoded === null ? null : { [paramName]: decoded };
  }, `${prefix}:${paramName}${suffix}`);
}

export function paramWithSuffix(prefix: string, paramName: string, suffix: string): RouteMatcher {
  return wrappedParamPath(prefix, suffix, paramName);
}

/**
 * Matches `${prefix}${first}${separator}${second}` and returns both segments.
 * Used for nested resource paths such as
 * `/api/admin/sessions/<channelId>/turns/<turnId>`. Both segments are
 * URL-decoded; a missing or empty segment fails the match so the router can
 * fall through to a more general route.
 */
export function nestedParamPath(
  prefix: string,
  separator: string,
  firstParamName: string,
  secondParamName: string,
): RouteMatcher {
  return attachCapabilityPattern((path) => {
    if (!path.startsWith(prefix)) return null;
    const remainder = path.slice(prefix.length);
    const separatorIndex = remainder.indexOf(separator);
    if (separatorIndex <= 0) return null;
    const rawFirst = remainder.slice(0, separatorIndex);
    const rawSecond = remainder.slice(separatorIndex + separator.length);
    const first = decodeCanonicalSegment(rawFirst);
    const second = decodeCanonicalSegment(rawSecond);
    if (first === null || second === null) return null;
    return {
      [firstParamName]: first,
      [secondParamName]: second,
    };
  }, `${prefix}:${firstParamName}${separator}:${secondParamName}`);
}
