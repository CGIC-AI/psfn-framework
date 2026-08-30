import { describe, expect, it } from 'vitest';
import {
  AVATAR_REGION_GESTURES,
  DOUBLE_TAP_MS,
  LONG_PRESS_MS,
  MOVE_GESTURE_PX,
  classifyAvatarGesture,
  mapAvatarInteraction,
} from './avatar-interactions.js';

describe('avatar gesture classification', () => {
  it('ports the Device Studio thresholds without fuzzy boundary drift', () => {
    expect(classifyAvatarGesture({
      durationMs: LONG_PRESS_MS - 1,
      deltaX: MOVE_GESTURE_PX,
      deltaY: 0,
      sinceLastTapMs: DOUBLE_TAP_MS + 1,
    }, AVATAR_REGION_GESTURES.head)).toBe('drag');

    expect(classifyAvatarGesture({
      durationMs: LONG_PRESS_MS,
      deltaX: 0,
      deltaY: 0,
      sinceLastTapMs: DOUBLE_TAP_MS + 1,
    }, AVATAR_REGION_GESTURES.body)).toBe('long-press');

    expect(classifyAvatarGesture({
      durationMs: 80,
      deltaX: 0,
      deltaY: 0,
      sinceLastTapMs: DOUBLE_TAP_MS,
    }, AVATAR_REGION_GESTURES.cheek)).toBe('double-tap');

    expect(classifyAvatarGesture({
      durationMs: 80,
      deltaX: 0,
      deltaY: 0,
      sinceLastTapMs: DOUBLE_TAP_MS + 1,
    }, AVATAR_REGION_GESTURES.cheek)).toBe('tap');
  });
});

describe('avatar region and gesture mapping', () => {
  it.each([
    ['head', 'tap', 'headpat'],
    ['head', 'drag', 'petting'],
    ['body', 'long-press', 'hug'],
    ['cheek', 'double-tap', 'kiss'],
  ] as const)('maps %s %s to %s', (region, gesture, kind) => {
    expect(mapAvatarInteraction(region, gesture, 640)).toEqual({
      kind,
      region,
      durationMs: 640,
    });
  });

  it.each([
    ['head', 'long-press'],
    ['body', 'tap'],
    ['cheek', 'tap'],
    ['body', 'drag'],
  ] as const)('leaves unsupported %s %s combinations inert', (region, gesture) => {
    expect(mapAvatarInteraction(region, gesture, 100)).toBeNull();
  });
});
