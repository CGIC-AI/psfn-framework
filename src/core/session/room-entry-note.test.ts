import { describe, expect, it } from 'vitest';

import type { AffordanceConfig, PlaceConfig } from '../../shared/contracts/places-registry.js';
import {
  ROOM_ENTRY_NOTE_SOURCE,
  appendRoomEntryNote,
  composeRoomEntryNote,
  type RoomEntryNoteInput,
} from './room-entry-note.js';

const perceiver = (
  overrides: Partial<AffordanceConfig> & Pick<AffordanceConfig, 'affordanceId' | 'kind'>,
): AffordanceConfig => ({
  role: 'perceiver',
  backend: 'satellite',
  ...overrides,
});

const effector = (
  overrides: Partial<AffordanceConfig> & Pick<AffordanceConfig, 'affordanceId' | 'kind'>,
): AffordanceConfig => ({
  role: 'effector',
  backend: 'ha',
  ...overrides,
});

describe('composeRoomEntryNote', () => {
  it('renders the full note: place, physical/virtual, surroundings, and multiple present', () => {
    const place: PlaceConfig = {
      placeId: 'place.living-room',
      siteId: 'site.house',
      displayName: 'Living Room',
      kind: 'physical',
      description: 'A warm room with a couch and a wide window.',
      affordances: [],
    };
    const affordances: AffordanceConfig[] = [
      perceiver({ affordanceId: 'a.presence', kind: 'presence', displayName: 'presence sensor' }),
      perceiver({ affordanceId: 'a.cam', kind: 'camera' }),
      effector({ affordanceId: 'a.light', kind: 'light', displayName: 'ceiling light' }),
      effector({ affordanceId: 'a.media', kind: 'media_player' }),
    ];
    const input: RoomEntryNoteInput = {
      roomChannelId: 'room.living-room',
      place,
      affordances,
      present: [
        { displayName: 'operator', kind: 'human' },
        { displayName: 'Companion B', kind: 'companion' },
      ],
    };

    const note = composeRoomEntryNote(input);

    expect(note).toBe(
      [
        '[Room entry]',
        'You have entered room room.living-room — Living Room (physical).',
        'A warm room with a couch and a wide window.',
        'This space can perceive you through presence sensor and camera.',
        'You can act on ceiling light and media player here.',
        'Also present: operator (human) and Companion B (companion).',
      ].join('\n'),
    );
  });

  it('is deterministic: identical input yields identical output', () => {
    const input: RoomEntryNoteInput = {
      roomChannelId: 'room.x',
      present: [{ displayName: 'operator', kind: 'human' }],
    };
    expect(composeRoomEntryNote(input)).toBe(composeRoomEntryNote(input));
  });

  it('renders the minimal note: no place, no affordances, empty present', () => {
    const note = composeRoomEntryNote({ roomChannelId: 'room.void', present: [] });

    expect(note).toBe(
      ['[Room entry]', 'You have entered room room.void.', 'No one else is here.'].join('\n'),
    );
  });

  it('labels a virtual place and omits an empty description line', () => {
    const note = composeRoomEntryNote({
      roomChannelId: 'room.plaza',
      place: {
        placeId: 'place.plaza',
        siteId: 'site.world',
        displayName: 'Central Plaza',
        kind: 'virtual',
        description: '   ',
      },
      present: [],
    });

    expect(note).toContain('Central Plaza (virtual).');
    expect(note).not.toContain('  \n');
    expect(note.split('\n')).toHaveLength(3);
  });

  it('phrases perceivers and effectors separately and humanizes bare kinds', () => {
    const note = composeRoomEntryNote({
      roomChannelId: 'room.lab',
      affordances: [
        effector({ affordanceId: 'a.vo', kind: 'virtual_object' }),
        perceiver({ affordanceId: 'a.mic', kind: 'mic' }),
      ],
      present: [],
    });

    expect(note).toContain('This space can perceive you through mic.');
    expect(note).toContain('You can act on virtual object here.');
    // Perceiver line precedes effector line regardless of input order.
    expect(note.indexOf('perceive you')).toBeLessThan(note.indexOf('act on'));
  });

  it('uses an Oxford comma for three or more present occupants', () => {
    const note = composeRoomEntryNote({
      roomChannelId: 'room.party',
      present: [
        { displayName: 'operator', kind: 'human' },
        { displayName: 'Companion B', kind: 'companion' },
        { displayName: 'Companion C', kind: 'companion' },
      ],
    });

    expect(note).toContain(
      'Also present: operator (human), Companion B (companion), and Companion C (companion).',
    );
  });
});

describe('appendRoomEntryNote', () => {
  it('delivers the composed note via the injected sink with the room channel and source tag', () => {
    const calls: Array<{ channelId: string; note: string; source: string }> = [];
    const sink = {
      appendContextSystemNote(channelId: string, note: string, source: string): void {
        calls.push({ channelId, note, source });
      },
    };
    const input: RoomEntryNoteInput = {
      roomChannelId: 'room.living-room',
      present: [{ displayName: 'operator', kind: 'human' }],
    };

    appendRoomEntryNote(sink, input);

    expect(calls).toHaveLength(1);
    expect(calls[0].channelId).toBe('room.living-room');
    expect(calls[0].source).toBe(ROOM_ENTRY_NOTE_SOURCE);
    expect(calls[0].note).toBe(composeRoomEntryNote(input));
  });
});
