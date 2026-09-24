import { describe, expect, it } from 'vitest';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import {
  CompanionUiSessionAuthority,
  CompanionUiSessionRefreshContendedError,
} from './companion-ui-session-renewal.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

function attachment(expiresAtMs: number, jti: string): HubDeviceAttachmentSnapshot {
  return {
    attachmentId: '018f0f10-79b2-4cc7-8c99-0242ac120003',
    disposition: 'retry',
    deviceActor: {
      kind: 'hub_device',
      connectionId: 'c'.repeat(64),
      principal: {
        kind: 'hub_device',
        issuer: 'psfn-satellite-hub',
        keyId: 'hub-key',
        deviceId: 'office-device',
        enrollmentVersion: 1,
        enrollmentAssurance: 'device_credential',
        audience: 'https://fleet.example.test',
        companionId: COMPANION_ID,
        sessionId: 'realtime:office-device:session',
        issuedAt: new Date(expiresAtMs - 30_000).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        jti,
      },
    },
    actor: { kind: 'guest', companionId: COMPANION_ID },
    channel: { source: 'server', id: `hub-device:${'0'.repeat(64)}`, companionId: COMPANION_ID },
  } as unknown as HubDeviceAttachmentSnapshot;
}

describe('CompanionUiSessionAuthority.refresh (psfn-framework-ztocx)', () => {
  it('retries once when a renewal wins the race and adopts the renewed receipt', async () => {
    let expiry = 1_000_000;
    let authority: CompanionUiSessionAuthority | undefined;
    let renewedOnce = false;
    const admitted: string[] = [];
    authority = new CompanionUiSessionAuthority('a0', attachment(expiry, 'j0'), async (assertion) => {
      admitted.push(assertion);
      if (!renewedOnce && assertion === 'a0') {
        renewedOnce = true;
        expiry += 30_000;
        await authority!.renew('a1');
      }
      return attachment(expiry, `j-${assertion}`);
    }, () => false);

    await authority.refresh();
    expect(admitted).toEqual(['a0', 'a1', 'a1']);
    expect(authority.attachment.deviceActor.principal.jti).toBe('j-a1');
  });

  it('fails closed with a structured error when renewals keep replacing the assertion', async () => {
    let expiry = 1_000_000;
    let counter = 0;
    let authority: CompanionUiSessionAuthority | undefined;
    const refreshAdmissions: string[] = [];
    let renewing = false;
    authority = new CompanionUiSessionAuthority('a0', attachment(expiry, 'j0'), async (assertion) => {
      if (renewing) return attachment(expiry, `j-${assertion}`);
      refreshAdmissions.push(assertion);
      // Every refresh admission loses its race to a fresh renewal.
      renewing = true;
      counter += 1;
      expiry += 30_000;
      await authority!.renew(`a${counter}`);
      renewing = false;
      return attachment(expiry, `j-${assertion}`);
    }, () => false);

    const failure = await authority.refresh().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CompanionUiSessionRefreshContendedError);
    expect(failure).toMatchObject({ code: 'session_refresh_contended', passes: 4 });
    expect(refreshAdmissions).toHaveLength(4);
  });
});
