import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateCompanionScope,
  companionGardenRoot,
  GardenPathValidationError,
  getCompanionCacheScope,
  onCompanionScopeChange,
  parseCompanionGardenScope,
  scopeGardenDataPath,
  scopeGardenPath,
} from './companion-scope';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

afterEach(async () => {
  vi.restoreAllMocks();
  await activateCompanionScope(null);
});

describe('companion Garden browser scope', () => {
  it('parses only one canonical immutable companion route', () => {
    expect(parseCompanionGardenScope(
      `/companions/${COMPANION_A}/garden/settings`,
    )).toEqual({
      companionId: COMPANION_A,
      publicPrefix: `/companions/${COMPANION_A}/garden`,
      innerPath: '/settings',
    });
    expect(parseCompanionGardenScope(`/companions/${COMPANION_A}/garden`))
      .toMatchObject({ companionId: COMPANION_A, innerPath: '/' });

    for (const invalid of [
      '/companions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/garden'
        .toUpperCase(),
      `/companions/${COMPANION_A}/garden-party`,
      `/companions/${COMPANION_A}//garden`,
      `/companions/${COMPANION_A}/garden%2fsettings`,
      '/companions/not-a-companion/garden',
    ]) {
      expect(parseCompanionGardenScope(invalid)).toBeNull();
    }
  });

  it('scopes pages and all data URLs without adding browser authority fields', () => {
    const pathname = `/companions/${COMPANION_A}/garden/settings`;
    expect(scopeGardenPath('/sessions?limit=10', pathname))
      .toBe(`/companions/${COMPANION_A}/garden/sessions?limit=10`);
    expect(scopeGardenDataPath('/api/admin/settings', pathname))
      .toBe(`/companions/${COMPANION_A}/garden/api/admin/settings`);
    expect(scopeGardenDataPath('/health', pathname))
      .toBe(`/companions/${COMPANION_A}/garden/health`);
    expect(scopeGardenDataPath('/api/admin/model-usage?timezone=America%2FNew_York', pathname))
      .toBe(
        `/companions/${COMPANION_A}/garden/api/admin/model-usage`
          + '?timezone=America%2FNew_York',
      );
    expect(companionGardenRoot(COMPANION_B))
      .toBe(`/companions/${COMPANION_B}/garden`);
    expect(getCompanionCacheScope(pathname)).toBe(COMPANION_A);
  });

  it('keeps rejecting malformed data pathnames at the fleet scoping boundary', () => {
    const pathname = `/companions/${COMPANION_A}/garden/charge-budget`;
    for (const invalid of [
      '//api/admin/model-usage',
      '/api//admin/model-usage',
      '/api/admin/../model-usage',
      '/api/admin/%2e/model-usage',
      '/api/admin/%2E/model-usage',
      '/api/admin/%2e%2e/model-usage',
      '/api/admin/%2E%2e/model-usage',
      '/api/admin/.%2e/model-usage',
      '/api/admin/%2e./model-usage',
      '/api/admin/%2Fmodel-usage',
      '/api/admin/model-usage#fragment',
      String.raw`/api\admin\model-usage`,
    ]) {
      expect(() => scopeGardenDataPath(invalid, pathname))
        .toThrow(/one canonical root-absolute path/u);
    }
  });

  it('rejects encoded dot segments before browser canonicalization can escape scope', () => {
    const pathname = `/companions/${COMPANION_A}/garden/images`;
    const crossCompanionEscape = [
      '',
      '%2e%2e',
      '%2E%2e',
      '.%2e',
      'companions',
      COMPANION_B,
      'garden',
      'api',
      'admin',
      'settings',
    ].join('/');
    const unsafeScopedPath = `/companions/${COMPANION_A}/garden${crossCompanionEscape}`;

    expect(new URL(unsafeScopedPath, 'https://fleet.example').pathname)
      .toBe(`/companions/${COMPANION_B}/garden/api/admin/settings`);
    expect(() => scopeGardenDataPath(crossCompanionEscape, pathname))
      .toThrow(GardenPathValidationError);
  });

  it('retains direct single-companion paths but rejects data calls from /fleet', () => {
    expect(scopeGardenPath('/settings', '/settings')).toBe('/settings');
    expect(scopeGardenDataPath('/api/admin/settings', '/settings'))
      .toBe('/api/admin/settings');
    expect(() => scopeGardenDataPath('/api/admin/settings', '/fleet'))
      .toThrow(/authorized companion route/u);
  });

  it('notifies cleanup listeners exactly once for each switch', async () => {
    const listener = vi.fn();
    const unsubscribe = onCompanionScopeChange(listener);
    await activateCompanionScope(COMPANION_A);
    await activateCompanionScope(COMPANION_A);
    await activateCompanionScope(COMPANION_B);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(COMPANION_A, COMPANION_B);
    unsubscribe();
  });

  it('runs every cleanup and refuses to activate a scope when cleanup fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('cache clear failed');
    });
    const successful = vi.fn();
    const unsubscribeFailing = onCompanionScopeChange(failing);
    const unsubscribeSuccessful = onCompanionScopeChange(successful);

    await expect(activateCompanionScope(COMPANION_A))
      .rejects.toThrow(/Unable to clear the previous companion browser scope/u);
    expect(failing).toHaveBeenCalledWith(null, COMPANION_A);
    expect(successful).toHaveBeenCalledWith(null, COMPANION_A);

    unsubscribeFailing();
    unsubscribeSuccessful();
    const observer = vi.fn();
    const unsubscribeObserver = onCompanionScopeChange(observer);
    await activateCompanionScope(COMPANION_B);
    expect(observer).toHaveBeenCalledWith(null, COMPANION_B);
    unsubscribeObserver();
  });
});
