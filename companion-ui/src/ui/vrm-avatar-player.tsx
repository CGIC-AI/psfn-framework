import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmotionalBase } from '../lib/sprites/taxonomy.js';
import type { AvatarPlaybackState, AvatarPlayerHandle } from '../lib/avatar/renderer.js';
import { LocalAvatarError } from '../lib/avatar/local-model.js';
import './vrm-avatar-player.css';

export function VrmAvatarPlayer({
  file, active, animated, mouthOpen, emotionalBase = null, label = 'Companion',
}: {
  file: File;
  active: boolean;
  animated: boolean;
  mouthOpen: boolean;
  emotionalBase?: EmotionalBase | null;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<AvatarPlayerHandle | null>(null);
  const playbackRef = useRef<AvatarPlaybackState>({ active, animated, mouthOpen, emotionalBase });
  const [generation, setGeneration] = useState(0);
  // A retired WebGL context must never be reused for the next selected model.
  const canvasKey = useMemo(() => crypto.randomUUID(), [file, generation]);
  const [status, setStatus] = useState<{ file: File; format?: string; error?: string }>({ file });
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  playbackRef.current = { active: active && visible, animated: animated && !reduceMotion, mouthOpen, emotionalBase };

  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState !== 'hidden');
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const motion = () => setReduceMotion(media?.matches ?? false);
    document.addEventListener('visibilitychange', visibility);
    media?.addEventListener('change', motion);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      media?.removeEventListener('change', motion);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    let ownedPlayer: AvatarPlayerHandle | null = null;
    setStatus({ file });
    function report(error: unknown) {
      if (controller.signal.aborted) return;
      setStatus({ file, error: error instanceof LocalAvatarError ? error.message : 'This model could not be displayed. Try another VRM or GLB export.' });
    }
    // Keep Three.js and Pixiv out of the normal chat startup bundle.
    void import('../lib/avatar/renderer.js').then(async ({ createAvatarPlayer }) => {
      if (controller.signal.aborted) return;
      const player = await createAvatarPlayer(canvas, file, controller.signal, report);
      if (controller.signal.aborted) { player.dispose(); return; }
      ownedPlayer = player;
      playerRef.current = player;
      setStatus({ file, format: player.format });
      player.update(playbackRef.current);
    }).catch(report);
    return () => {
      controller.abort();
      ownedPlayer?.dispose();
      if (playerRef.current === ownedPlayer) playerRef.current = null;
    };
  }, [file, generation]);

  useEffect(() => {
    playerRef.current?.update(playbackRef.current);
  }, [active, animated, mouthOpen, emotionalBase, visible, reduceMotion]);

  const current = status.file === file ? status : { file };
  return (
    <section className="vrm-avatar-player" aria-label={`${label} 3D avatar`}>
      <canvas
        key={canvasKey}
        ref={canvasRef}
        className="vrm-avatar-canvas"
        tabIndex={0}
        role="img"
        aria-label={`${label} local 3D model. Drag to rotate; pinch or scroll to zoom. Arrow keys pan; Shift and arrow keys rotate.`}
      />
      <div className="vrm-avatar-toolbar">
        <span>{current.format ?? '3D avatar'}</span>
        <button type="button" onClick={() => playerRef.current?.reset()} disabled={!current.format || Boolean(current.error)}>Reset view</button>
      </div>
      {current.error ? (
        <div className="vrm-avatar-message" role="alert">
          <p>{current.error}</p>
          <button type="button" onClick={() => setGeneration((value) => value + 1)}>Reload model</button>
        </div>
      ) : !current.format ? (
        <p className="vrm-avatar-message" role="status">Loading your model…</p>
      ) : (
        <p className="vrm-avatar-hint">Drag to rotate · Pinch or scroll to zoom</p>
      )}
    </section>
  );
}
