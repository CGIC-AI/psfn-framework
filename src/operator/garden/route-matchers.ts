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
