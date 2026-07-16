import type {
  HubDeviceAssertionExpectedBinding,
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

export type HubDeviceSessionDisposition = 'created' | 'continued' | 'retry';

export interface HubDeviceSessionAdmissionPort {
  admit(input: {
    connectionId: string;
    principal: HubDevicePrincipalSnapshot;
  }): HubDeviceSessionDisposition;
}

/**
 * Deliberately separate extension seam for OPL1.9. Device admission does not
 * resolve, accept, or manufacture a human principal.
 */
export interface HubDeviceHumanAttachmentPort<HumanPrincipal> {
  resolveForDeviceSession(input: {
    companionId: string;
    deviceId: string;
    sessionId: string;
  }): Promise<HumanPrincipal | null>;
}

export interface HubDeviceIngressAdmission {
  devicePrincipal: HubDevicePrincipalSnapshot;
  sessionDisposition: HubDeviceSessionDisposition;
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
  private readonly sessions: HubDeviceSessionAdmissionPort;

  constructor(options: {
    verifyAndConsume: HubDeviceAssertionVerifierPort['verifyAndConsume'];
    sessions?: HubDeviceSessionAdmissionPort;
  }) {
    this.verifier = { verifyAndConsume: options.verifyAndConsume };
    this.sessions = options.sessions ?? new InMemoryHubDeviceSessionAdmissionStore();
  }

  async admit(input: {
    assertion: string;
    connection: AuthenticatedHubDeviceConnection;
  }): Promise<HubDeviceIngressAdmission> {
    const expected = expectedBinding(input.connection);
    let verified: HubDevicePrincipal;
    try {
      verified = await this.verifier.verifyAndConsume(input.assertion, expected);
    } catch (error) {
      if (error instanceof HubDeviceAssertionRejectedError) throw error;
      if (error instanceof Error && error.message.startsWith('Hub device assertion')) {
        throw new HubDeviceAssertionRejectedError(error.message);
      }
      throw error;
    }
    assertPrincipalMatchesConnection(verified, expected);
    const devicePrincipal = serializeHubDevicePrincipal(verified);
    const sessionDisposition = this.sessions.admit({
      connectionId: input.connection.connectionId,
      principal: devicePrincipal,
    });
    return { devicePrincipal, sessionDisposition };
  }
}

export function serializeHubDevicePrincipal(
  principal: HubDevicePrincipal,
): HubDevicePrincipalSnapshot {
  return {
    ...principal,
    issuedAt: principal.issuedAt.toISOString(),
    expiresAt: principal.expiresAt.toISOString(),
  };
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
