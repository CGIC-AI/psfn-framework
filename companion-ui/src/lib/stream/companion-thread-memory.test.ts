import { describe, expect, it, vi } from 'vitest';
import { buildSatelliteHello } from '../api/auth.js';
import type { HubToClientMessage } from '../protocol/events.js';
import { CompanionThreadMemory } from './companion-thread-memory.js';
import {
  createInitialHubStreamState,
  HubStreamStore,
  reduceHubStreamState,
  type HubStreamClientLike,
  type HubStreamMessage,
  type HubStreamState,
} from './hub-stream.js';

const AT = '2026-09-07T12:00:00.000Z';

function message(content: string, overrides: Partial<HubStreamMessage> = {}): HubStreamMessage {
  return {
    id: 'old-session:8:assistant',
    role: 'assistant',
    content,
    live: false,
    final: true,
    sequence: 8,
    receivedAt: AT,
    sessionId: 'old-session',
    channelId: 'old-channel',
    ...overrides,
  };
}

function thread(content: string): HubStreamState {
  return {
    ...createInitialHubStreamState(AT),
    session: { sessionId: 'old-session', channelId: 'old-channel' },
    messages: [message(content)],
  };
}

function inbound(state: HubStreamState, event: HubToClientMessage): HubStreamState {
  return reduceHubStreamState(state, { type: 'hub.inbound', at: AT, event: { message: event } });
}

describe('CompanionThreadMemory', () => {
  it('restores only finalized text in fresh stream state with no old authority or live state', () => {
    const memory = new CompanionThreadMemory();
    const state: HubStreamState = {
      ...thread('Final answer'),
      connection: 'ready',
      phase: 'responding',
      status: 'private status',
      sequence: Number.MAX_SAFE_INTEGER,
      liveUser: message('unfinished user', { role: 'user', live: true, final: false }),
      liveAssistant: message('unfinished answer', { live: true, final: false }),
      failure: { message: 'old failure', recoverable: false, at: AT },
      approvals: [{ id: 'approval', title: 'Old approval', requestedAt: AT, redactedContext: '', status: 'pending' }],
      approvalResolutions: { old: { status: 'approved', resolvedAt: AT } },
      artifacts: [{ id: 'artifact', label: 'Old file', mediaType: 'text/plain', provenance: 'tool', createdAt: AT, previewable: true }],
      artifactPreviews: { artifact: { status: 'ready', requestId: 'request', data: 'private' } },
      toolActivity: [{ id: 'tool', tool: 'search', phase: 'started', timestamp: AT, sequence: 6, receivedAt: AT }],
      voicePlayback: { ...createInitialHubStreamState(AT).voicePlayback, supported: true },
    };
    state.messages.push(
      message('Unfinalized', { final: false }),
      message('Live', { live: true }),
      message('Next question', { role: 'user', sequence: Number.NaN }),
    );
    memory.save('companion-a', state);

    expect(memory.restore('companion-a', AT)).toEqual({
      ...createInitialHubStreamState(AT),
      messages: [
        { id: 'remembered:1:assistant', role: 'assistant', content: 'Final answer', receivedAt: AT, sequence: 1, live: false, final: true },
        { id: 'remembered:2:user', role: 'user', content: 'Next question', receivedAt: AT, sequence: 2, live: false, final: true },
      ],
      sequence: 2,
    });
  });

  it('isolates companions and copies snapshots on save and restore', () => {
    const memory = new CompanionThreadMemory();
    const source = thread('First companion');
    memory.save('companion-a', source);
    memory.save('companion-b', thread('Second companion'));
    source.messages[0]!.content = 'Changed source';
    source.messages.push(message('Later source entry'));
    const restored = memory.restore('companion-a');
    restored.messages[0]!.content = 'Changed restore';
    restored.messages.push(message('Later restore entry'));

    expect(memory.restore('companion-a').messages.map(({ content }) => content)).toEqual(['First companion']);
    expect(memory.restore('companion-b').messages.map(({ content }) => content)).toEqual(['Second companion']);
    expect(memory.restore('unknown', AT)).toEqual(createInitialHubStreamState(AT));
  });

  it('replaces a snapshot rather than accumulating it and removes an empty transcript', () => {
    const memory = new CompanionThreadMemory();
    memory.save('companion-a', thread('First version'));
    memory.save('companion-a', thread('Second version'));
    expect(memory.restore('companion-a').messages.map(({ content }) => content)).toEqual(['Second version']);

    memory.save('companion-a', createInitialHubStreamState(AT));
    expect(memory.restore('companion-a', AT)).toEqual(createInitialHubStreamState(AT));
  });

  it('never overwrites a companion transcript with a selected shard or its empty loading state', () => {
    const memory = new CompanionThreadMemory();
    memory.save('companion-a', thread('Main thread'));
    const shard = { ...thread('Server shard history'), session: { activeShardId: 'shard-1' } };
    memory.save('companion-a', shard);
    memory.save('companion-b', shard);
    memory.save('companion-a', { ...shard, messages: [] });

    expect(memory.restore('companion-a').messages.map(({ content }) => content)).toEqual(['Main thread']);
    expect(memory.restore('companion-b').messages).toEqual([]);
  });

  it('prunes removed roster companions and clears all snapshots at the owner lifetime boundary', () => {
    const memory = new CompanionThreadMemory();
    memory.save('companion-a', thread('First companion'));
    memory.save('companion-b', thread('Second companion'));
    memory.retain(['companion-b']);
    expect(memory.restore('companion-a').messages).toEqual([]);
    expect(memory.restore('companion-b').messages).toHaveLength(1);
    memory.clear();
    expect(memory.restore('companion-b', AT)).toEqual(createInitialHubStreamState(AT));
  });

  it('supports new-store initialization and fresh messages while shard selection takes precedence', () => {
    const memory = new CompanionThreadMemory();
    memory.save('companion-a', thread('Remembered answer'));
    const client: HubStreamClientLike = {
      on: () => () => undefined,
      connect: async () => undefined,
      disconnect: vi.fn(),
      sendUserText: vi.fn(),
      interrupt: vi.fn(),
      sendApprovalDecision: vi.fn(),
      sendArtifactPreviewRequest: vi.fn(),
      sendTouchInteraction: vi.fn(),
      sendDeviceLocation: vi.fn(),
      snapshot: () => ({
        state: 'idle', ready: false, url: 'wss://hub.example.test/',
        hello: buildSatelliteHello(), session: {},
      }),
    };
    const store = new HubStreamStore(client, memory.restore('companion-a', AT));
    let state = reduceHubStreamState(store.snapshot(), {
      type: 'client.session', at: AT,
      session: { sessionId: 'new-session', channelId: 'new-channel' },
    });
    state = inbound(state, { type: 'message', data: { role: 'assistant', content: 'New answer', final: true } });
    expect(state.messages.map(({ content }) => content)).toEqual(['Remembered answer', 'New answer']);
    expect(new Set(state.messages.map(({ id }) => id)).size).toBe(2);
    expect(state.messages.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(state.messages[1]?.sessionId).toBe('new-session');

    state = reduceHubStreamState(state, {
      type: 'client.session', at: AT,
      session: { sessionId: 'new-session', channelId: 'new-channel', activeShardId: 'shard-1' },
    });
    expect(state.messages).toEqual([]);
    state = inbound(state, { type: 'message', data: { role: 'assistant', content: 'Server shard history', final: true } });
    expect(state.messages.map(({ content }) => content)).toEqual(['Server shard history']);
  });
});
