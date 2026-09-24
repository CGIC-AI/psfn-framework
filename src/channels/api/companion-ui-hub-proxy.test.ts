import { describe, expect, it } from 'vitest';
import { resolveCompanionUiSessionCookie } from './companion-ui-hub-proxy.js';

const SESSION = 's'.repeat(43);

describe('resolveCompanionUiSessionCookie', () => {
  it('finds the session cookie among unrelated cookies and forwards only it', () => {
    expect(resolveCompanionUiSessionCookie(
      1,
      `__Host-psfn_preauth=abc; __Host-psfn_session=${SESSION};psfn_token=zzz`,
    )).toEqual({ state: 'valid', cookie: `__Host-psfn_session=${SESSION}` });
  });

  it('treats a header without the session cookie as absent (guest decision stays with the caller)', () => {
    expect(resolveCompanionUiSessionCookie(1, 'other=1; psfn_token=zzz')).toEqual({ state: 'absent' });
    expect(resolveCompanionUiSessionCookie(0, undefined)).toEqual({ state: 'absent' });
  });

  it.each([
    [1, `__Host-psfn_session=${SESSION}x; other=1`],
    [1, `__Host-psfn_session=bad value; other=1`],
    [1, `__Host-psfn_session=${SESSION}; __Host-psfn_session=${SESSION}`],
    [2, `__Host-psfn_session=${SESSION}; other=1`],
  ])('fails closed for %i header(s) %s', (count, header) => {
    expect(resolveCompanionUiSessionCookie(count, header)).toEqual({ state: 'invalid' });
  });
});
