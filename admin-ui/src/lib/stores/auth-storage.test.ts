import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_TOKEN_STORAGE_KEY,
  clearLegacyPersistentAdminToken,
  clearLegacyScriptReadableAdminTokenCookie,
} from './auth-storage';

describe('admin auth storage cleanup', () => {
  it('removes the legacy localStorage token without writing a replacement', () => {
    const storage = {
      removeItem: vi.fn(),
    };

    clearLegacyPersistentAdminToken(storage);

    expect(storage.removeItem).toHaveBeenCalledWith(ADMIN_TOKEN_STORAGE_KEY);
    expect(Object.hasOwn(storage, 'setItem')).toBe(false);
  });

  it('ignores unavailable localStorage', () => {
    expect(() => clearLegacyPersistentAdminToken({
      removeItem: () => {
        throw new Error('blocked');
      },
    })).not.toThrow();
  });

  it('expires legacy script-readable cookies only during explicit cleanup', () => {
    const documentRef = { cookie: '' };

    clearLegacyScriptReadableAdminTokenCookie(documentRef);

    expect(documentRef.cookie).toContain(`${ADMIN_TOKEN_STORAGE_KEY}=;`);
    expect(documentRef.cookie).toContain('expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });
});

describe('ADMIN_TOKEN operator door marker', () => {
  it('recognizes only the exact gateway marker', async () => {
    const { usesAdminTokenOperatorDoor } = await import('./auth-storage');
    expect(usesAdminTokenOperatorDoor({ cookie: 'a=1; garden_operator_door=admin_token' })).toBe(true);
    expect(usesAdminTokenOperatorDoor({ cookie: 'garden_operator_door=sso' })).toBe(false);
    expect(usesAdminTokenOperatorDoor({ cookie: 'xgarden_operator_door=admin_token' })).toBe(false);
    expect(usesAdminTokenOperatorDoor({ cookie: '' })).toBe(false);
  });

  it('expires the marker on sign-out cleanup', async () => {
    const { clearAdminTokenOperatorDoor } = await import('./auth-storage');
    const documentRef = { cookie: '' };
    clearAdminTokenOperatorDoor(documentRef);
    expect(documentRef.cookie).toContain('garden_operator_door=;');
    expect(documentRef.cookie).toContain('expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });
});
