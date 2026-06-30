import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRouteStore } from './session-routes.js';

describe('SessionRouteStore', () => {
  function withTempFile(test: (filePath: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-routes-'));
    try {
      test(join(dir, 'state', 'session-routes.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('persists active logical routes and retired session quarantine state', () => {
    withTempFile((filePath) => {
      const store = new SessionRouteStore(filePath, {
        now: () => new Date('2026-06-30T12:00:00.000Z'),
      });

      const result = store.resetSourceChannel({
        sourceChannelId: 'discord:guild:room',
        actor: 'operator',
        reason: 'poisoned context reset',
        mode: 'break_glass_quarantine',
      });

      expect(result.oldLogicalSessionId).toBe('discord:guild:room');
      expect(result.newLogicalSessionId).toMatch(
        /^discord:guild:room:session:20260630T120000Z-[0-9a-f-]{8}$/,
      );
      expect(store.resolve('discord:guild:room')).toBe(result.newLogicalSessionId);
      expect(store.resolveSourceChannelId(result.newLogicalSessionId)).toBe('discord:guild:room');
      expect(store.resolveSourceChannelId('discord:guild:room')).toBe('discord:guild:room');
      expect(store.isRetiredOrQuarantined('discord:guild:room')).toBe(true);
      expect(store.getRetiredLogicalSessionIds()).toEqual(new Set(['discord:guild:room']));

      const reloaded = new SessionRouteStore(filePath);
      expect(reloaded.resolve('discord:guild:room')).toBe(result.newLogicalSessionId);
      expect(reloaded.resolveSourceChannelId(result.newLogicalSessionId)).toBe('discord:guild:room');
      expect(reloaded.isRetiredOrQuarantined('discord:guild:room')).toBe(true);
      expect(reloaded.getRoute('discord:guild:room')?.retiredSessions[0]).toMatchObject({
        logicalSessionId: 'discord:guild:room',
        actor: 'operator',
        reason: 'poisoned context reset',
        mode: 'break_glass_quarantine',
      });
    });
  });

  it('fails closed when persisted route state contains unknown fields', () => {
    withTempFile((filePath) => {
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        updatedAt: '2026-06-30T12:00:00.000Z',
        routes: {},
        legacyShortcut: true,
      }), 'utf-8');

      expect(() => new SessionRouteStore(filePath)).toThrow(
        'session route state contains unknown field "legacyShortcut"',
      );
    });
  });
});
