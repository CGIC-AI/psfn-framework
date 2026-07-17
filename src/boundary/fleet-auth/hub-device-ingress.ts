import { createHash } from 'node:crypto';
import type {
  HubDeviceAssertionExpectedBinding,
  HubDeviceAttachmentSnapshot,
  HubDevicePrincipal,
  HubDevicePrincipalSnapshot,
} from '../../shared/contracts/hub-device-ingress.js';
import { HubDeviceAssertionRejectedError } from './hub-device-assertion.js';

export interface AuthenticatedHubDeviceConnection extends HubDeviceAssertionExpectedBinding {
  /** Opaque digest over the authenticated Hub principal and registry/session binding. */
  connectionId: string;
}

export interface HubDeviceAssertionVerifierPort {
  verifyAndConsume(
    assertion: string,
    expected: HubDeviceAssertionExpectedBinding,
  ): Promise<HubDevicePrincipal>;
}

/**
 * Resolves enrollment state from an already authenticated Hub connection.
 * The assertion and browser request are intentionally absent from this port.
 */
export interface HubDeviceEnrollmentAuthorityPort {
  resolve(input: {
    connectionId: string;
    authenticatedConnection: AuthenticatedHubDeviceConnection;
  }): Promise<AuthenticatedHubDeviceConnection>;
}

export type HubDeviceSessionDisposition = 'created' | 'continued' | 'retry';

export interface HubDeviceSessionAdmissionPort {
  admit(input: {
    connectionId: string;
    principal: HubDevicePrincipalSnapshot;
  }): HubDeviceSessionDisposition;
}

export type HubDeviceHumanAttachmentCommand =
  | Readonly<{ kind: 'guest' }>
  | Readonly<{ kind: 'fleet_browser_session'; sessionToken: string }>
  | Readonly<{ kind: 'detach' }>;

export type HubDeviceActorContext = HubDeviceAttachmentSnapshot['deviceActor'];
export type HubHumanActorContext = Extract<HubDeviceAttachmentSnapshot['actor'], { kind: 'human' }>;
export type HubGuestActorContext = Extract<HubDeviceAttachmentSnapshot['actor'], { kind: 'guest' }>;
export type HubDeviceServerChannelContext = HubDeviceAttachmentSnapshot['channel'];
export type HubDeviceAttachmentDisposition = HubDeviceAttachmentSnapshot['disposition'];
export type HubDeviceHumanAttachment = HubDeviceAttachmentSnapshot;

export interface HubDeviceHumanAttachmentPort {
  attach(input: {
    assertionDigest: string;
    devicePrincipal: HubDevicePrincipalSnapshot;
    connection: AuthenticatedHubDeviceConnection;
    human: HubDeviceHumanAttachmentCommand;
  }): Promise<HubDeviceHumanAttachment>;
  fenceDevice(input: {
    assertionDigest: string;
    connectionId: string;
    reason: 'assertion_rejected' | 'enrollment_authority_changed';
  }): Promise<void>;
}

export class HubDeviceAttachmentRejectedError extends HubDeviceAssertionRejectedError {
  constructor(readonly code: 'device_binding_mismatch' | 'device_fenced' | 'human_binding_mismatch') {
    super('Hub device human attachment was denied');
    this.name = 'HubDeviceAttachmentRejectedError';
  }
}

export interface HubDeviceIngressAdmission {
  devicePrincipal: HubDevicePrincipalSnapshot;
  sessionDisposition: HubDeviceSessionDisposition;
  attachment: HubDeviceHumanAttachment;
}

export class InMemoryHubDeviceSessionAdmissionStore implements HubDeviceSessionAdmissionPort {
  private readonly sessions = new Map<string, HubDevicePrincipalSnapshot>();
  private createObserver: (() => void) | undefined;

  get size(): number {
    return this.sessions.size;
  }

  onCreate(observer: () => void): void {
    this.createObserver = observer;
  }

  admit(input: {
    connectionId: string;
    principal: HubDevicePrincipalSnapshot;
  }): HubDeviceSessionDisposition {
    const current = this.sessions.get(input.connectionId);
    if (!current) {
      this.sessions.set(input.connectionId, input.principal);
      this.createObserver?.();
      return 'created';
    }
    assertSameDeviceSession(current, input.principal);
    if (current.jti === input.principal.jti) return 'retry';
    this.sessions.set(input.connectionId, input.principal);
    return 'continued';
  }
}

export class GatewayHubDeviceIngressService {
  private readonly verifier: HubDeviceAssertionVerifierPort;
  private readonly enrollmentAuthority: HubDeviceEnrollmentAuthorityPort;
  private readonly attachments: HubDeviceHumanAttachmentPort;
  private readonly sessions: HubDeviceSessionAdmissionPort;

  constructor(options: {
    verifyAndConsume: HubDeviceAssertionVerifierPort['verifyAndConsume'];
    enrollmentAuthority: HubDeviceEnrollmentAuthorityPort;
    attachments: HubDeviceHumanAttachmentPort;
    sessions?: HubDeviceSessionAdmissionPort;
  }) {
    this.verifier = { verifyAndConsume: options.verifyAndConsume };
    this.enrollmentAuthority = options.enrollmentAuthority;
    this.attachments = options.attachments;
    this.sessions = options.sessions ?? new InMemoryHubDeviceSessionAdmissionStore();
  }

  async fenceRejectedAssertion(assertion: string, connectionId: string): Promise<void> {
    await this.attachments.fenceDevice({
      assertionDigest: createHash('sha256').update(assertion).digest('hex'),
      connectionId,
      reason: 'enrollment_authority_changed',
    });
  }

  async admit(input: {
    assertion: string;
    connection: AuthenticatedHubDeviceConnection;
    human?: HubDeviceHumanAttachmentCommand;
  }): Promise<HubDeviceIngressAdmission> {
    const assertionDigest = createHash('sha256').update(input.assertion).digest('hex');
    let connection: AuthenticatedHubDeviceConnection;
    try {
      connection = await this.enrollmentAuthority.resolve({
        connectionId: input.connection.connectionId,
        authenticatedConnection: input.connection,
      });
      if (connection.connectionId !== input.connection.connectionId) {
        throw new HubDeviceAssertionRejectedError('Hub enrollment authority returned a different authenticated connection');
      }
    } catch (error) {
      await this.attachments.fenceDevice({
        assertionDigest,
        connectionId: input.connection.connectionId,
        reason: 'enrollment_authority_changed',
      });
      if (error instanceof HubDeviceAssertionRejectedError) throw error;
      throw new HubDeviceAssertionRejectedError('Hub enrollment authority did not resolve the authenticated connection');
    }
    const expected = expectedBinding(connection);
    let verified: HubDevicePrincipal;
    try {
      verified = await this.verifier.verifyAndConsume(input.assertion, expected);
      assertPrincipalMatchesConnection(verified, expected);
    } catch (error) {
      await this.attachments.fenceDevice({
        assertionDigest,
        connectionId: connection.connectionId,
        reason: 'assertion_rejected',
      });
      if (error instanceof HubDeviceAssertionRejectedError) throw error;
      if (error instanceof Error && error.message.startsWith('Hub device assertion')) {
        throw new HubDeviceAssertionRejectedError(error.message);
      }
      throw error;
    }
    const devicePrincipal = serializeHubDevicePrincipal(verified);
    const attachment = await this.attachments.attach({
      assertionDigest,
      devicePrincipal,
      connection,
      human: input.human ?? { kind: 'guest' },
    });
    const sessionDisposition = this.sessions.admit({
      connectionId: connection.connectionId,
      principal: devicePrincipal,
    });
    return { devicePrincipal, sessionDisposition, attachment };
  }
}

export function serializeHubDevicePrincipal(
  principal: HubDevicePrincipal,
): HubDevicePrincipalSnapshot {
  return Object.freeze({
    ...principal,
    issuedAt: principal.issuedAt.toISOString(),
    expiresAt: principal.expiresAt.toISOString(),
  });
}

function expectedBinding(
  connection: AuthenticatedHubDeviceConnection,
): HubDeviceAssertionExpectedBinding {
  return {
    deviceId: connection.deviceId,
    enrollmentVersion: connection.enrollmentVersion,
    enrollmentStatus: connection.enrollmentStatus,
    companionId: connection.companionId,
    sessionId: connection.sessionId,
    ...(connection.placeId ? { placeId: connection.placeId } : {}),
  };
}

function assertPrincipalMatchesConnection(
  principal: HubDevicePrincipal,
  expected: HubDeviceAssertionExpectedBinding,
): void {
  if (principal.deviceId !== expected.deviceId
    || principal.enrollmentVersion !== expected.enrollmentVersion
    || principal.companionId !== expected.companionId
    || principal.sessionId !== expected.sessionId
    || principal.placeId !== expected.placeId) {
    throw new HubDeviceAssertionRejectedError('Verified Hub device normalized principal did not match its authenticated connection binding');
  }
}

function assertSameDeviceSession(
  current: HubDevicePrincipalSnapshot,
  next: HubDevicePrincipalSnapshot,
): void {
  if (current.deviceId !== next.deviceId
    || current.companionId !== next.companionId
    || current.sessionId !== next.sessionId
    || current.enrollmentVersion !== next.enrollmentVersion
    || current.placeId !== next.placeId) {
    throw new HubDeviceAssertionRejectedError('Authenticated Hub connection changed device-session authority without a new connection');
  }
}
