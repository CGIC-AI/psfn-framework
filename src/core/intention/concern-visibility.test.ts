import { describe, expect, it } from 'vitest';
import type { ActiveConcern } from '../../shared/contracts/intention-contracts.js';
import { filterConcernsForViewer } from './concern-visibility.js';

function concern(id: string, overrides: Partial<ActiveConcern> = {}): ActiveConcern {
  return {
    id,
    text: `thread ${id}`,
    priority: 'medium',
    source: 'agent',
    status: 'active',
    createdAt: '2026-09-25T00:00:00.000Z',
    expiresAt: '2026-09-26T00:00:00.000Z',
    salience: 0.5,
    sensitivity: 'personal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    ...overrides,
  } as ActiveConcern;
}

const PRIVATE_ROOM = { channelPrivacy: 'private' as const, broadcast: false };

describe('filterConcernsForViewer (xz8m1)', () => {
  const threads = [
    concern('other-conversation-thread', { contactId: 'contact-jordan-friend' }),
    concern('companion-wide-personal'),
    concern('companion-wide-public', { sensitivity: 'public' }),
    concern('confidential', { sensitivity: 'confidential' }),
    concern('redacted-evidence', { sensitivity: 'public', evidenceRefs: [{ kind: 'message', ref: 'm1', redacted: true }] }),
  ];

  it('renders only public, companion-wide threads for a public stranger in a fresh room', () => {
    const visible = filterConcernsForViewer(threads, { trustLevel: 'public', channelDisclosure: PRIVATE_ROOM });
    expect(visible.map(item => item.id)).toEqual(['companion-wide-public']);
  });

  it("keeps another contact's thread out even when its sensitivity would be allowed", () => {
    const visible = filterConcernsForViewer(threads, {
      trustLevel: 'trusted',
      channelDisclosure: PRIVATE_ROOM,
      canonicalContactKey: 'contact-someone-else',
    });
    expect(visible.map(item => item.id)).toEqual(['companion-wide-personal', 'companion-wide-public']);
  });

  it("shows the current contact's own personal thread to that contact", () => {
    const visible = filterConcernsForViewer(threads, {
      trustLevel: 'trusted',
      channelDisclosure: PRIVATE_ROOM,
      canonicalContactKey: 'contact-jordan-friend',
    });
    expect(visible.map(item => item.id)).toContain('other-conversation-thread');
    expect(visible.map(item => item.id)).not.toContain('confidential');
  });

  it('lets a primary viewer in a private room see every non-redacted thread', () => {
    const visible = filterConcernsForViewer(threads, { trustLevel: 'primary', channelDisclosure: PRIVATE_ROOM });
    expect(visible.map(item => item.id)).toEqual([
      'other-conversation-thread',
      'companion-wide-personal',
      'companion-wide-public',
      'confidential',
    ]);
  });

  it('withholds personal threads on a broadcast surface even for primary trust', () => {
    const visible = filterConcernsForViewer(threads, {
      trustLevel: 'primary',
      channelDisclosure: { channelPrivacy: 'public', broadcast: true },
    });
    expect(visible.map(item => item.id)).toEqual(['companion-wide-public']);
  });
});
