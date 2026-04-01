import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreMemoryStore } from './store.js';

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
    expect(snapshot.blocks.persona.content).toBe('');
    expect(snapshot.blocks.human.content).toBe('');
    expect(snapshot.blocks.goals.content).toBe('');

    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      blocks: Record<string, { content: string }>;
    };
    expect(parsed.blocks.persona.content).toBe('');
    expect(parsed.blocks.human.content).toBe('');
    expect(parsed.blocks.goals.content).toBe('');
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
      blocks: Record<string, { content: string }>;
    };
    expect(persisted.blocks.persona.content).toContain('Analytical');
    expect(persisted.blocks.human.content).toContain('Primary user');
    expect(persisted.blocks.goals.content).toContain('Phase V');
  });

  it('throws on malformed persisted snapshot', () => {
    const path = makeStorePath('psfn-core-memory-invalid-');
    writeFileSync(path, JSON.stringify({ version: 1, updatedAt: '', blocks: {} }), 'utf-8');

    expect(() => new CoreMemoryStore(path)).toThrow('core memory updatedAt must be a non-empty string');
  });
});
