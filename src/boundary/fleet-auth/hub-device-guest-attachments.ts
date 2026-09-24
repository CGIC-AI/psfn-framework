import { createHash, randomUUID } from 'node:crypto';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import {
  HubDeviceAttachmentRejectedError,
  type HubDeviceHumanAttachment,
  type HubDeviceHumanAttachmentPort,
} from './hub-device-ingress.js';
import { DEFAULT_FENCE_TTL_MS, DEFAULT_MAX_FENCES } from './hub-device-endpoint-fence.js';
import { DEFAULT_MAX_ENTRIES as DEFAULT_MAX_ASSERTION_BINDINGS } from './hub-device-assertion-replay-memory.js';

/**
 * Hub device attachment authority for a gateway running without fleet auth.
 *
 * Fleet auth (SSO) is the only thing that can name a *human* principal to
 * attach to an enrolled device; without it every admitted device session is a
 * guest session bound to the companion the device enrolled with. That is the
 * key-authenticated equivalent of the Postgres
 * `PostgresHubDeviceHumanAttachmentStore` — SSO adds human attachment on top,
 * it never gates device admission (psfn-framework-n66dn.2).
 *
 * Fencing mirrors the durable store's contract (a rejected assertion or a
 * changed enrollment authority fences the connection so the same connection
 * cannot be retried), but is bounded in time: the fence lifts after
 * `fenceTtlMs` (default 70 s, the longest an assertion can live) so a single
 * clock-skew rejection does not brick a hub whose session id is stable until
 * it re-hellos.
 *
 * Each admitted assertion is bound to the connection that first presented it
 * for the same window, mirroring the durable store's assertion-digest lookup
 * (psfn-framework-xwcqm): re-presenting it on a different connection is a
 * `device_binding_mismatch` that fences the original connection, instead of
 * a fresh guest attachment on a forked hub-device channel.
 */
export interface GuestOnlyHubDeviceAttachmentStoreOptions {
  now?: () => number;
  randomId?: () => string;
  fenceTtlMs?: number;
  maxFences?: number;
  /**
   * Upper bound on live assertion-to-connection bindings. At the bound a NEW
   * assertion is refused (fail closed) rather than evicting a live binding,
   * matching the in-memory replay fence it pairs with.
   */
  maxAssertionBindings?: number;
}

const CHANNEL_DIGEST_DOMAIN = 'hub-device-channel:guest:v1\0';

export class GuestOnlyHubDeviceAttachmentStore implements HubDeviceHumanAttachmentPort {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly fenceTtlMs: number;
  private readonly maxFences: number;
  private readonly fences = new Map<string, { until: number; reason: string }>();
  // Keyed by connection; each entry expires with the fence window (the longest
  // an assertion lives) after its last attach, and the map is capped, so the
  // key-auth admission path cannot grow it without bound.
  private readonly attachments = new Map<string, {
    attachmentId: string;
    assertionDigest: string;
    expiresAtMs: number;
  }>();
  private readonly maxAssertionBindings: number;
  private readonly assertionBindings = new Map<string, { connectionId: string; expiresAtMs: number }>();

  constructor(options: GuestOnlyHubDeviceAttachmentStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? randomUUID;
    this.fenceTtlMs = options.fenceTtlMs ?? DEFAULT_FENCE_TTL_MS;
    this.maxFences = options.maxFences ?? DEFAULT_MAX_FENCES;
    this.maxAssertionBindings = options.maxAssertionBindings ?? DEFAULT_MAX_ASSERTION_BINDINGS;
  }

  isFenced(connectionId: string): boolean {
    const fence = this.fences.get(connectionId);
    if (!fence) return false;
    if (fence.until <= this.now()) {
      this.fences.delete(connectionId);
      return false;
    }
    return true;
  }

  async attach(
    input: Parameters<HubDeviceHumanAttachmentPort['attach']>[0],
  ): Promise<HubDeviceHumanAttachment> {
    if (input.human.kind === 'fleet_browser_session') {
      // A browser session can only be resolved by the fleet-auth SSO authority.
      // Guest attachment is the key path; this is the one extra SSO adds.
      throw new HubDeviceAttachmentRejectedError('human_binding_mismatch');
    }
    const connectionId = input.connection.connectionId;
    if (this.isFenced(connectionId)) {
      throw new HubDeviceAttachmentRejectedError('device_fenced');
    }
    if (input.devicePrincipal.deviceId !== input.connection.deviceId
      || input.devicePrincipal.companionId !== input.connection.companionId
      || input.devicePrincipal.sessionId !== input.connection.sessionId
      || input.devicePrincipal.enrollmentVersion !== input.connection.enrollmentVersion) {
      throw new HubDeviceAttachmentRejectedError('device_binding_mismatch');
    }
    const companionId = input.connection.companionId;
    const nowMs = this.now();
    this.sweepAttachments(nowMs);
    await this.bindAssertionToConnection(input.assertionDigest, connectionId, nowMs);
    const existing = this.attachments.get(connectionId);
    let disposition: HubDeviceAttachmentSnapshot['disposition'];
    let attachmentId: string;
    if (input.human.kind === 'detach') {
      disposition = 'human_detached';
      attachmentId = existing?.attachmentId ?? this.randomId();
    } else if (existing && existing.assertionDigest === input.assertionDigest) {
      disposition = 'retry';
      attachmentId = existing.attachmentId;
    } else {
      disposition = existing ? 'guest_created' : 'created';
      attachmentId = this.randomId();
    }
    this.attachments.delete(connectionId);
    if (this.attachments.size >= this.maxFences) {
      const oldest = this.attachments.keys().next().value;
      if (oldest !== undefined) this.attachments.delete(oldest);
    }
    this.attachments.set(connectionId, {
      attachmentId,
      assertionDigest: input.assertionDigest,
      expiresAtMs: nowMs + this.fenceTtlMs,
    });
    const channelDigest = createHash('sha256')
      .update(CHANNEL_DIGEST_DOMAIN)
      .update(companionId).update('\0')
      .update(input.connection.deviceId).update('\0')
      .update(input.connection.sessionId).update('\0')
      .update(connectionId)
      .digest('hex');
    return Object.freeze({
      attachmentId,
      disposition,
      deviceActor: Object.freeze({
        kind: 'hub_device' as const,
        principal: input.devicePrincipal,
        connectionId,
      }),
      actor: Object.freeze({ kind: 'guest' as const, companionId }),
      channel: Object.freeze({
        source: 'server' as const,
        id: `hub-device:${channelDigest}`,
        companionId,
      }),
    });
  }

  get attachmentCount(): number {
    return this.attachments.size;
  }

  private sweepAttachments(nowMs: number): void {
    for (const [connectionId, attachment] of this.attachments) {
      if (attachment.expiresAtMs <= nowMs) this.attachments.delete(connectionId);
    }
    for (const [assertionDigest, binding] of this.assertionBindings) {
      if (binding.expiresAtMs <= nowMs) this.assertionBindings.delete(assertionDigest);
    }
  }

  private async bindAssertionToConnection(
    assertionDigest: string,
    connectionId: string,
    nowMs: number,
  ): Promise<void> {
    const bound = this.assertionBindings.get(assertionDigest);
    if (bound) {
      if (bound.connectionId === connectionId) return;
      await this.fenceDevice({
        assertionDigest,
        connectionId: bound.connectionId,
        reason: 'assertion_rejected',
      });
      throw new HubDeviceAttachmentRejectedError('device_binding_mismatch');
    }
    if (this.assertionBindings.size >= this.maxAssertionBindings) {
      throw new Error('Hub device guest attachment assertion bindings are at capacity');
    }
    this.assertionBindings.set(assertionDigest, { connectionId, expiresAtMs: nowMs + this.fenceTtlMs });
  }

  async fenceDevice(
    input: Parameters<HubDeviceHumanAttachmentPort['fenceDevice']>[0],
  ): Promise<void> {
    const nowMs = this.now();
    for (const [connectionId, fence] of this.fences) {
      if (fence.until <= nowMs) this.fences.delete(connectionId);
    }
    if (this.fences.size >= this.maxFences && !this.fences.has(input.connectionId)) {
      const oldest = this.fences.keys().next().value;
      if (oldest !== undefined) this.fences.delete(oldest);
    }
    this.fences.set(input.connectionId, { until: nowMs + this.fenceTtlMs, reason: input.reason });
    this.attachments.delete(input.connectionId);
  }
}
