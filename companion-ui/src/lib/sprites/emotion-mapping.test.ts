import { describe, expect, it } from 'vitest';
import { CANONICAL_FIRST_PARTY_TOOL_SURFACES } from '../../../../src/core/agent/tool-surface/registry.js';
import type { EmotionSnapshotStreamEntry, ToolActivityStreamEntry } from '../stream/hub-stream.js';
import { buildSpriteManifest } from './manifest.js';
import { resolveSpriteEntryId } from './catalog.js';
import { EMOTIONAL_BASES, type EmotionalBase } from './taxonomy.js';
import {
  DEFAULT_TOOL_ICON,
  DISCRETE_OVERRIDE_MIN,
  EMOTION_SNAPSHOT_STALE_MS,
  TOOL_DONE_HOLD_MS,
  TOOL_DOMAIN_ICON,
  TOOL_NAME_DOMAIN,
  TOOL_STARTED_STALE_MS,
  deriveSpriteInputs,
  emotionalBaseFromSnapshot,
  toolIconForName,
  toolPhaseForActivity,
  vadQuadrantBase,
} from './emotion-mapping.js';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');

function snapshot(overrides: Partial<EmotionSnapshotStreamEntry> = {}): EmotionSnapshotStreamEntry {
  return {
    trigger: 'post_turn',
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discrete: [],
    confidence: 0.5,
    timestamp: new Date(NOW).toISOString(),
    sequence: 1,
    receivedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function toolEntry(overrides: Partial<ToolActivityStreamEntry> = {}): ToolActivityStreamEntry {
  return {
    id: 'call-1',
    tool: 'memory',
    phase: 'started',
    timestamp: new Date(NOW).toISOString(),
    sequence: 1,
    receivedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('vadQuadrantBase', () => {
  it.each<[string, { valence: number; arousal: number; dominance: number }, EmotionalBase]>([
    ['flat -> neutral', { valence: 0, arousal: 0, dominance: 0 }, 'neutral'],
    ['positive calm -> content', { valence: 0.5, arousal: 0.2, dominance: 0 }, 'content'],
    ['positive mid -> happy', { valence: 0.5, arousal: 0.45, dominance: 0 }, 'happy'],
    ['positive high -> excited', { valence: 0.5, arousal: 0.8, dominance: 0 }, 'excited'],
    ['negative drowsy -> tired', { valence: -0.5, arousal: -0.4, dominance: 0 }, 'tired'],
    ['negative calm -> sad', { valence: -0.5, arousal: 0.2, dominance: 0 }, 'sad'],
    ['negative activated dominant -> grumpy', { valence: -0.5, arousal: 0.7, dominance: 0.5 }, 'grumpy'],
    ['negative activated submissive -> anxious', { valence: -0.5, arousal: 0.7, dominance: -0.5 }, 'anxious'],
    ['neutral valence high arousal -> surprised', { valence: 0, arousal: 0.8, dominance: 0 }, 'surprised'],
  ])('%s', (_label, vad, expected) => {
    expect(vadQuadrantBase(vad)).toBe(expected);
  });

  it('honours exact boundary values deterministically', () => {
    // valence exactly at the positive margin counts as positive.
    expect(vadQuadrantBase({ valence: 0.15, arousal: 0.1, dominance: 0 })).toBe('content');
    // arousal exactly at the calm cutoff is NO LONGER calm (content -> happy at 0.35).
    expect(vadQuadrantBase({ valence: 0.5, arousal: 0.34, dominance: 0 })).toBe('content');
    expect(vadQuadrantBase({ valence: 0.5, arousal: 0.35, dominance: 0 })).toBe('happy');
    // arousal exactly at the high cutoff is high (happy -> excited at 0.6).
    expect(vadQuadrantBase({ valence: 0.5, arousal: 0.59, dominance: 0 })).toBe('happy');
    expect(vadQuadrantBase({ valence: 0.5, arousal: 0.6, dominance: 0 })).toBe('excited');
    // dominance exactly 0 on activated-negative resolves to grumpy (>= 0).
    expect(vadQuadrantBase({ valence: -0.5, arousal: 0.7, dominance: 0 })).toBe('grumpy');
    // just below the margin on both axes stays neutral.
    expect(vadQuadrantBase({ valence: 0.14, arousal: 0.5, dominance: 0 })).toBe('neutral');
  });

  it('only ever returns members of EMOTIONAL_BASES', () => {
    for (let v = -1; v <= 1; v += 0.25) {
      for (let a = -1; a <= 1; a += 0.25) {
        for (const d of [-1, 0, 1]) {
          expect(EMOTIONAL_BASES).toContain(vadQuadrantBase({ valence: v, arousal: a, dominance: d }));
        }
      }
    }
  });
});

describe('emotionalBaseFromSnapshot', () => {
  it('uses mood only when VAD is flat', () => {
    const flatVadHappyMood = snapshot({
      vad: { valence: 0.05, arousal: 0.05, dominance: 0 },
      mood: { valence: 0.6, arousal: 0.2, dominance: 0 },
    });
    expect(emotionalBaseFromSnapshot(flatVadHappyMood)).toBe('content');

    const activeVadIgnoresMood = snapshot({
      vad: { valence: 0.6, arousal: 0.8, dominance: 0 },
      mood: { valence: -0.9, arousal: 0.1, dominance: 0 },
    });
    expect(emotionalBaseFromSnapshot(activeVadIgnoresMood)).toBe('excited');
  });

  it('a strong discrete label overrides the VAD base', () => {
    const base = snapshot({
      vad: { valence: 0.6, arousal: 0.2, dominance: 0 }, // -> content
      discrete: [{ label: 'love', score: 0.9 }],
    });
    expect(emotionalBaseFromSnapshot(base)).toBe('love');
  });

  it('picks the strongest discrete label regardless of array order', () => {
    const entry = snapshot({
      vad: { valence: 0.6, arousal: 0.2, dominance: 0 },
      discrete: [{ label: 'joy', score: 0.45 }, { label: 'pride', score: 0.9 }],
    });
    expect(emotionalBaseFromSnapshot(entry)).toBe('smug');
  });

  it('MANDATORY fallback: an unknown discrete label yields the VAD base', () => {
    const entry = snapshot({
      vad: { valence: 0.6, arousal: 0.8, dominance: 0 }, // -> excited
      discrete: [{ label: 'flibbertigibbet', score: 0.99 }],
    });
    expect(emotionalBaseFromSnapshot(entry)).toBe('excited');
  });

  it('a weak discrete label does not override the VAD base', () => {
    const entry = snapshot({
      vad: { valence: 0.6, arousal: 0.2, dominance: 0 }, // -> content
      discrete: [{ label: 'love', score: DISCRETE_OVERRIDE_MIN - 0.01 }],
    });
    expect(emotionalBaseFromSnapshot(entry)).toBe('content');
  });

  it('normalises label casing/whitespace before lookup', () => {
    const entry = snapshot({
      discrete: [{ label: '  SURPRISE  ', score: 0.8 }],
    });
    expect(emotionalBaseFromSnapshot(entry)).toBe('surprised');
  });
});

describe('tool-domain mapping (mirror of registry.ts)', () => {
  it('maps every canonical tool name to its registry domain and a valid icon', () => {
    for (const entry of CANONICAL_FIRST_PARTY_TOOL_SURFACES) {
      expect(TOOL_NAME_DOMAIN[entry.name], `name ${entry.name} present`).toBe(entry.domain);
      const icon = TOOL_DOMAIN_ICON[entry.domain];
      expect(icon, `domain ${entry.domain} has an icon`).toBeDefined();
      expect(toolIconForName(entry.name)).toBe(icon);
    }
  });

  it('covers every FirstPartyToolDomain the registry uses', () => {
    const usedDomains = new Set(CANONICAL_FIRST_PARTY_TOOL_SURFACES.map((e) => e.domain));
    for (const domain of usedDomains) {
      expect(TOOL_DOMAIN_ICON[domain], `icon for ${domain}`).toBeDefined();
    }
  });

  it('degrades an unknown tool name to the default wrench bucket', () => {
    expect(toolIconForName('totally_made_up_tool')).toBe(DEFAULT_TOOL_ICON);
    expect(DEFAULT_TOOL_ICON).toBe('wrench');
  });

  it('maps activity phases (progress reuses started)', () => {
    expect(toolPhaseForActivity('started')).toBe('started');
    expect(toolPhaseForActivity('progress')).toBe('started');
    expect(toolPhaseForActivity('completed')).toBe('completed');
    expect(toolPhaseForActivity('failed')).toBe('failed');
  });
});

describe('deriveSpriteInputs (staleness + degradation)', () => {
  it('degrades to no base when there is no emotion snapshot', () => {
    expect(deriveSpriteInputs({ emotion: null, toolActivity: null, nowMs: NOW }))
      .toEqual({ base: null, toolDomain: null, toolPhase: null });
  });

  it('drives the base from a fresh snapshot', () => {
    const emotion = snapshot({ vad: { valence: 0.6, arousal: 0.8, dominance: 0 } });
    expect(deriveSpriteInputs({ emotion, toolActivity: null, nowMs: NOW }).base).toBe('excited');
  });

  it('decays a stale snapshot to a null base (no stuck expression)', () => {
    const emotion = snapshot({ vad: { valence: 0.6, arousal: 0.8, dominance: 0 } });
    const staleNow = NOW + EMOTION_SNAPSHOT_STALE_MS + 1;
    expect(deriveSpriteInputs({ emotion, toolActivity: null, nowMs: staleNow }).base).toBeNull();
  });

  it('keeps the base exactly at the staleness boundary', () => {
    const emotion = snapshot({ vad: { valence: 0.6, arousal: 0.8, dominance: 0 } });
    expect(deriveSpriteInputs({ emotion, toolActivity: null, nowMs: NOW + EMOTION_SNAPSHOT_STALE_MS }).base)
      .toBe('excited');
  });

  it('treats a malformed receivedAt as infinitely stale', () => {
    const emotion = snapshot({ receivedAt: 'not-a-date' });
    expect(deriveSpriteInputs({ emotion, toolActivity: null, nowMs: NOW }).base).toBeNull();
  });

  it('shows a running tool loop while fresh, then clears when stale', () => {
    const tool = toolEntry({ tool: 'wiki', phase: 'started' });
    const fresh = deriveSpriteInputs({ emotion: null, toolActivity: tool, nowMs: NOW });
    expect(fresh).toMatchObject({ toolDomain: 'notebook', toolPhase: 'started' });

    const stale = deriveSpriteInputs({
      emotion: null,
      toolActivity: tool,
      nowMs: NOW + TOOL_STARTED_STALE_MS + 1,
    });
    expect(stale.toolDomain).toBeNull();
    expect(stale.toolPhase).toBeNull();
  });

  it('holds a terminal tool one-shot briefly then clears', () => {
    const tool = toolEntry({ tool: 'generate_image', phase: 'completed' });
    const held = deriveSpriteInputs({ emotion: null, toolActivity: tool, nowMs: NOW + TOOL_DONE_HOLD_MS });
    expect(held).toMatchObject({ toolDomain: 'painting', toolPhase: 'completed' });

    const cleared = deriveSpriteInputs({
      emotion: null,
      toolActivity: tool,
      nowMs: NOW + TOOL_DONE_HOLD_MS + 1,
    });
    expect(cleared.toolDomain).toBeNull();
  });

  it('maps a failed tool to the failed phase', () => {
    const tool = toolEntry({ tool: 'shell', phase: 'failed' });
    expect(deriveSpriteInputs({ emotion: null, toolActivity: tool, nowMs: NOW }))
      .toMatchObject({ toolDomain: 'wrench', toolPhase: 'failed' });
  });
});

describe('layer priority through the catalog seam (touch > tool > base)', () => {
  const manifest = buildSpriteManifest();

  it('a fresh tool overlay wins over the emotional base', () => {
    const emotion = snapshot({ vad: { valence: 0.9, arousal: 0.2, dominance: 0 } }); // -> content
    const tool = toolEntry({ tool: 'schedule', phase: 'started' }); // -> clock
    const { base, toolDomain, toolPhase } = deriveSpriteInputs({ emotion, toolActivity: tool, nowMs: NOW });
    const id = resolveSpriteEntryId({ state: 'attentive', base, toolDomain, toolPhase, crop: 'mini' });
    expect(id).toBe('tool.clock.started');
    expect(manifest.entries[id]).toBeDefined();
  });

  it('the emotional base shows once the tool overlay has decayed', () => {
    const emotion = snapshot({ vad: { valence: 0.9, arousal: 0.2, dominance: 0 } });
    const tool = toolEntry({ tool: 'schedule', phase: 'completed' });
    const nowMs = NOW + TOOL_DONE_HOLD_MS + 1;
    const { base, toolDomain, toolPhase } = deriveSpriteInputs({ emotion, toolActivity: tool, nowMs });
    const id = resolveSpriteEntryId({ state: 'attentive', base, toolDomain, toolPhase, crop: 'mini' });
    expect(id).toBe('expr.content.mini');
    expect(manifest.entries[id]).toBeDefined();
  });

  it('touch wins over both a fresh tool and the base', () => {
    const emotion = snapshot({ vad: { valence: 0.9, arousal: 0.2, dominance: 0 } });
    const tool = toolEntry({ tool: 'schedule', phase: 'started' });
    const { base, toolDomain, toolPhase } = deriveSpriteInputs({ emotion, toolActivity: tool, nowMs: NOW });
    const id = resolveSpriteEntryId({
      state: 'attentive', touch: 'hug-squeeze', base, toolDomain, toolPhase, crop: 'mini',
    });
    expect(id).toBe('touch.hug-squeeze');
  });
});
