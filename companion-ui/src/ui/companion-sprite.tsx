import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  EmotionSnapshotStreamEntry,
  HubStreamState,
  ToolActivityStreamEntry,
} from '../lib/stream/hub-stream.js';
import type { OperationalTrace } from '../lib/traces.js';
import { resolveSpriteEntryId } from '../lib/sprites/catalog.js';
import { deriveSpriteInputs } from '../lib/sprites/emotion-mapping.js';
import { frameRect, type SpriteEntry, type SpriteManifest } from '../lib/sprites/manifest.js';
import type { TouchReaction } from '../lib/sprites/taxonomy.js';
import type { SpriteState } from './types.js';

const MINI_DISPLAY_WIDTH = 74;

// Advance through an entry's frames. Looping entries cycle; one-shot entries
// (touch reactions) play once and hold the last frame.
function useSpriteFrame(entry: SpriteEntry | null, animated: boolean): number {
  const [index, setIndex] = useState(0);
  const frameCount = entry?.frames.length ?? 0;
  const fps = entry?.fps ?? 0;
  const loop = entry?.loop ?? false;
  const entryId = entry?.id ?? '';

  useEffect(() => {
    setIndex(0);
  }, [entryId]);

  useEffect(() => {
    if (!animated || frameCount <= 1 || fps <= 0) return undefined;
    const interval = window.setInterval(() => {
      setIndex((current) => {
        const next = current + 1;
        if (next >= frameCount) return loop ? 0 : frameCount - 1;
        return next;
      });
    }, Math.round(1000 / fps));
    return () => window.clearInterval(interval);
  }, [animated, frameCount, fps, loop, entryId]);

  return Math.min(index, Math.max(frameCount - 1, 0));
}

export function SpriteFrame({
  manifest,
  entryId,
  animated,
  displayWidth,
}: {
  manifest: SpriteManifest;
  entryId: string;
  animated: boolean;
  displayWidth: number;
}) {
  const entry = manifest.entries[entryId] ?? null;
  const localFrame = useSpriteFrame(entry, animated);

  const style = useMemo(() => {
    if (!entry) return null;
    const sheet = manifest.sheets[entry.sheet];
    if (!sheet) return null;
    const globalFrame = entry.frames[localFrame] ?? entry.frames[0]!;
    const rect = frameRect(sheet, globalFrame);
    const scale = displayWidth / rect.w;
    const sheetW = sheet.cols * sheet.frameSize.w;
    const sheetH = Math.max(sheet.rows, 1) * sheet.frameSize.h;
    return {
      width: `${rect.w * scale}px`,
      height: `${rect.h * scale}px`,
      backgroundImage: `url(${sheet.src})`,
      backgroundPosition: `-${rect.x * scale}px -${rect.y * scale}px`,
      backgroundSize: `${sheetW * scale}px ${sheetH * scale}px`,
    } as const;
  }, [displayWidth, entry, localFrame, manifest.sheets]);

  if (!style) return null;
  return <span className="sprite-image" style={style} aria-hidden />;
}

export function CssFace() {
  return (
    <span className="sprite-face" aria-hidden>
      <span className="sprite-ear left" />
      <span className="sprite-ear right" />
      <span className="sprite-hair" />
      <span className="sprite-eye left" />
      <span className="sprite-eye right" />
      <span className="sprite-mouth" />
    </span>
  );
}

export function CompanionSprite({
  animated,
  label,
  mouthOpen = false,
  onHeadpat,
  petted,
  state,
  manifest = null,
  touch = null,
  emotion = null,
  toolActivity = null,
}: {
  animated: boolean;
  label: string;
  /** v1 amplitude lipsync: open the mouth while the companion speaks. */
  mouthOpen?: boolean;
  onHeadpat: () => void;
  petted: boolean;
  state: SpriteState;
  manifest?: SpriteManifest | null;
  touch?: TouchReaction | null;
  /** Latest redacted emotion snapshot; drives the emotional base when fresh. */
  emotion?: EmotionSnapshotStreamEntry | null;
  /** Most recent tool-activity entry; drives the tool-domain overlay when fresh. */
  toolActivity?: ToolActivityStreamEntry | null;
}) {
  // Local clock so a stale snapshot / finished tool decays without a new frame.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { base, toolDomain, toolPhase } = deriveSpriteInputs({ emotion, toolActivity, nowMs });
  // Tick only while a time-gated layer is still live; stop once everything has
  // decayed so we never hold a permanent timer (a new frame re-arms it).
  const decaying = base !== null || toolDomain !== null;
  useEffect(() => {
    if (!decaying) return undefined;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [decaying]);

  const entryId = manifest
    ? resolveSpriteEntryId({ state, touch, base, toolDomain, toolPhase, crop: 'mini' })
    : null;
  const hasSprite = Boolean(manifest && entryId && manifest.entries[entryId]);

  return (
    <button
      className={`companion-sprite ${state} ${animated ? 'animated' : 'static'} ${petted ? 'petted' : ''} ${mouthOpen ? 'mouth-open' : ''} ${hasSprite ? 'sprite-art' : 'sprite-css'}`}
      type="button"
      aria-label={`Give ${label} a headpat; currently ${state}`}
      title={`Give ${label} a headpat`}
      onClick={onHeadpat}
    >
      <span className="sprite-aura" aria-hidden />
      <span className="sprite-hearts" aria-hidden>
        <span className="sprite-heart first">♥</span>
        <span className="sprite-heart second">♥</span>
        <span className="sprite-heart third">♥</span>
      </span>
      {hasSprite && manifest && entryId ? (
        <SpriteFrame manifest={manifest} entryId={entryId} animated={animated} displayWidth={MINI_DISPLAY_WIDTH} />
      ) : (
        <CssFace />
      )}
      <span className="sprite-state">{state.replace('_', ' ')}</span>
    </button>
  );
}

export function AvatarMark() {
  return (
    <div className="avatar-mark" aria-hidden>
      <Sparkles />
    </div>
  );
}

export function deriveSpriteState(
  streamState: HubStreamState,
  traces: OperationalTrace[],
  micActive: boolean,
  connecting: boolean,
): SpriteState {
  if (streamState.failure) return 'error';
  if (micActive) return 'listening';
  if (streamState.liveAssistant) return 'speaking';
  if (connecting || streamState.connection === 'connecting') return 'thinking';
  if (traces.at(-1)?.operationClass.includes('relay')) return 'tool_use';
  return 'attentive';
}
