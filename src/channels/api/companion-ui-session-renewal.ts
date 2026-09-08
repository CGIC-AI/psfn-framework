import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import { hasExactKeys, isRecord } from '../../shared/utils/types.js';

/** Server-to-server control; the Hub must never forward this from a browser. */
export function parseCompanionUiSessionRenewal(raw: Uint8Array): {
  requestId: string;
  assertion: string;
} | undefined {
  const value: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
  if (!isRecord(value) || value.type !== 'hub.session.renew') return undefined;
  if (!hasExactKeys(value, ['schemaVersion', 'type', 'requestId', 'assertion'])
    || value.schemaVersion !== 1
    || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.requestId)
    || typeof value.assertion !== 'string'
    || value.assertion.length === 0 || value.assertion.length > 8192) {
    throw new Error('Invalid Hub session renewal');
  }
  return { requestId: value.requestId, assertion: value.assertion };
}

/** Token freshness and its receipt may change; attached authority must not. */
function companionUiSessionContinuityKey(attachment: HubDeviceAttachmentSnapshot): string {
  const { keyId: _keyId, issuedAt: _issuedAt, expiresAt: _expiresAt, jti: _jti, ...principal } =
    attachment.deviceActor.principal;
  return JSON.stringify({
    deviceActor: { ...attachment.deviceActor, principal },
    actor: attachment.actor,
    channel: attachment.channel,
  });
}

function attachmentAuthorityKey(attachment: HubDeviceAttachmentSnapshot): string {
  return JSON.stringify({ attachmentId: attachment.attachmentId,
    deviceActor: attachment.deviceActor, actor: attachment.actor, channel: attachment.channel });
}

/** Maintains one socket attachment across short-lived Hub assertion receipts. */
export class CompanionUiSessionAuthority {
  attachment: HubDeviceAttachmentSnapshot;
  private assertion: string;
  private authorityKey: string;
  private readonly continuityKey: string;
  private renewals = Promise.resolve();

  constructor(assertion: string, attachment: HubDeviceAttachmentSnapshot,
    private readonly admit: (assertion: string) => Promise<HubDeviceAttachmentSnapshot>,
    private readonly isClosed: () => boolean) {
    this.assertion = assertion;
    this.attachment = attachment;
    this.authorityKey = attachmentAuthorityKey(attachment);
    this.continuityKey = companionUiSessionContinuityKey(attachment);
  }

  async refresh(): Promise<void> {
    if (this.isClosed()) throw new Error('socket closed');
    const assertion = this.assertion;
    const authorityKey = this.authorityKey;
    const refreshed = await this.admit(assertion);
    // Independent interrupts must remain runnable while another admission is
    // awaiting persistence. If a renewal wins that race, use its fresh receipt.
    if (assertion !== this.assertion) return this.refresh();
    if (attachmentAuthorityKey(refreshed) !== authorityKey) throw new Error('socket authority changed');
    this.attachment = refreshed;
  }

  renew(assertion: string): Promise<void> {
    const pending = this.renewals.then(async () => {
      if (this.isClosed() || assertion === this.assertion) throw new Error('invalid assertion renewal');
      const renewed = await this.admit(assertion);
      if (this.isClosed()
        || companionUiSessionContinuityKey(renewed) !== this.continuityKey
        || Date.parse(renewed.deviceActor.principal.expiresAt)
          <= Date.parse(this.attachment.deviceActor.principal.expiresAt)) {
        throw new Error('renewal changed attached authority');
      }
      this.assertion = assertion;
      this.attachment = renewed;
      this.authorityKey = attachmentAuthorityKey(renewed);
    });
    // The returned promise carries rejection to the socket's fail-closed
    // handler; this tail only keeps queued operations from inheriting it.
    this.renewals = pending.catch(() => undefined);
    return pending;
  }
}
