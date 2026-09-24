import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { GatewayErrors } from '../protocol.js';
import {
  decideFrameAuthorization,
  decideIdentifyReentry,
  decideIdentifyRoleProof,
  parseIdentifyRequest,
} from './connection-authorization.js';

const A = createCompanionId('11111111-1111-4111-8111-111111111111');
const B = createCompanionId('22222222-2222-4222-8222-222222222222');
const frame = (method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  method,
  ...(params !== undefined ? { params } : {}),
  id: 1,
});

describe('decideFrameAuthorization (fptm)', () => {
  it('passes responses and identify, and rejects untracked connections silently', () => {
    expect(decideFrameAuthorization({ frame: { jsonrpc: '2.0', id: 1, result: {} }, status: undefined, multiCompanionEnabled: true }))
      .toEqual({ kind: 'pass' });
    expect(decideFrameAuthorization({ frame: frame('gateway.client.identify'), status: undefined, multiCompanionEnabled: true }))
      .toEqual({ kind: 'pass' });
    expect(decideFrameAuthorization({ frame: frame('memory.search'), status: undefined, multiCompanionEnabled: false }))
      .toEqual({ kind: 'reject_untracked' });
  });

  it('requires identify first and keeps internal signing methods role-bound', () => {
    expect(decideFrameAuthorization({ frame: frame('memory.search'), status: { role: 'unidentified' }, multiCompanionEnabled: false }))
      .toMatchObject({ kind: 'reject', violation: { event: 'identify_required' }, error: { code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED } });
    expect(decideFrameAuthorization({ frame: frame('memory.search'), status: { role: 'internal_session_integrity', companionId: A }, multiCompanionEnabled: true }))
      .toMatchObject({ kind: 'reject', violation: { event: 'connection_role_denied', details: { companionId: A } }, error: { code: GatewayErrors.CONNECTION_ROLE_DENIED } });
    expect(decideFrameAuthorization({ frame: frame('session.hmac.sign'), status: { role: 'agent' }, multiCompanionEnabled: false }))
      .toMatchObject({ kind: 'reject', violation: { event: 'connection_role_denied', details: { method: 'session.hmac.sign', role: 'agent' } } });
    expect(decideFrameAuthorization({ frame: frame('session.hmac.verify'), status: { role: 'internal_session_integrity', companionId: A }, multiCompanionEnabled: false }))
      .toEqual({ kind: 'pass' });
  });

  it('disconnects a malformed claim in every topology but keeps single-companion socket trust otherwise', () => {
    for (const multiCompanionEnabled of [false, true]) {
      expect(decideFrameAuthorization({ frame: frame('memory.search', { companionId: 'not-a-uuid' }), status: { role: 'agent', companionId: A }, multiCompanionEnabled }))
        .toMatchObject({ kind: 'disconnect', reason: 'companion_identity_claim_invalid', violation: { event: 'identity_claim_invalid' } });
    }
    expect(decideFrameAuthorization({ frame: frame('memory.search', { companionId: B }), status: { role: 'agent', companionId: A }, multiCompanionEnabled: false }))
      .toEqual({ kind: 'pass' });
    expect(decideFrameAuthorization({ frame: frame('memory.search'), status: { role: 'agent' }, multiCompanionEnabled: false }))
      .toEqual({ kind: 'pass' });
  });

  it('disconnects a spoofed claim and requires a bound companion in multi-companion mode', () => {
    expect(decideFrameAuthorization({ frame: frame('memory.search', { companionId: B }), status: { role: 'agent', companionId: A }, multiCompanionEnabled: true }))
      .toEqual({
        kind: 'disconnect',
        reason: 'companion_identity_mismatch',
        violation: {
          event: 'identity_mismatch',
          message: 'Companion identity mismatch on RPC frame; disconnecting connection',
          details: { method: 'memory.search', boundCompanionId: A, claimedCompanionId: B },
        },
      });
    expect(decideFrameAuthorization({ frame: frame('memory.search', { companionId: A }), status: { role: 'agent', companionId: A }, multiCompanionEnabled: true }))
      .toEqual({ kind: 'pass' });
    expect(decideFrameAuthorization({ frame: frame('memory.search'), status: { role: 'agent' }, multiCompanionEnabled: true }))
      .toMatchObject({ kind: 'reject', violation: { event: 'identify_required' }, error: { code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED } });
  });
});

describe('gateway.client.identify decisions (fptm)', () => {
  const active = vi.fn();

  it('parses identify params with the original error precedence', () => {
    expect(() => parseIdentifyRequest({ role: 'root' }, active)).toThrow('requires a valid role');
    expect(() => parseIdentifyRequest({ role: 'agent' }, () => { throw new Error('inactive'); })).toThrow('inactive');
    expect(() => parseIdentifyRequest({ role: 'agent', companionId: ' ' }, active)).toThrow('companionId must be a non-empty string');
    expect(() => parseIdentifyRequest({ role: 'agent', companionId: A, authToken: 7 }, active)).toThrow('authToken must be a string');
    expect(parseIdentifyRequest({ role: 'agent', companionId: A, authToken: 't' }, active))
      .toEqual({ role: 'agent', companionId: A, authToken: 't' });
  });

  it('allows idempotent re-identify, single-companion role selection, and nothing else', () => {
    const request = { role: 'agent' as const, companionId: A };
    expect(decideIdentifyReentry({ status: { role: 'unidentified', stateReason: 'connected' }, request, multiCompanionEnabled: true }))
      .toEqual({ kind: 'identify' });
    expect(decideIdentifyReentry({ status: { role: 'agent', stateReason: 'rpc_registered' }, request, multiCompanionEnabled: false }))
      .toEqual({ kind: 'identify' });
    expect(decideIdentifyReentry({ status: { role: 'agent', companionId: A, stateReason: 'ready' }, request, multiCompanionEnabled: true }))
      .toEqual({ kind: 'already_identified', role: 'agent', companionId: A });
    expect(decideIdentifyReentry({ status: { role: 'agent', companionId: A, stateReason: 'ready' }, request: { role: 'agent', companionId: B }, multiCompanionEnabled: true }))
      .toMatchObject({ kind: 'reject' });
    expect(decideIdentifyReentry({ status: { role: 'agent', stateReason: 'rpc_registered' }, request: { role: 'internal_session_integrity', companionId: A }, multiCompanionEnabled: true }))
      .toMatchObject({ kind: 'reject' });
  });

  it('requires fleet membership and a role-bound token when proof applies', () => {
    const verifyAuthToken = vi.fn(() => true);
    const isFleetMember = vi.fn((id: string) => id === A);
    expect(decideIdentifyRoleProof({ request: { role: 'agent' }, multiCompanionEnabled: false, isFleetMember, verifyAuthToken }))
      .toEqual({ kind: 'accepted' });
    expect(verifyAuthToken).not.toHaveBeenCalled();
    expect(decideIdentifyRoleProof({ request: { role: 'internal_session_integrity' }, multiCompanionEnabled: false, isFleetMember, verifyAuthToken }))
      .toMatchObject({ kind: 'rejected', violation: { event: 'identify_missing_companion' }, message: expect.stringContaining('internal session-integrity') });
    expect(decideIdentifyRoleProof({ request: { role: 'agent' }, multiCompanionEnabled: true, isFleetMember, verifyAuthToken }))
      .toMatchObject({ kind: 'rejected', message: 'Multi-companion mode requires a companionId in gateway.client.identify' });
    expect(decideIdentifyRoleProof({ request: { role: 'agent', companionId: B }, multiCompanionEnabled: true, isFleetMember, verifyAuthToken }))
      .toMatchObject({ kind: 'rejected', violation: { event: 'identify_unknown_companion' }, jsonRpcCode: GatewayErrors.COMPANION_AUTH_FAILED });
    verifyAuthToken.mockReturnValueOnce(false);
    expect(decideIdentifyRoleProof({ request: { role: 'agent', companionId: A, authToken: 'bad' }, multiCompanionEnabled: true, isFleetMember, verifyAuthToken }))
      .toMatchObject({ kind: 'rejected', violation: { event: 'identify_auth_failed' }, jsonRpcCode: GatewayErrors.COMPANION_AUTH_FAILED });
    expect(verifyAuthToken).toHaveBeenLastCalledWith(A, 'agent', 'bad');
    expect(decideIdentifyRoleProof({ request: { role: 'agent', companionId: A, authToken: 'ok' }, multiCompanionEnabled: true, isFleetMember, verifyAuthToken }))
      .toEqual({ kind: 'accepted' });
  });
});
