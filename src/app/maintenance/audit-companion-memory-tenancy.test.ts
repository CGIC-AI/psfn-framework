import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionsDir } from '../../persistence/layout.js';
import { createAuditRoomMembershipAuthority } from './audit-companion-memory-tenancy.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-memory-tenancy-audit-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('companion memory tenancy audit room authority', () => {
  it('accepts only exact channel/session bindings backed by an existing journal', () => {
    const dataDir = createRoot();
    const sessionsDir = resolveSessionsDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'room-kitchen.jsonl'), `${JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'companion-room:kitchen',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    })}\n`);
    writeFileSync(join(sessionsDir, '_channel_index.json'), JSON.stringify({
      version: 5,
      channels: {
        'room-kitchen-local': {
          channelId: 'companion-room:kitchen',
          filename: 'room-kitchen.jsonl',
          filenames: ['room-kitchen.jsonl'],
        },
        'missing-journal': {
          channelId: 'companion-room:forged',
          filename: 'missing.jsonl',
          filenames: ['missing.jsonl'],
        },
      },
    }));

    const authority = createAuditRoomMembershipAuthority(dataDir);

    expect(authority.isAuthenticatedMember({
      channelId: 'companion-room:kitchen',
      sessionId: 'room-kitchen-local',
    })).toBe(true);
    expect(authority.isAuthenticatedMember({
      channelId: 'companion-room:kitchen',
      sessionId: 'forged-session',
    })).toBe(false);
    expect(authority.isAuthenticatedMember({
      channelId: 'companion-room:forged',
      sessionId: 'missing-journal',
    })).toBe(false);
  });

  it('rejects a raw index claim whose journal does not bind the claimed channel', () => {
    const dataDir = createRoot();
    const sessionsDir = resolveSessionsDir(dataDir);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'forged.jsonl'), `${JSON.stringify({
      type: 'message',
      id: 1,
      channelId: 'companion-room:other',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    })}\n`);
    writeFileSync(join(sessionsDir, '_channel_index.json'), JSON.stringify({
      version: 5,
      channels: {
        forged: {
          channelId: 'companion-room:claimed',
          filename: 'forged.jsonl',
          filenames: ['forged.jsonl'],
        },
      },
    }));

    expect(createAuditRoomMembershipAuthority(dataDir).isAuthenticatedMember({
      channelId: 'companion-room:claimed',
      sessionId: 'forged',
    })).toBe(false);
  });
});
