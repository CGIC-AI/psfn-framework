import { isRfc4122Uuid } from '../../../../src/shared/utils/types.js';

const COMPANION_GARDEN_PREFIX = '/companions/';
const GARDEN_MARKER = '/garden';

export interface CompanionGardenScope {
  companionId: string;
  publicPrefix: string;
  innerPath: string;
}

export type CompanionScopeChangeListener = (
  previousCompanionId: string | null,
  nextCompanionId: string | null,
) => void | Promise<void>;

const scopeChangeListeners = new Set<CompanionScopeChangeListener>();
let activeCompanionId: string | null | undefined;

function requireRootAbsolutePath(path: string): void {
  const question = path.indexOf('?');
  const pathname = question < 0 ? path : path.slice(0, question);
  if (!path.startsWith('/')
    || path.startsWith('//')
    || path.includes('\\')
    || path.includes('#')
    || /%2f|%5c/iu.test(pathname)) {
    throw new Error('Garden path must be one canonical root-absolute path');
  }
  if (pathname.includes('//') || /(?:^|\/)\.\.?($|\/)/u.test(pathname)) {
    throw new Error('Garden path must be one canonical root-absolute path');
  }
}

export function parseCompanionGardenScope(pathname: string): CompanionGardenScope | null {
  if (!pathname.startsWith(COMPANION_GARDEN_PREFIX)) return null;
  if (pathname.includes('\\') || pathname.includes('//') || /%2f|%5c/iu.test(pathname)) {
    return null;
  }
  const remainder = pathname.slice(COMPANION_GARDEN_PREFIX.length);
  const separator = remainder.indexOf('/');
  if (separator < 0) return null;
  const companionId = remainder.slice(0, separator);
  const afterCompanion = remainder.slice(separator);
  if (!isRfc4122Uuid(companionId)
    || !afterCompanion.startsWith(GARDEN_MARKER)
    || (afterCompanion.length > GARDEN_MARKER.length
      && afterCompanion[GARDEN_MARKER.length] !== '/')) {
    return null;
  }
  const publicPrefix = `${COMPANION_GARDEN_PREFIX}${companionId}${GARDEN_MARKER}`;
  const innerPath = afterCompanion.slice(GARDEN_MARKER.length) || '/';
  return Object.freeze({ companionId, publicPrefix, innerPath });
}

export function companionGardenRoot(companionId: string): string {
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('Companion selection must be one lowercase RFC-4122 UUID');
  }
  return `${COMPANION_GARDEN_PREFIX}${companionId}${GARDEN_MARKER}`;
}

export function currentCompanionGardenScope(
  pathname = typeof window === 'undefined' ? '/' : window.location.pathname,
): CompanionGardenScope | null {
  return parseCompanionGardenScope(pathname);
}

export function scopeGardenPath(
  path: string,
  pathname = typeof window === 'undefined' ? '/' : window.location.pathname,
): string {
  requireRootAbsolutePath(path);
  const scope = parseCompanionGardenScope(pathname);
  return scope ? `${scope.publicPrefix}${path === '/' ? '' : path}` : path;
}

export function scopeGardenDataPath(
  path: string,
  pathname = typeof window === 'undefined' ? '/' : window.location.pathname,
): string {
  requireRootAbsolutePath(path);
  const scope = parseCompanionGardenScope(pathname);
  if (scope) return `${scope.publicPrefix}${path}`;
  if (pathname === '/fleet' || pathname === '/fleet/') {
    throw new Error('Companion data requires an authorized companion route');
  }
  return path;
}

export function getCompanionCacheScope(
  pathname = typeof window === 'undefined' ? '/' : window.location.pathname,
): string {
  return parseCompanionGardenScope(pathname)?.companionId ?? 'single-companion';
}

export function isFleetOverviewPath(pathname: string): boolean {
  return pathname === '/fleet' || pathname === '/fleet/';
}

export function onCompanionScopeChange(listener: CompanionScopeChangeListener): () => void {
  scopeChangeListeners.add(listener);
  return () => scopeChangeListeners.delete(listener);
}

export async function activateCompanionScope(
  nextCompanionId: string | null,
): Promise<void> {
  if (nextCompanionId !== null && !isRfc4122Uuid(nextCompanionId)) {
    throw new Error('Active companion scope must be one lowercase RFC-4122 UUID');
  }
  if (activeCompanionId === nextCompanionId) return;
  const previousCompanionId = activeCompanionId ?? null;
  const results = await Promise.allSettled(
    [...scopeChangeListeners].map(listener => Promise.resolve().then(() => (
      listener(previousCompanionId, nextCompanionId)
    ))),
  );
  const failures = results.flatMap(result => (
    result.status === 'rejected' ? [result.reason] : []
  ));
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Unable to clear the previous companion browser scope',
    );
  }
  activeCompanionId = nextCompanionId;
}

export function activateCompanionScopeFromPath(pathname: string): Promise<void> {
  return activateCompanionScope(parseCompanionGardenScope(pathname)?.companionId ?? null);
}
