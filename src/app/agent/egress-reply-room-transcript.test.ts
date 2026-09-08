import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from '../../persistence/sessions/store.js';
import { PassiveNameCandidateBuilder } from '../../core/participation/passive-name-candidate.js';
import type { ChannelDisclosureContext } from '../../system/trust/policy.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import {
  createAgentLoopEgressReplySender,
  type EgressReplyRoomTranscriptPort,
} from './egress-reply-sender.js';
import type { EgressReplyDeliveryRequest } from '../../core/agent/arbiter/egress-lease-phase.js';

/**
 * jp36.5.6: the companion's own delivered autonomous room reply must land on the
 * ROOM's durable transcript, so the next follow-up is appraised against a
 * conversation the companion is visibly part of. Exercised against a real
 * `SessionStore` because the transcript is durable state: the entry must survive
 * a restart, appear exactly once, and never be duplicated by a re-drive.
 */

const ROOM = 'discord:guild-1:general';
const PUBLIC_DISCLOSURE: ChannelDisclosureContext = { channelPrivacy: 'public', broadcast: false };

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeSessionsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-egress-transcript-'));
  roots.push(root);
  return join(root, 'sessions');
}

function roomTranscriptPort(store: SessionStore): EgressReplyRoomTranscriptPort {
  return {
    recordCompanionRoomReply: (entry) => {
      store.append({
        channelId: entry.channelId,
        role: 'assistant',
        content: entry.content,
        timestamp: entry.timestampMs,
        channelVisibility: entry.channelVisibility,
      });
    },
  };
}

function makeRequest(sourceEventId: string, content: string): EgressReplyDeliveryRequest {
  return {
    reservation: {} as EgressReplyDeliveryRequest['reservation'],
    lease: {} as EgressReplyDeliveryRequest['lease'],
    appraisal: { action: 'reply', reasonCode: 'addressed', confidence: 0.9 },
    trigger: {
      kind: 'inbound_room_message',
      channelId: ROOM,
      channelType: 'discord',
      sourceEventId,
      authorId: 'human-1',
      authorName: 'Sam',
      content,
      occurredAtMs: 1_000,
    },
    nowMs: 2_000,
  };
}

describe('autonomous room reply on the durable room transcript', () => {
  it('appears exactly once, survives a restart, and is not duplicated by a re-drive', async () => {
    const sessionsDir = makeSessionsDir();
    const store = new SessionStore(sessionsDir);
    store.append({
      channelId: ROOM,
      role: 'user',
      content: 'is the migration done?',
      authorId: 'human-1',
      authorName: 'Sam',
      timestamp: 1_700_000_000_000,
    });

    let clock = 1_700_000_001_000;
    const delivery = { send: vi.fn(async () => undefined) };
    const sender = createAgentLoopEgressReplySender({
      generator: {
        handleMessage: vi.fn(async () => ({ content: 'Not yet — running it now.' } as AgentResponse)),
      },
      delivery,
      companionName: 'Persephone',
      outboundReplyGuard: new OutboundReplyDeduper(),
      resolveDestinationDisclosure: () => PUBLIC_DISCLOSURE,
      roomTranscript: roomTranscriptPort(store),
      now: () => clock,
    });

    expect((await sender.deliver(makeRequest('evt-1', 'is the migration done?'))).outcome)
      .toBe('delivered');
    clock += 1_000;
    // A post-TTL re-drive of the SAME trigger event: fenced before regeneration.
    expect((await sender.deliver(makeRequest('evt-1', 'is the migration done?'))).outcome)
      .toBe('delivered');
    expect(delivery.send).toHaveBeenCalledTimes(1);

    // Reopen the store the way a restart would.
    const reloaded = new SessionStore(sessionsDir);
    const recent = reloaded.getRecent(ROOM, 10);
    expect(recent.map(entry => [entry.role, entry.content])).toEqual([
      ['user', 'is the migration done?'],
      ['assistant', 'Not yet — running it now.'],
    ]);
    expect(recent[1]?.channelVisibility).toBe('public');
  });

  it('puts the companion\'s own turn into the next candidate\'s preceding transcript', async () => {
    const sessionsDir = makeSessionsDir();
    const store = new SessionStore(sessionsDir);
    store.append({
      channelId: ROOM,
      role: 'user',
      content: 'Persephone is the migration done?',
      authorId: 'human-1',
      authorName: 'Sam',
      timestamp: 1_700_000_000_000,
      discordMessageId: 'msg-1',
    });

    const sender = createAgentLoopEgressReplySender({
      generator: {
        handleMessage: vi.fn(async () => ({ content: 'Not yet — running it now.' } as AgentResponse)),
      },
      delivery: { send: vi.fn(async () => undefined) },
      companionName: 'Persephone',
      outboundReplyGuard: new OutboundReplyDeduper(),
      resolveDestinationDisclosure: () => PUBLIC_DISCLOSURE,
      roomTranscript: roomTranscriptPort(store),
      now: () => 1_700_000_001_000,
    });
    await sender.deliver(makeRequest('evt-1', 'Persephone is the migration done?'));

    const builder = new PassiveNameCandidateBuilder({
      scopeClassifier: { classifyChannelMemoryScope: async () => 'group' },
      contextReader: store,
      companionNames: ['Persephone'],
      companionAuthorIds: ['companion-account'],
      nowMs: () => 1_700_000_002_000,
    });
    const followUp: SubstrateMessage = {
      id: 'msg-2',
      channelId: ROOM,
      channelType: 'discord',
      authorId: 'human-1',
      authorName: 'Sam',
      content: 'thanks Persephone, ping me when it lands',
      timestamp: new Date(1_700_000_002_000),
      isDirectMessage: false,
    };
    const decision = await builder.build(followUp);
    expect(decision.status).toBe('created');
    if (decision.status !== 'created') throw new Error('unreachable');

    // Before this fix the companion's own delivered reply was absent here, and
    // the appraiser saw a conversation it appeared to have no part in.
    expect(decision.candidate.precedingContext.map(entry => entry.content)).toEqual([
      'Persephone is the migration done?',
      'Not yet — running it now.',
    ]);
  });
});
