import { describe, expect, it, vi } from 'vitest';
import { registerSystemDataMethods } from './system-data.js';
import type { GatewayMethodRuntime } from './types.js';

describe('system data gateway RPC', () => {
  it('derives the writer identity from the authenticated agent connection', async () => {
    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const writeSystemData = vi.fn(async () => ({ ok: true as const }));
    const runtime = {
      target: {
        addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
          methods.set(name, handler);
        },
      },
      authenticatedCompanionId: () => 'companion-a',
      systemDataWriter: { writeSystemData },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;
    registerSystemDataMethods(runtime);

    await expect(methods.get('system.data.write')?.({
      kind: 'owner_file',
      ownerFile: 'backup',
      payload: { intervalHours: 24 },
    })).resolves.toEqual({ ok: true });
    expect(writeSystemData).toHaveBeenCalledWith({
      kind: 'owner_file',
      ownerFile: 'backup',
      payload: { intervalHours: 24 },
    });
  });

  it('fails closed before dispatch when the connection is not authenticated', async () => {
    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const writeSystemData = vi.fn();
    const runtime = {
      target: {
        addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
          methods.set(name, handler);
        },
      },
      authenticatedCompanionId: () => undefined,
      systemDataWriter: { writeSystemData },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;
    registerSystemDataMethods(runtime);

    await expect(methods.get('system.data.write')?.({
      kind: 'owner_file',
      ownerFile: 'backup',
      payload: {},
    })).rejects.toThrow(/authenticated companion connection/);
    expect(writeSystemData).not.toHaveBeenCalled();
  });

  it('rejects unknown operations and caller-supplied identity claims', async () => {
    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const writeSystemData = vi.fn();
    const runtime = {
      target: {
        addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
          methods.set(name, handler);
        },
      },
      authenticatedCompanionId: () => 'companion-a',
      systemDataWriter: { writeSystemData },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;
    registerSystemDataMethods(runtime);

    await expect(methods.get('system.data.write')?.({
      kind: 'owner_file',
      ownerFile: 'backup',
      payload: {},
      companionId: 'spoofed',
    })).rejects.toThrow();
    await expect(methods.get('system.data.write')?.({
      kind: 'owner_file',
      ownerFile: 'scheduler',
      payload: {},
    })).rejects.toThrow(/system owner/);
    expect(writeSystemData).not.toHaveBeenCalled();
  });

  it('keeps malformed requests inside the audited path', async () => {
    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const auditSummaries: Record<string, unknown>[] = [];
    const writeSystemData = vi.fn();
    const runtime = {
      target: {
        addMethod: (name: string, handler: (params: unknown) => Promise<unknown>) => {
          methods.set(name, handler);
        },
      },
      authenticatedCompanionId: () => 'companion-a',
      systemDataWriter: { writeSystemData },
      audited: (
        _method: string,
        handler: (params: unknown) => Promise<unknown>,
        paramsSummary: (params: unknown) => Record<string, unknown>,
      ) => async (params: unknown) => {
        auditSummaries.push(paramsSummary(params));
        return await handler(params);
      },
    } as unknown as GatewayMethodRuntime;
    registerSystemDataMethods(runtime);

    await expect(methods.get('system.data.write')?.({
      kind: 'owner_file',
      ownerFile: 'scheduler',
      payload: {},
    })).rejects.toThrow(/system owner/);
    expect(auditSummaries).toEqual([{
      companionId: 'companion-a',
      invalidRequest: true,
    }]);
    expect(writeSystemData).not.toHaveBeenCalled();
  });
});
