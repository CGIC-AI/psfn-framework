import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_TIER_CHANGE_NOTICE_PROVENANCE_NOTE,
  buildCapabilityTierChange,
  deliverPendingCapabilityTierChangeNotices,
  enqueuePendingCapabilityTierChangeNotice,
  formatCapabilityTierChangeNotice,
  partitionFreshCapabilityTierChangeNotices,
  renderFreshCapabilityTierChangePromptBlock,
} from './change-notice.js';
import { resolvePendingCapabilityNoticesPath } from '../../persistence/layout.js';
import { buildAuthenticityProvenance } from '../../shared/authenticity-provenance.js';
import type { ContextMessage } from '../../shared/contracts/runtime-base.js';

function capabilityNoticeMessage(content: string): ContextMessage {
  return {
    role: 'system',
    content,
    provenance: buildAuthenticityProvenance({
      kind: 'system_note',
      sourceAuthor: 'system',
      transformedBy: 'system',
      wording: 'direct',
      directSpeech: false,
      detailLoss: 'none',
      emotionalTexture: 'unknown',
      safeAsPartnerSpeech: false,
      sourceSpanCount: 1,
      sourceEntryIds: [2],
      notes: [CAPABILITY_TIER_CHANGE_NOTICE_PROVENANCE_NOTE],
    }),
  };
}

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
    expect(notice).toContain('relay this exact status to your Partner');
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

  it('promotes only notices newer than the latest conversational history entry', () => {
    const fresh = capabilityNoticeMessage('fresh capability notice');
    const partitioned = partitionFreshCapabilityTierChangeNotices([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      fresh,
      { role: 'system', content: 'unrelated runtime note' },
    ]);

    expect(partitioned.noticeContents).toEqual(['fresh capability notice']);
    expect(partitioned.historicalMessages).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'system', content: 'unrelated runtime note' },
    ]);

    const historical = partitionFreshCapabilityTierChangeNotices([
      fresh,
      { role: 'user', content: 'question after the notice' },
      { role: 'assistant', content: 'answer after the notice' },
    ]);
    expect(historical.noticeContents).toEqual([]);
    expect(historical.historicalMessages).toHaveLength(3);
  });

  it('renders a fresh-event block with the authoritative live tier', () => {
    const block = renderFreshCapabilityTierChangePromptBlock(
      ['The Operator changed your capability tier from "autonomous" to "nursery".'],
      'nursery',
    );

    expect(block).toContain('<status>fresh_runtime_event</status>');
    expect(block).toContain('<current_live_tier>nursery</current_live_tier>');
    expect(block).toContain('mention the capability change directly');
    expect(block).toContain('from "autonomous" to "nursery"');
    expect(() => renderFreshCapabilityTierChangePromptBlock(['notice'], 'stale'))
      .toThrow('current live capability tier');
    expect(renderFreshCapabilityTierChangePromptBlock([], 'stale')).toBe('');
  });
});
