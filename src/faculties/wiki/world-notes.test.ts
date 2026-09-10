import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isReservedManagedWikiWrite } from './personal-projects.js';
import { WikiStore } from './store.js';
import { WorldNotesLibrary, worldNotesDocId } from './world-notes.js';

describe('WorldNotesLibrary (2nsfo)', () => {
  let tempDir: string;
  let store: WikiStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'world-notes-'));
    store = new WikiStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('folds perceptions into landmarks, rooms and encounters, and moves into routes', () => {
    const library = new WorldNotesLibrary(store, () => new Date('2026-09-10T18:05:00.000Z'));
    library.observePerception({
      world: 'commons',
      capturedAt: '2026-09-10T18:00:00.000Z',
      self: { x: 1, z: 2 },
      room: { label: 'kitchen', labelled: true, waysOut: ['a door on its north to the hall'] },
      things: [{ id: 'ab12', label: 'wooden bench', x: 4.04, z: 1.02 }, { id: 'cd34', label: 'lantern' }],
      people: [{ id: '@visitor', x: 3.5, z: 1.5 }, { id: 'wanderer' }],
    });
    library.observePerception({
      world: 'commons',
      capturedAt: '2026-09-10T18:01:00.000Z',
      self: null,
      room: undefined,
      things: [{ id: 'ab12', label: 'wooden bench', x: 4, z: 1 }],
      people: [{ id: 'visitor', x: 3.6, z: 1.4, contactId: 'contact-1' }],
    });
    library.observeMove({ world: 'commons', from: 'eidoverse:commons', to: 'eidoverse:commons:plaza', at: '2026-09-10T18:02:00.000Z' });
    library.observeMove({ world: 'commons', from: 'eidoverse:commons', to: 'eidoverse:commons:plaza', at: '2026-09-10T18:03:00.000Z' });

    const notes = library.get('commons');
    expect(notes?.perceptions).toBe(2);
    const bench = notes?.landmarks.find((landmark) => landmark.id === 'thing:ab12');
    expect(bench).toMatchObject({ kind: 'thing', label: 'wooden bench', x: 4, z: 1, seenCount: 2 });
    expect(notes?.landmarks.find((landmark) => landmark.id === 'room:kitchen')).toMatchObject({
      kind: 'room', label: 'kitchen', x: 1, z: 2, waysOut: ['a door on its north to the hall'],
    });
    expect(notes?.landmarks.find((landmark) => landmark.id === 'thing:cd34')?.x).toBeUndefined();
    // The visitor is one encounter (the leading @ is stripped), near the bench, with the contact reference kept.
    const visitor = notes?.encounters.find((encounter) => encounter.participantId === 'visitor');
    expect(visitor).toMatchObject({ near: 'thing:ab12', count: 2, contactId: 'contact-1' });
    expect(notes?.routes).toEqual([{
      from: 'place:eidoverse:commons', to: 'place:eidoverse:commons:plaza',
      firstAt: '2026-09-10T18:02:00.000Z', lastAt: '2026-09-10T18:03:00.000Z', count: 2,
    }]);

    const summary = library.summarize('commons');
    expect(summary).toContain('rooms you have been in: kitchen');
    expect(summary).toContain('wooden bench at (4, 1)');
    expect(summary).toContain('routes you know: eidoverse:commons → eidoverse:commons:plaza');
    expect(summary).toContain('met here before: visitor near ab12');
    expect(library.summarize('nowhere')).toBe('');
    expect(library.listWorlds()).toEqual(['commons']);
  });

  it('keeps model notes bounded and in the reserved namespace the generic wiki write cannot touch', () => {
    const library = new WorldNotesLibrary(store, () => new Date('2026-09-10T18:05:00.000Z'));
    const note = library.addNote({ world: 'commons', text: '  The plaza is where people gather   at dusk. ', about: 'place:eidoverse:commons:plaza' });
    expect(note.text).toBe('The plaza is where people gather at dusk.');
    expect(library.get('commons')?.notes).toHaveLength(1);
    expect(library.summarize('commons')).toContain('your notes: "The plaza is where people gather at dusk."');
    expect(() => library.addNote({ world: 'Not A World', text: 'x' })).toThrow(/world-name grammar/u);
    expect(() => library.addNote({ world: 'commons', text: '   ' })).toThrow(/note text is required/u);

    const document = store.get(worldNotesDocId('commons'));
    expect(document?.sourceClass).toBe('generated_synthesis');
    expect(document?.tags).toContain('world-notes');
    expect(isReservedManagedWikiWrite({ documentId: worldNotesDocId('commons') })).toBe(true);
    expect(isReservedManagedWikiWrite({ documentId: 'travel-diary', tags: ['world-notes'] })).toBe(true);
    expect(isReservedManagedWikiWrite({ documentId: 'travel-diary', tags: ['diary'] })).toBe(false);
  });

  it('ignores a malformed world name and survives a corrupted document', () => {
    const library = new WorldNotesLibrary(store);
    library.observePerception({ world: 'Bad World', capturedAt: 'now', self: null, room: undefined, things: [], people: [] });
    expect(library.listWorlds()).toEqual([]);
    store.upsert({ id: worldNotesDocId('garden'), title: 'World notes: garden', body: '{not json', tags: ['world-notes'] });
    expect(library.get('garden')).toBeUndefined();
    library.observeMove({ world: 'garden', to: 'eidoverse:garden', at: '2026-09-10T18:00:00.000Z' });
    expect(library.get('garden')?.landmarks.map((landmark) => landmark.id)).toEqual(['place:eidoverse:garden']);
  });
});
