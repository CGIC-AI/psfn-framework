import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AVATAR_REGION_GESTURES,
  LONG_PRESS_MS,
  MOVE_GESTURE_PX,
  classifyAvatarGesture,
  mapAvatarInteraction,
} from '../lib/avatar-interactions.js';
import { resolveSpriteEntryId } from '../lib/sprites/catalog.js';
import { deriveSpriteInputs } from '../lib/sprites/emotion-mapping.js';
import type { SpriteManifest } from '../lib/sprites/manifest.js';
import type {
  EmotionSnapshotStreamEntry,
} from '../lib/stream/hub-stream.js';
import type {
  TouchInteractionInput,
  TouchRegion,
  TouchStimulusKind,
} from '../lib/touch-interactions.js';
import type { SpriteState } from './types.js';
import { CssFace, SpriteFrame } from './companion-sprite.js';

const AVATAR_DISPLAY_WIDTH = 280;
const REACTION_HOLD_MS = 900;

const REACTION_COPY: Readonly<Record<TouchStimulusKind, string>> = {
  headpat: 'Headpat ♥',
  petting: 'Gentle petting ✦',
  hug: 'Hug ♡',
  kiss: 'Kiss ♥',
};

interface PointerStart {
  readonly pointerId: number;
  readonly region: TouchRegion;
  readonly atMs: number;
  readonly x: number;
  readonly y: number;
}

interface LocalReaction {
  readonly key: number;
  readonly kind: TouchStimulusKind;
}

export function AvatarView({
  animated,
  emotion = null,
  label,
  manifest,
  now = () => Date.now(),
  onInteraction,
  state,
}: {
  animated: boolean;
  emotion?: EmotionSnapshotStreamEntry | null;
  label: string;
  manifest: SpriteManifest | null;
  now?: () => number;
  onInteraction: (interaction: TouchInteractionInput) => void;
  state: SpriteState;
}) {
  const pointerStartRef = useRef<PointerStart | null>(null);
  const lastTapAtRef = useRef<Record<TouchRegion, number>>({
    head: Number.NEGATIVE_INFINITY,
    cheek: Number.NEGATIVE_INFINITY,
    body: Number.NEGATIVE_INFINITY,
  });
  const reactionTimerRef = useRef<number | null>(null);
  const reactionSequenceRef = useRef(0);
  const [reaction, setReaction] = useState<LocalReaction | null>(null);

  useEffect(() => () => {
    if (reactionTimerRef.current !== null) window.clearTimeout(reactionTimerRef.current);
  }, []);

  const base = useMemo(() => emotion
    ? deriveSpriteInputs({ emotion, toolActivity: null, nowMs: Date.now() }).base
    : null, [emotion]);
  const entryId = manifest
    ? resolveSpriteEntryId({ state, base, crop: 'avatar' })
    : null;
  const hasSprite = Boolean(manifest && entryId && manifest.entries[entryId]);

  function beginGesture(region: TouchRegion, event: ReactPointerEvent<HTMLButtonElement>) {
    if (pointerStartRef.current) return;
    pointerStartRef.current = {
      pointerId: event.pointerId,
      region,
      atMs: now(),
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function finishGesture(region: TouchRegion, event: ReactPointerEvent<HTMLButtonElement>) {
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId || start.region !== region) return;
    pointerStartRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const endedAt = now();
    const durationMs = Math.min(Math.max(endedAt - start.atMs, 0), 60_000);
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    const distancePx = Math.hypot(deltaX, deltaY);
    const tapLike = distancePx < MOVE_GESTURE_PX && durationMs < LONG_PRESS_MS;
    const sinceLastTapMs = tapLike
      ? endedAt - lastTapAtRef.current[region]
      : Number.POSITIVE_INFINITY;
    const gesture = classifyAvatarGesture(
      { durationMs, deltaX, deltaY, sinceLastTapMs },
      AVATAR_REGION_GESTURES[region],
    );

    if (tapLike) {
      lastTapAtRef.current[region] = gesture === 'double-tap'
        ? Number.NEGATIVE_INFINITY
        : endedAt;
    }

    const interaction = mapAvatarInteraction(region, gesture, durationMs);
    if (!interaction) return;
    showReaction(interaction.kind);
    onInteraction(interaction);
  }

  function cancelGesture(event: ReactPointerEvent<HTMLButtonElement>) {
    if (pointerStartRef.current?.pointerId === event.pointerId) {
      pointerStartRef.current = null;
    }
  }

  function showReaction(kind: TouchStimulusKind) {
    reactionSequenceRef.current += 1;
    setReaction({ key: reactionSequenceRef.current, kind });
    if (reactionTimerRef.current !== null) window.clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = window.setTimeout(() => {
      setReaction(null);
      reactionTimerRef.current = null;
    }, REACTION_HOLD_MS);
  }

  const regionProps = (region: TouchRegion) => ({
    onPointerCancel: cancelGesture,
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => beginGesture(region, event),
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => finishGesture(region, event),
  });

  return (
    <section className="avatar-view" aria-label={`${label} avatar`}>
      <div className={`avatar-stage ${animated ? 'animated' : 'static'}`}>
        <div
          className={`avatar-character ${hasSprite ? 'sprite-art' : 'sprite-css'} ${reaction ? `reaction-${reaction.kind}` : ''}`}
          data-sprite-entry={entryId ?? undefined}
        >
          <span className="avatar-aura" aria-hidden />
          {hasSprite && manifest && entryId ? (
            <SpriteFrame
              animated={animated}
              displayWidth={AVATAR_DISPLAY_WIDTH}
              entryId={entryId}
              manifest={manifest}
            />
          ) : (
            <span className="avatar-css-character" aria-hidden>
              <CssFace />
              <span className="avatar-css-neck" />
              <span className="avatar-css-body" />
              <span className="avatar-css-arm left" />
              <span className="avatar-css-arm right" />
            </span>
          )}
          <span className="avatar-hit-regions">
            <button
              type="button"
              className="avatar-hit-region head"
              aria-label={`${label} head: tap or drag`}
              {...regionProps('head')}
            />
            <button
              type="button"
              className="avatar-hit-region cheek"
              aria-label={`${label} cheek: double tap`}
              {...regionProps('cheek')}
            />
            <button
              type="button"
              className="avatar-hit-region body"
              aria-label={`${label} body: long press`}
              {...regionProps('body')}
            />
          </span>
        </div>
        {reaction && (
          <div
            key={reaction.key}
            className={`avatar-reaction reaction-${reaction.kind}`}
            data-reaction={reaction.kind}
            role="status"
          >
            {REACTION_COPY[reaction.kind]}
          </div>
        )}
        <p className="avatar-gesture-hint">Tap or stroke her head · double-tap her cheek · hold her close</p>
      </div>
    </section>
  );
}
