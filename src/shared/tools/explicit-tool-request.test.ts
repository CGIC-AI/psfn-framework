import { describe, expect, it } from 'vitest';
import { resolveExplicitToolRequestSequence } from './explicit-tool-request.js';

// The r4 shakedown selfie_create request (r27lc).
const R4_SELFIE_REQUEST = 'selfie_create is a core tool that is already active — call it directly and do not'
  + ' wait for or depend on a toolset activation handshake. Call selfie_create with provider "openrouter",'
  + ' prompt "close portrait, direct eye contact, neutral lighting, plain background", width 512, height 512,'
  + ' aspect_ratio "1:1", num_images 1. Return only a JSON object with keys worked and note.';

describe('resolveExplicitToolRequestSequence sentence scoping (r27lc)', () => {
  it('reads a directive that opens a sentence apart from a negation in the previous sentence', () => {
    expect(resolveExplicitToolRequestSequence(R4_SELFIE_REQUEST, ['selfie_create', 'toolset']))
      .toEqual(['selfie_create']);
    expect(resolveExplicitToolRequestSequence(
      'Do not wait for anything. Call north_star to append this decision.',
      ['north_star'],
    )).toEqual(['north_star']);
  });

  it('still honours a negation inside the directive sentence itself', () => {
    expect(resolveExplicitToolRequestSequence(
      'Keep going. Do not call north_star for this.',
      ['north_star'],
    )).toEqual([]);
    expect(resolveExplicitToolRequestSequence(
      'Call north_star without touching the plan.',
      ['north_star'],
    )).toEqual([]);
  });

  it('does not let a negation in the following sentence cancel the directive', () => {
    expect(resolveExplicitToolRequestSequence(
      'Call north_star now. Do not reply with prose.',
      ['north_star'],
    )).toEqual(['north_star']);
  });
});
