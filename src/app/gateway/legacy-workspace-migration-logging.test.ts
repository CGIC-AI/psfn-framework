import { describe, expect, it, vi } from 'vitest';
import { logLegacyWorkspaceMigrationResult } from './legacy-workspace-migration-logging.js';

describe('legacy workspace migration gateway logging', () => {
  it.each([
    {
      result: {
        status: 'migrated' as const,
        companionId: '11111111-1111-4111-8111-111111111111',
        sourcePath: '/runtime/legacy',
        destinationPath: '/runtime/workspaces/personal/one',
        sourceSha256: 'a'.repeat(64),
      },
      message: 'Legacy WORKSPACE_PATH migration completed',
      decision: 'migrated',
    },
    {
      result: {
        status: 'already_migrated' as const,
        companionId: '11111111-1111-4111-8111-111111111111',
        sourcePath: '/runtime/legacy',
        destinationPath: '/runtime/workspaces/personal/one',
        sourceSha256: 'a'.repeat(64),
      },
      message: 'Validated completed legacy WORKSPACE_PATH migration receipt',
      decision: 'already_migrated',
    },
  ])('logs the $decision outcome with its migration identity', ({ result, message, decision }) => {
    const info = vi.fn();

    logLegacyWorkspaceMigrationResult({ info }, result);

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(message, {
      companionId: result.companionId,
      sourcePath: result.sourcePath,
      destinationPath: result.destinationPath,
      sourceSha256: result.sourceSha256,
      decision,
    });
  });
});
