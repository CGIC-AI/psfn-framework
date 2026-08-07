import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import { registerFilesystemMethods } from './fs.js';
import { GatewayErrors } from '../protocol.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../../core/cogsec/intake-firewall-notice-templates.js';

describe('registerFilesystemMethods', () => {
  it('reaches the persona mutation guard before dispatch and leaves read-only methods unguarded', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'gateway-fs-persona-guard-'));
    const readablePath = join(workspaceRoot, 'readable.txt');
    writeFileSync(readablePath, 'safe');
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const inspectFilesystemMutation = vi.fn(() => [{ pathClass: 'character_card' as const }]);
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      policyConfig: { workspacePath: workspaceRoot },
      workspacePath: workspaceRoot,
      personaMutationAttemptGuard: { inspectFilesystemMutation },
      approvalBoundary: {
        gate: (options: {
          handler: (params: unknown) => Promise<unknown>;
          prePolicyGuard?: (params: unknown) => void;
        }) => async (params: unknown) => {
          options.prePolicyGuard?.(params);
          return options.handler(params);
        },
      },
      authenticatedCompanionId: () => 'companion-a',
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;

    try {
      registerFilesystemMethods(runtime);
      await expect(methods.get('fs.write')!({ path: 'protected.json', content: 'x' }))
        .rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
      expect(inspectFilesystemMutation).toHaveBeenCalledWith(expect.objectContaining({
        companionId: 'companion-a',
        tool: 'fs.write',
      }));
      inspectFilesystemMutation.mockClear();
      await expect(methods.get('fs.read')!({ path: readablePath })).resolves.toMatchObject({
        content: 'safe',
      });
      expect(inspectFilesystemMutation).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('edits files addressed by relative and Personal Workspace-prefixed paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-fs-edit-prefix-'));
    const workspaceRoot = join(root, 'workspaces', 'personal', 'companion-a');
    mkdirSync(join(workspaceRoot, 'notes'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'notes', 'relative.txt'), 'before relative');
    writeFileSync(join(workspaceRoot, 'notes', 'prefixed.txt'), 'before prefixed');
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      policyConfig: { workspacePath: workspaceRoot },
      workspacePath: workspaceRoot,
      personalWorkspaceIsolation: true,
      approvalBoundary: {
        gate: (options: { handler: (params: unknown) => Promise<unknown> }) =>
          async (params: unknown) => options.handler(params),
      },
      authenticatedCompanionId: () => 'companion-a',
      notifyRequester: vi.fn(),
      listPendingConfirmations: () => [],
      listConfirmationHistory: () => [],
      resolveConfirmation: vi.fn(),
      sendNtfy: vi.fn(),
      getRuntimeHealth: vi.fn(),
      nextStreamRequestId: () => 'stream-1',
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;

    try {
      registerFilesystemMethods(runtime);
      const edit = methods.get('fs.edit');
      expect(edit).toBeDefined();

      await expect(edit!({
        path: 'notes/relative.txt',
        oldText: 'before',
        newText: 'after',
      })).resolves.toEqual({ success: true, replacements: 1 });
      await expect(edit!({
        path: 'workspaces/personal/companion-a/notes/prefixed.txt',
        oldText: 'before',
        newText: 'after',
      })).resolves.toEqual({ success: true, replacements: 1 });

      expect(readFileSync(join(workspaceRoot, 'notes', 'relative.txt'), 'utf8'))
        .toBe('after relative');
      expect(readFileSync(join(workspaceRoot, 'notes', 'prefixed.txt'), 'utf8'))
        .toBe('after prefixed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the Personal Workspace scope when isolation blocks a codebase fallback read', async () => {
    const codebaseRoot = mkdtempSync(join(tmpdir(), 'gateway-fs-scope-'));
    const workspaceRoot = join(codebaseRoot, 'workspaces', 'personal', 'companion-a');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(codebaseRoot, 'README.md'), 'codebase only');
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      policyConfig: {
        workspacePath: workspaceRoot,
        fullCodebaseReadRoot: codebaseRoot,
      },
      workspacePath: workspaceRoot,
      personalWorkspaceIsolation: true,
      approvalBoundary: {
        gate: (options: { handler: (params: unknown) => Promise<unknown> }) =>
          async (params: unknown) => options.handler(params),
      },
      authenticatedCompanionId: () => 'companion-a',
      notifyRequester: vi.fn(),
      listPendingConfirmations: () => [],
      listConfirmationHistory: () => [],
      resolveConfirmation: vi.fn(),
      sendNtfy: vi.fn(),
      getRuntimeHealth: vi.fn(),
      nextStreamRequestId: () => 'stream-1',
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;

    try {
      registerFilesystemMethods(runtime);
      const read = methods.get('fs.read');
      expect(read).toBeDefined();

      await expect(read!({ path: 'README.md' })).rejects.toMatchObject({
        code: GatewayErrors.POLICY_DENIED,
        message: expect.stringContaining('codebase fallback'),
      });
      await expect(read!({ path: 'README.md' })).rejects.toMatchObject({
        message: expect.stringContaining('Personal Workspace isolation'),
      });
    } finally {
      rmSync(codebaseRoot, { recursive: true, force: true });
    }
  });

  it('withholds normalized writes and every edit oracle outcome for quarantined artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-fs-mutation-quarantine-'));
    const workspaceRoot = join(root, 'workspaces', 'personal', 'companion-a');
    const artifactPath = join(workspaceRoot, 'held.txt');
    const originalContent = 'unique-secret repeated-secret repeated-secret';
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(artifactPath, originalContent);
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const check = vi.fn(() => ({
      withheld: true as const,
      envelopeId: 'held-envelope',
      noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
    }));
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      policyConfig: { workspacePath: workspaceRoot },
      workspacePath: workspaceRoot,
      personalWorkspaceIsolation: true,
      quarantinedArtifactGuard: {
        check,
        checkMany: (paths, context) => ({
          verdicts: paths.map(path => check(path, context)),
          revisionToken: 'stable-test-revision',
        }),
        readRevisionToken: () => 'stable-test-revision',
        listEnforcedArtifactPaths: () => [artifactPath],
        listEnforcedArtifactIdentities: () => [],
      },
      approvalBoundary: {
        gate: (options: { handler: (params: unknown) => Promise<unknown> }) =>
          async (params: unknown) => options.handler(params),
      },
      authenticatedCompanionId: () => 'companion-a',
      notifyRequester: vi.fn(),
      listPendingConfirmations: () => [],
      listConfirmationHistory: () => [],
      resolveConfirmation: vi.fn(),
      sendNtfy: vi.fn(),
      getRuntimeHealth: vi.fn(),
      nextStreamRequestId: () => 'stream-1',
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;

    try {
      registerFilesystemMethods(runtime);
      const write = methods.get('fs.write');
      const edit = methods.get('fs.edit');
      expect(write).toBeDefined();
      expect(edit).toBeDefined();

      await expect(write!({
        path: 'workspaces/personal/companion-a/held.txt',
        content: 'destroyed',
      })).rejects.toMatchObject({
        code: GatewayErrors.POLICY_DENIED,
        message: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
      });

      for (const oldText of ['unique-secret', 'missing-secret', 'repeated-secret']) {
        await expect(edit!({
          path: 'held.txt',
          oldText,
          newText: 'oracle-probe',
        })).rejects.toMatchObject({
          code: GatewayErrors.POLICY_DENIED,
          message: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
        });
      }

      expect(readFileSync(artifactPath, 'utf8')).toBe(originalContent);
      expect(check.mock.calls).toEqual([
        [artifactPath, { via: 'gateway:fs.write' }],
        [artifactPath, { via: 'gateway:fs.edit' }],
        [artifactPath, { via: 'gateway:fs.edit' }],
        [artifactPath, { via: 'gateway:fs.edit' }],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses write/edit when a screened pathname is swapped to another inode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-fs-mutation-swap-'));
    const workspaceRoot = join(root, 'workspaces', 'personal', 'companion-a');
    mkdirSync(workspaceRoot, { recursive: true });
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const swaps = new Map([
      ['gateway:fs.write', {
        target: join(workspaceRoot, 'write-target.txt'),
        backup: join(workspaceRoot, 'write-safe-backup.txt'),
        held: join(workspaceRoot, 'write-held.txt'),
      }],
      ['gateway:fs.edit', {
        target: join(workspaceRoot, 'edit-target.txt'),
        backup: join(workspaceRoot, 'edit-safe-backup.txt'),
        held: join(workspaceRoot, 'edit-held.txt'),
      }],
    ]);
    for (const paths of swaps.values()) {
      writeFileSync(paths.target, 'ordinary safe text');
      writeFileSync(paths.held, 'MARKER-held-evidence');
    }
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      policyConfig: { workspacePath: workspaceRoot },
      workspacePath: workspaceRoot,
      personalWorkspaceIsolation: true,
      quarantinedArtifactGuard: {
        check: () => ({ withheld: false }),
        checkMany: (paths: readonly string[], context: { via: string }) => {
          const swap = swaps.get(context.via);
          if (swap && paths[0] === swap.target) {
            swaps.delete(context.via);
            renameSync(swap.target, swap.backup);
            renameSync(swap.held, swap.target);
          }
          return {
            verdicts: paths.map(() => ({ withheld: false })),
            revisionToken: 'stable-swap-revision',
          };
        },
        readRevisionToken: () => 'stable-swap-revision',
        listEnforcedArtifactPaths: () => [],
        listEnforcedArtifactIdentities: () => [],
      },
      approvalBoundary: {
        gate: (options: { handler: (params: unknown) => Promise<unknown> }) =>
          async (params: unknown) => options.handler(params),
      },
      authenticatedCompanionId: () => 'companion-a',
      notifyRequester: vi.fn(),
      listPendingConfirmations: () => [],
      listConfirmationHistory: () => [],
      resolveConfirmation: vi.fn(),
      sendNtfy: vi.fn(),
      getRuntimeHealth: vi.fn(),
      nextStreamRequestId: () => 'stream-1',
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;

    try {
      registerFilesystemMethods(runtime);
      await expect(methods.get('fs.write')!({
        path: 'write-target.txt',
        content: 'destroyed',
      })).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
      await expect(methods.get('fs.edit')!({
        path: 'edit-target.txt',
        oldText: 'MARKER-held-evidence',
        newText: 'oracle-success',
      })).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });

      expect(readFileSync(join(workspaceRoot, 'write-target.txt'), 'utf8'))
        .toBe('MARKER-held-evidence');
      expect(readFileSync(join(workspaceRoot, 'edit-target.txt'), 'utf8'))
        .toBe('MARKER-held-evidence');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
