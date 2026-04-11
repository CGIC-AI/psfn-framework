import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeSessionRuntime } from '../../app/startup/composition/composition.js';
import {
  resolveInternalRoleEnvelopeLedgerPath,
  resolveInternalRoleEnvelopesDir,
} from '../../persistence/layout.js';

describe('internal role envelope runtime wiring', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'psfn-internal-role-runtime-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('wires the companion-data ledger into shared session runtime composition', () => {
    const companionDataDir = join(rootDir, 'companion-data');
    const composition = composeSessionRuntime({
      config: {
        companionDataDir,
        dataDir: companionDataDir,
      } as any,
    });

    expect(existsSync(resolveInternalRoleEnvelopesDir(companionDataDir))).toBe(true);
    expect(composition.internalRoleEnvelopeLedger.getChannelLedgerPath('api:session-1')).toBe(
      resolveInternalRoleEnvelopeLedgerPath(companionDataDir, 'api:session-1'),
    );
    expect(composition.sessionManager.getInternalRoleEnvelopeLedger()).toBe(
      composition.internalRoleEnvelopeLedger,
    );
  });
});
