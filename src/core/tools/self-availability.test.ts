import { describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import { executeSelfAvailabilityAction } from './self-availability.js';

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map(part => part.text).join('');
}

function runtime(): AgentFacingIcpAutonomyRuntime {
  return {
    resolveKnownPeer: vi.fn(),
    readKnownPeerAvailability: vi.fn(),
    listKnownPeerAvailability: vi.fn().mockResolvedValue([{
      contactId: 'peer-b',
      displayName: 'Peer B',
      peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      availability: {
        peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        connectionState: 'online',
        eligible: false,
        reasonCode: 'peer_busy',
        lease: {
          companionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          state: 'busy',
          issuedAtMs: 9_000,
          expiresAtMs: 20_000,
          source: 'runtime',
          revision: 2,
        },
      },
    }]),
    readOwnAvailability: vi.fn().mockResolvedValue({
      eligible: false,
      reasonCode: 'peer_do_not_disturb',
      control: 'operator_override',
      mutableByCompanion: false,
      lease: {
        companionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        state: 'do_not_disturb',
        issuedAtMs: 9_000,
        expiresAtMs: 20_000,
        source: 'operator',
        revision: 3,
      },
    }),
    publishOwnAvailability: vi.fn().mockImplementation(async input => ({
      companionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      issuedAtMs: 10_000,
      source: 'companion',
      ...input,
    })),
    clearOwnAvailability: vi.fn().mockResolvedValue({ cleared: true }),
    prepareCompanionOutreach: vi.fn(),
    executeCompanionOutreach: vi.fn(),
  };
}

describe('self availability semantic actions', () => {
  it('explains authoritative operator overrides on own availability', async () => {
    const result = await executeSelfAvailabilityAction({
      runtime: runtime(),
      params: { action: 'availability_read' },
    });
    expect(JSON.parse(text(result))).toMatchObject({
      action: 'availability_read',
      control: 'operator_override',
      mutableByCompanion: false,
      lease: { source: 'operator', state: 'do_not_disturb' },
    });
  });

  it('strictly validates publish TTL, revision, and action-specific keys', async () => {
    const owner = runtime();
    const result = await executeSelfAvailabilityAction({
      runtime: owner,
      nowMs: 10_000,
      params: {
        action: 'availability_publish',
        state: 'open_to_chat',
        expires_at_ms: 20_000,
        revision: 4,
      },
    });
    expect(JSON.parse(text(result))).toMatchObject({ status: 'published', lease: { revision: 4 } });
    expect(owner.publishOwnAvailability).toHaveBeenCalledWith({
      state: 'open_to_chat',
      expiresAtMs: 20_000,
      revision: 4,
    });

    const mixed = await executeSelfAvailabilityAction({
      runtime: owner,
      nowMs: 10_000,
      params: {
        action: 'availability_publish',
        state: 'open_to_chat',
        expires_at_ms: 20_000,
        revision: 4,
        expected_revision: 3,
      },
    });
    expect(mixed.details.isError).toBe(true);
    expect(text(mixed)).toMatch(/unknown key.*expected_revision/i);
  });

  it('lists only redacted contact-derived peer availability', async () => {
    const result = await executeSelfAvailabilityAction({
      runtime: runtime(),
      params: { action: 'availability_list_peers' },
    });
    const parsed = JSON.parse(text(result));
    expect(parsed.peers).toEqual([expect.objectContaining({
      contactId: 'peer-b',
      displayName: 'Peer B',
      eligible: false,
      reasonCode: 'peer_busy',
      source: 'runtime',
    })]);
    expect(text(result)).not.toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('blocks social-graph listing from ICP-correlated turns before any lookup', async () => {
    const owner = runtime();
    const result = await runWithRequestContext({ icpCorrelation: {} as never }, async () => (
      await executeSelfAvailabilityAction({
        runtime: owner,
        params: { action: 'availability_list_peers' },
      })
    ));
    expect(result.details.isError).toBe(true);
    expect(text(result)).toMatch(/blocked during an ICP-correlated turn/i);
    expect(owner.listKnownPeerAvailability).not.toHaveBeenCalled();
  });
});
