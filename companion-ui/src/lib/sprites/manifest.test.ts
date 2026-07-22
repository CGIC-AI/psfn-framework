import { describe, expect, it } from 'vitest';
import {
  EMOTIONAL_BASES,
  FRAME_COUNTS,
  SPRITE_CROPS,
  TOOL_DOMAINS,
  TOOL_PHASES,
  TOUCH_REACTIONS,
  expressionEntryId,
  toolEntryId,
  touchEntryId,
} from './taxonomy.js';
import {
  assertSpriteManifest,
  buildSpriteManifest,
  frameRect,
  loadSpriteManifest,
  SPRITE_MANIFEST_PATH,
} from './manifest.js';

describe('buildSpriteManifest', () => {
  const manifest = buildSpriteManifest();

  it('emits every taxonomy id and nothing else', () => {
    const expected = new Set<string>();
    for (const crop of SPRITE_CROPS) {
      for (const base of EMOTIONAL_BASES) expected.add(expressionEntryId(base, crop));
    }
    for (const domain of TOOL_DOMAINS) {
      for (const phase of TOOL_PHASES) expected.add(toolEntryId(domain, phase));
    }
    for (const reaction of TOUCH_REACTIONS) expected.add(touchEntryId(reaction));

    expect(new Set(Object.keys(manifest.entries))).toEqual(expected);
    // 16 bases x 2 crops + 7 domains x 3 phases + 3 touch = 32 + 21 + 3.
    expect(Object.keys(manifest.entries)).toHaveLength(56);
  });

  it('gives each entry the frame count its family specifies', () => {
    for (const entry of Object.values(manifest.entries)) {
      if (entry.kind === 'expression') expect(entry.frames).toHaveLength(FRAME_COUNTS.expression);
      else if (entry.kind === 'touch') expect(entry.frames).toHaveLength(FRAME_COUNTS.touch);
      else if (entry.phase === 'started') expect(entry.frames).toHaveLength(FRAME_COUNTS.toolStarted);
      else expect(entry.frames).toHaveLength(FRAME_COUNTS.toolDone);
    }
  });

  it('packs each sheet with contiguous, non-overlapping frame indices', () => {
    for (const [name, sheet] of Object.entries(manifest.sheets)) {
      const used = Object.values(manifest.entries)
        .filter((entry) => entry.sheet === name)
        .flatMap((entry) => entry.frames)
        .sort((a, b) => a - b);
      expect(used).toEqual([...Array(sheet.frameCount).keys()]);
      expect(sheet.rows).toBe(Math.ceil(sheet.frameCount / sheet.cols));
    }
  });

  it('keeps every frame index inside its sheet grid', () => {
    for (const entry of Object.values(manifest.entries)) {
      const sheet = manifest.sheets[entry.sheet]!;
      for (const frame of entry.frames) {
        expect(frame).toBeGreaterThanOrEqual(0);
        expect(frame).toBeLessThan(sheet.frameCount);
        expect(() => frameRect(sheet, frame)).not.toThrow();
      }
    }
  });

  it('marks every sheet and entry as placeholder provenance', () => {
    expect(manifest.placeholder).toBe(true);
    for (const sheet of Object.values(manifest.sheets)) expect(sheet.placeholder).toBe(true);
    for (const entry of Object.values(manifest.entries)) expect(entry.placeholder).toBe(true);
  });

  it('lazy-loads only the avatar sheet', () => {
    expect(manifest.sheets['expr-avatar']!.lazy).toBe(true);
    expect(manifest.sheets['expr-mini']!.lazy).toBe(false);
    expect(manifest.sheets.tool!.lazy).toBe(false);
    expect(manifest.sheets.touch!.lazy).toBe(false);
  });

  it('is deterministic (byte-identical JSON across builds)', () => {
    expect(JSON.stringify(buildSpriteManifest())).toBe(JSON.stringify(buildSpriteManifest()));
  });
});

describe('frameRect', () => {
  const sheet = buildSpriteManifest().sheets['expr-mini']!;

  it('computes row-major pixel rectangles', () => {
    expect(frameRect(sheet, 0)).toEqual({ x: 0, y: 0, w: 96, h: 96 });
    expect(frameRect(sheet, 1)).toEqual({ x: 96, y: 0, w: 96, h: 96 });
    expect(frameRect(sheet, sheet.cols)).toEqual({ x: 0, y: 96, w: 96, h: 96 });
  });

  it('rejects out-of-range indices', () => {
    expect(() => frameRect(sheet, -1)).toThrow(RangeError);
    expect(() => frameRect(sheet, sheet.frameCount)).toThrow(RangeError);
  });
});

describe('assertSpriteManifest', () => {
  it('accepts a freshly built manifest', () => {
    expect(() => assertSpriteManifest(buildSpriteManifest())).not.toThrow();
  });

  it('rejects wrong version, missing sheets/entries, and dangling refs', () => {
    expect(() => assertSpriteManifest(null)).toThrow();
    expect(() => assertSpriteManifest({ version: 2 })).toThrow(/version/);
    expect(() => assertSpriteManifest({ version: 1, entries: {} })).toThrow(/sheets/);
    expect(() => assertSpriteManifest({ version: 1, sheets: {}, entries: {} })).not.toThrow();
    expect(() =>
      assertSpriteManifest({
        version: 1,
        sheets: { s: { src: 'a', cols: 1, frameCount: 1, frameSize: { w: 1, h: 1 } } },
        entries: { e: { sheet: 'missing', frames: [0] } },
      }),
    ).toThrow(/unknown sheet/);
    expect(() =>
      assertSpriteManifest({
        version: 1,
        sheets: { s: { src: 'a', cols: 1, frameCount: 1, frameSize: { w: 1, h: 1 } } },
        entries: { e: { sheet: 's', frames: [] } },
      }),
    ).toThrow(/invalid frames/);
  });
});

describe('loadSpriteManifest', () => {
  it('fetches and validates the serialized manifest', async () => {
    const manifest = buildSpriteManifest();
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => JSON.parse(JSON.stringify(manifest)) as unknown,
    })) as unknown as typeof fetch;
    const loaded = await loadSpriteManifest(fetchImpl, SPRITE_MANIFEST_PATH);
    expect(Object.keys(loaded.entries)).toHaveLength(56);
  });

  it('rejects a non-ok response (runtime falls back to the CSS face)', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(loadSpriteManifest(fetchImpl)).rejects.toThrow(/404/);
  });

  it('rejects a malformed manifest body', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ version: 99 }),
    })) as unknown as typeof fetch;
    await expect(loadSpriteManifest(fetchImpl)).rejects.toThrow(/version/);
  });
});
