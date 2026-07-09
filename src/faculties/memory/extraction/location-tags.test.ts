import { describe, expect, it } from 'vitest';
import { LOCATION_TAG_PREFIX, applyLocationTag, buildLocationTag } from './location-tags.js';

describe('buildLocationTag', () => {
  it('builds a location:<placeId> tag for a resolved place', () => {
    expect(buildLocationTag('living_room')).toBe(`${LOCATION_TAG_PREFIX}living_room`);
  });

  it('trims surrounding whitespace on the placeId', () => {
    expect(buildLocationTag('  kitchen  ')).toBe('location:kitchen');
  });

  it('returns undefined for an absent place (fail-closed, no fabrication)', () => {
    expect(buildLocationTag(undefined)).toBeUndefined();
    expect(buildLocationTag(null)).toBeUndefined();
    expect(buildLocationTag('')).toBeUndefined();
    expect(buildLocationTag('   ')).toBeUndefined();
  });
});

describe('applyLocationTag', () => {
  it('appends the location tag when a place is bound', () => {
    expect(applyLocationTag([], 'living_room')).toEqual(['location:living_room']);
  });

  it('is additive to existing tags and preserves their order', () => {
    expect(applyLocationTag(['identity', 'profession'], 'office')).toEqual([
      'identity',
      'profession',
      'location:office',
    ]);
  });

  it('returns a copy of the tags unchanged when no place is bound', () => {
    const input = ['identity', 'profession'];
    const result = applyLocationTag(input, undefined);
    expect(result).toEqual(['identity', 'profession']);
    expect(result).not.toBe(input);
  });

  it('never mutates the input array', () => {
    const input = ['identity'];
    applyLocationTag(input, 'garden');
    expect(input).toEqual(['identity']);
  });
});
