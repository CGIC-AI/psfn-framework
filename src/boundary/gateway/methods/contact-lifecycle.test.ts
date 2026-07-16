import { describe, expect, it, vi } from 'vitest';
import { registerContactLifecycleMethods } from './contact-lifecycle.js';
import type { GatewayMethodRuntime } from './types.js';

const request = {
  schemaVersion: 1 as const,
  intentId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
  phase: 'prepare' as const,
  action: 'contact.delete' as const,
  contactId: 'same-contact-id-in-many-companions',
};

describe('contact lifecycle gateway RPC', () => {
  it('derives the authority owner from the authenticated connection', async () => {
    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const executeForCompanion = vi.fn(async () => ({
      schemaVersion: 1 as const,
      intentId: request.intentId,
      phase: 'prepare' as const,
      action: 'contact.delete' as const,
      status: 'no_binding' as const,
      authorityGeneration: 2,
      globalAuthEpoch: 2,
      auditEventId: '8ba7b810-9dad-41d1-80b4-00c04fd430c8',
    }));
    const runtime = {
      target: { addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
        methods.set(name, handler);
      } },
      authenticatedCompanionId: () => '4b90c2e6-0663-4f01-9965-9d228fa848bd',
      contactLifecycleAuthority: { executeForCompanion },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;
    registerContactLifecycleMethods(runtime);

    await methods.get('contact.lifecycle.execute')?.({ request });
    expect(executeForCompanion).toHaveBeenCalledWith(
      '4b90c2e6-0663-4f01-9965-9d228fa848bd',
      request,
    );
  });

  it.each(['companionId', 'bindingId', 'principalId', 'role', 'trustLevel', 'username'])(
    'rejects caller-supplied %s claims before authority dispatch',
    async field => {
      const methods = new Map<string, (params: unknown) => Promise<unknown>>();
      const executeForCompanion = vi.fn();
      const runtime = {
        target: { addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
          methods.set(name, handler);
        } },
        authenticatedCompanionId: () => '4b90c2e6-0663-4f01-9965-9d228fa848bd',
        contactLifecycleAuthority: { executeForCompanion },
        audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
      } as unknown as GatewayMethodRuntime;
      registerContactLifecycleMethods(runtime);
      await expect(methods.get('contact.lifecycle.execute')?.({
        request,
        [field]: 'spoofed',
      })).rejects.toThrow();
      expect(executeForCompanion).not.toHaveBeenCalled();
    },
  );
});
