import { describe, expect, it } from 'vitest';
import { mapContactRow, mapMemoryRow, type ContactRow, type MemoryRow } from './row-mappers.js';

describe('row mappers', () => {
  it('maps memory rows with defaults and parsed JSON fields', () => {
    const row: MemoryRow = {
      id: 'mem-1',
      text: 'memory text',
      type: 'semantic',
      importance: 0.8,
      confidence: 0.9,
      emotional_valence: 0.2,
      salience: 0.7,
      source_ref: 'test:source',
      extracted_at: 1000,
      last_accessed: 2000,
      access_count: 3,
      superseded_by: null,
      tags: '["one","two"]',
      sensitivity: null,
      consent_flags: null,
    };

    const mapped = mapMemoryRow(row);
    expect(mapped.sensitivity).toBe('personal');
    expect(mapped.consentFlags).toEqual({});
    expect(mapped.tags).toEqual(['one', 'two']);
    expect(mapped.supersededBy).toBeUndefined();
  });

  it('maps contact rows with nullable fields normalized', () => {
    const row: ContactRow = {
      id: 'contact-1',
      discord_user_id: null,
      display_name: 'V',
      trust_level: 'primary',
      relationship_type: 'partner',
      emotional_baseline: '{"warmth":0.8}',
      first_seen: '2026-01-01T00:00:00.000Z',
      last_seen: '2026-01-02T00:00:00.000Z',
      notes: null,
    };

    const mapped = mapContactRow(row);
    expect(mapped.discordUserId).toBeUndefined();
    expect(mapped.notes).toBeUndefined();
    expect(mapped.emotionalBaseline).toEqual({ warmth: 0.8 });
  });

  it('normalizes consent flag schema fields from JSON', () => {
    const row: MemoryRow = {
      id: 'mem-2',
      text: 'memory text',
      type: 'semantic',
      importance: 0.8,
      confidence: 0.9,
      emotional_valence: 0.2,
      salience: 0.7,
      source_ref: 'test:source',
      extracted_at: 1000,
      last_accessed: 2000,
      access_count: 3,
      superseded_by: null,
      tags: '[]',
      sensitivity: 'personal',
      consent_flags: '{"allowRecall":false,"allowAbstraction":true,"deleteOnRequest":true,"redactionBehavior":"abstract","unknown":"x"}',
    };

    const mapped = mapMemoryRow(row);
    expect(mapped.consentFlags).toEqual({
      allowRecall: false,
      allowAbstraction: true,
      deleteOnRequest: true,
      redactionBehavior: 'abstract',
    });
  });
});
