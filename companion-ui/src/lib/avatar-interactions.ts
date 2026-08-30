import type {
  TouchInteractionInput,
  TouchRegion,
} from './touch-interactions.js';

export type AvatarGesture = 'tap' | 'double-tap' | 'long-press' | 'drag';

export interface AvatarGestureSample {
  readonly durationMs: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly sinceLastTapMs: number;
}

export const DOUBLE_TAP_MS = 340;
export const LONG_PRESS_MS = 550;
export const MOVE_GESTURE_PX = 18;

export const AVATAR_REGION_GESTURES: Readonly<Record<TouchRegion, readonly AvatarGesture[]>> = {
  head: ['tap', 'drag'],
  cheek: ['double-tap'],
  body: ['long-press'],
};

/** Port of the Hub Device Studio gesture priority and thresholds. */
export function classifyAvatarGesture(
  sample: AvatarGestureSample,
  supported: readonly AvatarGesture[],
): AvatarGesture {
  const distancePx = Math.hypot(sample.deltaX, sample.deltaY);
  if (distancePx >= MOVE_GESTURE_PX && supported.includes('drag')) return 'drag';
  if (sample.durationMs >= LONG_PRESS_MS && supported.includes('long-press')) return 'long-press';
  if (sample.sinceLastTapMs <= DOUBLE_TAP_MS && supported.includes('double-tap')) return 'double-tap';
  return 'tap';
}

export function mapAvatarInteraction(
  region: TouchRegion,
  gesture: AvatarGesture,
  durationMs: number,
): TouchInteractionInput | null {
  if (region === 'head' && gesture === 'tap') {
    return { kind: 'headpat', region, durationMs };
  }
  if (region === 'head' && gesture === 'drag') {
    return { kind: 'petting', region, durationMs };
  }
  if (region === 'body' && gesture === 'long-press') {
    return { kind: 'hug', region, durationMs };
  }
  if (region === 'cheek' && gesture === 'double-tap') {
    return { kind: 'kiss', region, durationMs };
  }
  return null;
}
