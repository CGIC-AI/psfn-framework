import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreMemoryStore, coreMemoryChannelScope } from './store.js';

describe('CoreMemoryStore', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  function makeStorePath(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(root);
    return join(root, 'core_memory.json');
  }

  it('initializes missing storage with default blocks and persists to disk', () => {
    const path = makeStorePath('psfn-core-memory-init-');
    const now = new Date('2026-03-05T12:00:00.000Z');
    const store = new CoreMemoryStore(path, { now: () => now });

    expect(existsSync(path)).toBe(true);

    const snapshot = store.getSnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.updatedAt).toBe(now.toISOString());
    expect(snapshot.scope?.key).toBe('channel:default');
    expect(snapshot.blocks.persona.content).toBe('');
    expect(snapshot.blocks.human.content).toBe('');
    expect(snapshot.blocks.goals.content).toBe('');

    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      version: number;
      scopes: Record<string, { blocks: Record<string, { content: string }> }>;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.scopes['channel:default'].blocks.persona.content).toBe('');
    expect(parsed.scopes['channel:default'].blocks.human.content).toBe('');
    expect(parsed.scopes['channel:default'].blocks.goals.content).toBe('');
  });

  it('appends to a block and persists across reload', () => {
    const path = makeStorePath('psfn-core-memory-append-');
    const store = new CoreMemoryStore(path);
    store.append('persona', 'Curious, patient, and practical.');
    store.append('persona', 'Prefers direct, factual collaboration.');

    const reloaded = new CoreMemoryStore(path);
    const block = reloaded.getBlock('persona');
    expect(block.content).toContain('Curious, patient, and practical.');
    expect(block.content).toContain('Prefers direct, factual collaboration.');
  });

  it('append keeps the newest tail when content exceeds maxChars', () => {
    const path = makeStorePath('psfn-core-memory-append-cap-');
    const store = new CoreMemoryStore(path);
    const goalsMax = store.getBlock('goals').maxChars;
    store.replace('goals', 'A'.repeat(goalsMax - 4));
    store.append('goals', 'BBBBBBBB');

    const goals = store.getBlock('goals');
    expect(goals.content.length).toBeLessThanOrEqual(goalsMax);
    expect(goals.content.endsWith('BBBBBBBB')).toBe(true);
  });

  it('rejects repeated raw matrix-orient timestamp logs from durable goals', () => {
    const path = makeStorePath('psfn-core-memory-goals-log-reject-');
    const store = new CoreMemoryStore(path);
    store.replace('goals', 'Maintain concise semantic sprint closeout goals.');
    store.append('goals', [
      'matrix orient 2026-05-11T03-54-10-841Z',
      'matrix orient 2026-05-11T03-58-02-112Z',
      'orient 2026-05-11T04:01:02.003Z',
      'Maintain concise semantic sprint closeout goals.',
    ].join('\n'));

    const goals = store.getBlock('goals').content;
    expect(goals).toBe('Maintain concise semantic sprint closeout goals.');
    expect(goals).not.toMatch(/matrix orient/i);
    expect(goals).not.toMatch(/2026-05-11T03-54-10-841Z/i);
    expect(goals.length).toBeLessThan(120);
  });

  it('summarizes timestamp-prefixed orient goal lines to semantic tails', () => {
    const path = makeStorePath('psfn-core-memory-goals-log-summarize-');
    const store = new CoreMemoryStore(path);
    store.replace('goals', [
      'matrix orient 2026-05-11T03-54-10-841Z: Finish memory closeout regressions.',
      'orient 2026-05-11T04:01:02.003Z - Keep scratchpad prompt context bounded.',
      'Keep runtime context honest.',
    ].join('\n'));

    expect(store.getBlock('goals').content).toBe([
      'Finish memory closeout regressions.',
      'Keep scratchpad prompt context bounded.',
      'Keep runtime context honest.',
    ].join('\n'));
  });

  it('replace truncates oversized content to block maxChars', () => {
    const path = makeStorePath('psfn-core-memory-replace-cap-');
    const store = new CoreMemoryStore(path);
    const personaMax = store.getBlock('persona').maxChars;
    const oversized = `start-${'X'.repeat(personaMax + 250)}`;
    store.replace('persona', oversized);

    const persona = store.getBlock('persona');
    expect(persona.content.length).toBeLessThanOrEqual(personaMax);
    expect(persona.content.startsWith('start-')).toBe(true);
  });

  it('rethink rewrites all orientation blocks in one snapshot', () => {
    const path = makeStorePath('psfn-core-memory-rethink-');
    const store = new CoreMemoryStore(path);
    const snapshot = store.rethink({
      persona: 'Analytical and collaborative.',
      human: 'Primary user prefers concise updates and direct answers.',
      goals: 'Finish Phase V core-memory wiring and tests.',
    });

    expect(snapshot.blocks.persona.content).toContain('Analytical');
    expect(snapshot.blocks.human.content).toContain('Primary user');
    expect(snapshot.blocks.goals.content).toContain('Phase V');

    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as {
      scopes: Record<string, { blocks: Record<string, { content: string }> }>;
    };
    expect(persisted.scopes['channel:default'].blocks.persona.content).toContain('Analytical');
    expect(persisted.scopes['channel:default'].blocks.human.content).toContain('Primary user');
    expect(persisted.scopes['channel:default'].blocks.goals.content).toContain('Phase V');
  });

  it('archives legacy global snapshots and does not inject them into scoped prompt context', () => {
    const path = makeStorePath('psfn-core-memory-load-goals-log-normalize-');
    writeFileSync(path, JSON.stringify({
      version: 1,
      updatedAt: '2026-05-11T04:00:00.000Z',
      blocks: {
        persona: { label: 'persona', content: 'Practical.', maxChars: 2400 },
        human: { label: 'human', content: 'Prefers concise work.', maxChars: 2400, trustLevel: 'trusted' },
        goals: {
          label: 'goals',
          content: [
            'matrix orient 2026-05-11T03-54-10-841Z',
            'orient 2026-05-11T04:01:02.003Z: Preserve semantic goals.',
          ].join('\n'),
          maxChars: 1600,
        },
      },
    }), 'utf-8');

    const store = new CoreMemoryStore(path);
    const context = store.formatForContext({ channelId: 'discord:room-1' });
    expect(context).toBe('');

    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as {
      version: number;
      legacyGlobal?: { snapshot: { blocks: Record<string, { content: string }> } };
    };
    expect(persisted.version).toBe(2);
    expect(persisted.legacyGlobal?.snapshot.blocks.goals.content).toContain('Preserve semantic goals.');
    expect(context).not.toContain('matrix orient 2026-05-11T03-54-10-841Z');
    expect(context).not.toContain('2026-05-11T04:01:02.003Z');
  });

  it('keeps channel-scoped orientation isolated and renders group context without human tag', () => {
    const path = makeStorePath('psfn-core-memory-scope-');
    const store = new CoreMemoryStore(path);
    const groupScope = coreMemoryChannelScope({ channelId: 'discord:room-a', isDirectMessage: false });
    const dmScope = coreMemoryChannelScope({ channelId: 'discord:dm-vega', isDirectMessage: true });

    store.rethink({
      persona: 'Room A local continuity.',
      human: 'Room A includes monastery debugging chatter.',
      goals: 'Keep room A continuity local.',
    }, { scope: groupScope });
    store.rethink({
      persona: 'DM local continuity.',
      human: 'Vega one-to-one context.',
      goals: 'Keep DM continuity local.',
    }, { scope: dmScope });

    const groupContext = store.formatForContext({
      channelId: 'discord:room-a',
      isDirectMessage: false,
      activeParticipantNames: ['Vega', 'Iku', 'Miss Dragon Fox', 'A', 'B', 'C'],
    });
    expect(groupContext).toContain('<room_context');
    expect(groupContext).toContain('active_participants="Vega, Iku, Miss Dragon Fox, A, B"');
    expect(groupContext).toContain('Room A local continuity.');
    expect(groupContext).not.toContain('<human>');
    expect(groupContext).not.toContain('DM local continuity.');

    const dmContext = store.formatForContext({
      channelId: 'discord:dm-vega',
      isDirectMessage: true,
      participantName: 'Vega',
    });
    expect(dmContext).toContain('<participant_context name="Vega"');
    expect(dmContext).toContain('DM local continuity.');
    expect(dmContext).not.toContain('Room A local continuity.');
    expect(dmContext).not.toContain('<human>');
  });

  it('throws on malformed persisted snapshot', () => {
    const path = makeStorePath('psfn-core-memory-invalid-');
    writeFileSync(path, JSON.stringify({ version: 1, updatedAt: '', blocks: {} }), 'utf-8');

    expect(() => new CoreMemoryStore(path)).toThrow('core memory updatedAt must be a non-empty string');
  });
});
