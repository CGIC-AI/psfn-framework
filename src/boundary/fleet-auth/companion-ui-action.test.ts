import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  CompanionUiProtocolError,
  compileCompanionUiAction,
  parseCompanionUiActionFrame,
} from './companion-ui-action.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type RequestCapabilityAuthContext,
} from './request-capability.js';

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const ceiling = Object.freeze({
  capabilities: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'touch'] as const,
  telemetryScopes: ['status', 'approvals', 'artifacts', 'tool_activity'] as const,
});
const authContext: RequestCapabilityAuthContext = Object.freeze({
  principalId: '22222222-2222-4222-8222-222222222222',
  provider: 'discord',
  providerSubjectId: '123456789012345678',
  companionId,
  contactBindingId: '33333333-3333-4333-8333-333333333333',
  contactId: '77777777-7777-4777-8777-777777777777',
  operatorGrantId: '44444444-4444-4444-8444-444444444444',
  role: 'member',
  sessionRecordId: '55555555-5555-4555-8555-555555555555',
  sessionAssurance: 'oauth',
  authorizationEventId: '66666666-6666-4666-8666-666666666666',
  resolvedAt: '2030-01-01T00:00:00.000Z',
});

function raw(resource: string, action: string, body: unknown): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    requestId: 'ui-request-1',
    action,
    resource,
    body,
  }));
}

describe('Companion UI action target', () => {
  it.each([
    ['conversation.status', 'companion.read', {}],
    ['conversation.interact', 'companion.interact', { content: 'untrusted browser text' }],
    ['conversation.interrupt', 'companion.interact', { interactionId: 'interaction-1' }],
    ['conversation.touch', 'companion.interact', { region: 'head', count: 1, durationMs: 250 }],
    ['conversation.audio', 'companion.interact', { transcript: 'untrusted transcript' }],
    ['confirmations.list', 'confirmations.read', {}],
    ['confirmations.resolve', 'confirmations.resolve', { id: 'confirmation-1', decision: 'deny' }],
    ['artifact.preview', 'artifacts.read', { id: 'artifact-1' }],
    ['tool_activity.subscribe', 'tool_activity.read', { subscribe: true }],
    ['embodiment.status', 'companion.read', {}],
    ['embodiment.handoff', 'embodiment.handoff', {
      expectedGeneration: 0,
      decisionId: '22222222-2222-4222-8222-222222222222',
      reason: 'user_requested',
    }],
  ])('compiles the exact %s action/resource/body under the Hub ceiling', (resource, action, body) => {
    const bytes = raw(resource, action, body);
    const compiled = compileCompanionUiAction(bytes, companionId, ceiling);
    expect(compiled.frame).toMatchObject({ action, resource, body });
    expect(compiled.target.body).toBe(bytes);
    expect(compiled.target.canonicalQuery).toBe('');
    expect(compiled.target.canonicalPath).toContain(`/companions/${companionId}/ws/actions/`);
  });

  it('denies action aliases, browser authority, and identity-as-trust smuggling', () => {
    expect(() => parseCompanionUiActionFrame(raw(
      'confirmations.resolve',
      'confirmations.read',
      { id: 'confirmation-1', decision: 'approve' },
    ))).toThrow(CompanionUiProtocolError);
    for (const body of [
      { content: 'hello', deviceId: 'browser-device' },
      { content: 'hello', principal_id: 'browser-human' },
      { content: 'hello', trusted: true },
      { content: 'hello', channel: 'browser-channel' },
    ]) {
      expect(() => parseCompanionUiActionFrame(raw(
        'conversation.interact',
        'companion.interact',
        body,
      ))).toThrowError(expect.objectContaining({ code: 'authority_forbidden' }));
    }
    expect(() => parseCompanionUiActionFrame(raw(
      'embodiment.handoff',
      'embodiment.handoff',
      {
        expectedGeneration: 0,
        decisionId: '22222222-2222-4222-8222-222222222222',
        reason: 'user_requested',
        deviceId: 'browser-selected',
      },
    ))).toThrowError(expect.objectContaining({ code: 'authority_forbidden' }));
  });

  it('intersects human action with the physical capability ceiling', () => {
    expect(() => compileCompanionUiAction(
      raw('conversation.audio', 'companion.interact', { transcript: 'hello' }),
      companionId,
      { capabilities: ['text'], telemetryScopes: [] },
    )).toThrowError(expect.objectContaining({ code: 'physical_capability_denied' }));
    expect(() => compileCompanionUiAction(
      raw('confirmations.resolve', 'confirmations.resolve', { id: 'c-1', decision: 'deny' }),
      companionId,
      { capabilities: ['text'], telemetryScopes: [] },
    )).toThrowError(expect.objectContaining({ code: 'physical_capability_denied' }));
  });

  it('binds Companion UI frames into operator and linked agent capabilities', () => {
    const keys = generateKeyPairSync('ed25519');
    const signer = createGatewayRequestCapabilitySigner({
      issuer: 'fleet-auth',
      kid: 'key-1',
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ttlSeconds: 30,
      nowSeconds: () => 1_893_456_000,
    });
    const verifier = createRequestCapabilityVerifier({
      issuer: 'fleet-auth',
      maxTtlSeconds: 30,
      keys: [{
        issuer: 'fleet-auth', kid: 'key-1',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        notBefore: '2029-01-01T00:00:00.000Z',
        notAfter: '2031-01-01T00:00:00.000Z', status: 'active',
      }],
    });
    const compiled = compileCompanionUiAction(
      raw('conversation.interact', 'companion.interact', { content: 'hello' }),
      companionId,
      ceiling,
    );
    const versions = {
      authorityGeneration: 1, globalAuthEpoch: 1, sessionAuthnVersion: 1,
      sessionAuthzVersion: 1, bindingVersion: 1, grantVersion: 1, policyVersion: 1,
    };
    const parentInput = {
      target: compiled.target,
      requestId: randomUUID(),
      decisionId: randomUUID(),
      authContext,
      versions,
    };
    const parentToken = signer.signOperator(parentInput);
    const parentVerified = verifier.verifyOperator({ token: parentToken, ...parentInput, nowSeconds: 1_893_456_000 });
    const parent = {
      audience: parentVerified.audience as `operator:${string}`,
      requestId: parentVerified.requestId,
      decisionId: parentVerified.decisionId,
      jti: parentVerified.jti,
      targetDigest: parentVerified.targetDigest,
    };
    const childInput = {
      target: compiled.target,
      requestId: randomUUID(),
      decisionId: randomUUID(),
      authContext,
      versions,
      parent,
    };
    const childToken = signer.signAgent(childInput);
    expect(verifier.verifyAgent({ token: childToken, ...childInput, nowSeconds: 1_893_456_000 }).parent)
      .toEqual(parent);
    const mutated = compileCompanionUiAction(
      raw('conversation.interact', 'companion.interact', { content: 'changed' }),
      companionId,
      ceiling,
    );
    expect(() => verifier.verifyAgent({
      token: childToken,
      ...childInput,
      target: mutated.target,
      nowSeconds: 1_893_456_000,
    })).toThrow();
    expect(() => verifier.verifyAgent({
      token: parentToken,
      ...parentInput,
      parent,
      nowSeconds: 1_893_456_000,
    })).toThrow();
  });
});
