import { Sparkles } from 'lucide-react';
import type { HubStreamState } from '../lib/stream/hub-stream.js';
import type { OperationalTrace } from '../lib/traces.js';
import type { SpriteState } from './types.js';

export function CompanionSprite({
  animated,
  label,
  mouthOpen = false,
  onHeadpat,
  petted,
  state,
}: {
  animated: boolean;
  label: string;
  /** v1 amplitude lipsync: open the mouth while the companion speaks. */
  mouthOpen?: boolean;
  onHeadpat: () => void;
  petted: boolean;
  state: SpriteState;
}) {
  return (
    <button
      className={`companion-sprite ${state} ${animated ? 'animated' : 'static'} ${petted ? 'petted' : ''} ${mouthOpen ? 'mouth-open' : ''}`}
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
      <span className="sprite-face" aria-hidden>
        <span className="sprite-ear left" />
        <span className="sprite-ear right" />
        <span className="sprite-hair" />
        <span className="sprite-eye left" />
        <span className="sprite-eye right" />
        <span className="sprite-mouth" />
      </span>
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
