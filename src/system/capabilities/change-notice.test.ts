import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCapabilityTierChange,
  deliverPendingCapabilityTierChangeNotices,
  enqueuePendingCapabilityTierChangeNotice,
  formatCapabilityTierChangeNotice,
} from './change-notice.js';
import { resolvePendingCapabilityNoticesPath } from '../../persistence/layout.js';

describe('capability tier change notice', () => {
  it('names the old and new tier plus exact granted and withdrawn tokens', () => {
    const change = buildCapabilityTierChange(
      {
        tier: 'apprentice',
        customTokens: [],
        grantedTokens: ['identity.read', 'internal.read', 'memory.write'],
      },
      {
        tier: 'custom',
        customTokens: ['identity.read', 'memory.delete'],
        grantedTokens: ['identity.read', 'memory.delete'],
      },
    );

    expect(change).toEqual({
      previous: {
        tier: 'apprentice',
        grantedTokens: ['identity.read', 'internal.read', 'memory.write'],
      },
      current: {
        tier: 'custom',
        grantedTokens: ['identity.read', 'memory.delete'],
      },
      granted: ['memory.delete'],
      withdrawn: ['internal.read', 'memory.write'],
    });
    const notice = formatCapabilityTierChangeNotice(change!);
    expect(notice).toContain('[System notice: capability access changed]');
    expect(notice).toContain('from "apprentice" to "custom"');
    expect(notice).toContain('Current granted capabilities: identity.read, memory.delete.');
    expect(notice).toContain('Newly granted: memory.delete.');
    expect(notice).toContain('Withdrawn: internal.read, memory.write.');
    expect(notice).toContain('This was an operator change, not a fault in you');
    expect(notice).toContain('relay this exact status to your person');
  });

  it('returns null when neither the tier nor the effective grant changed', () => {
    expect(buildCapabilityTierChange(
      {
        tier: 'nursery',
        customTokens: [],
        grantedTokens: ['identity.read'],
      },
      {
        tier: 'nursery',
        customTokens: [],
        grantedTokens: ['identity.read'],
      },
    )).toBeNull();
  });

  it('durably queues pre-conversation notices and retries a failed delivery', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pending-capability-notice-'));
    const change = buildCapabilityTierChange(
      { tier: 'nursery', customTokens: [], grantedTokens: ['identity.read'] },
      { tier: 'custom', customTokens: ['memory.delete'], grantedTokens: ['memory.delete'] },
    )!;
    try {
      enqueuePendingCapabilityTierChangeNotice(dataDir, change);
      const queuePath = resolvePendingCapabilityNoticesPath(dataDir);
      renameSync(queuePath, `${queuePath}.drain-99999999-abandoned`);

      expect(() => deliverPendingCapabilityTierChangeNotices(dataDir, () => {
        throw new Error('session persistence unavailable');
      })).toThrow('session persistence unavailable');

      const delivered: string[] = [];
      expect(deliverPendingCapabilityTierChangeNotices(
        dataDir,
        notice => delivered.push(notice),
      )).toBe(1);
      expect(delivered[0]).toContain('from "nursery" to "custom"');
      expect(deliverPendingCapabilityTierChangeNotices(dataDir, () => {})).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
