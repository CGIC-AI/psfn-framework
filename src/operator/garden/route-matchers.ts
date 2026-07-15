export type RouteParams = Record<string, string>;
export type RouteMatcher = (path: string) => RouteParams | null;

interface PrefixedParamPathOptions {
  exclude?: (path: string) => boolean;
}

export function exactPath(expected: string): RouteMatcher {
  return (path) => (path === expected ? {} : null);
}

export function prefixedParamPath(
  prefix: string,
  paramName: string,
  options?: PrefixedParamPathOptions,
): RouteMatcher {
  return (path) => {
    if (!path.startsWith(prefix)) return null;
    if (options?.exclude?.(path)) return null;
    const raw = path.slice(prefix.length);
    if (!raw) return null;
    return { [paramName]: decodeURIComponent(raw) };
  };
}

export function wrappedParamPath(prefix: string, suffix: string, paramName: string): RouteMatcher {
  return (path) => {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
    const raw = path.slice(prefix.length, path.length - suffix.length);
    if (!raw) return null;
    return { [paramName]: decodeURIComponent(raw) };
  };
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
  return (path) => {
    if (!path.startsWith(prefix)) return null;
    const remainder = path.slice(prefix.length);
    const separatorIndex = remainder.indexOf(separator);
    if (separatorIndex <= 0) return null;
    const rawFirst = remainder.slice(0, separatorIndex);
    const rawSecond = remainder.slice(separatorIndex + separator.length);
    if (!rawFirst || !rawSecond) return null;
    return {
      [firstParamName]: decodeURIComponent(rawFirst),
      [secondParamName]: decodeURIComponent(rawSecond),
    };
  };
}
