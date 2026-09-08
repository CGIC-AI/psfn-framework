import { ImagePlus, Loader2 } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { readLocalSpritePack, type LocalSpritePack } from '../lib/sprites/import-sprite-pack.js';
import '../styles/sprite-pack-picker.css';

export function SpritePackPicker({ onSelect, currentLabel, onClear, disabled = false }: {
  onSelect: (pack: LocalSpritePack) => void;
  currentLabel?: string;
  onClear?: () => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generationRef = useRef(0);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { generationRef.current += 1; }, []);

  async function choosePack(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0 || disabled) return;
    const generation = ++generationRef.current;
    setReading(true);
    setError(null);
    let pack: LocalSpritePack | undefined;
    try {
      pack = await readLocalSpritePack(files);
      if (generation !== generationRef.current) {
        pack.dispose();
        return;
      }
      onSelect(pack);
      // Ownership transfers to the appearance controller after selection succeeds.
      pack = undefined;
    } catch (cause) {
      pack?.dispose();
      if (generation === generationRef.current) {
        setError(cause instanceof Error ? cause.message : 'The sprite pack could not be opened.');
      }
    } finally {
      if (generation === generationRef.current) setReading(false);
    }
  }

  return (
    <section className="sprite-pack-picker" aria-label="Companion sprite artwork">
      <h3>Sprite artwork</h3>
      <p>{currentLabel ? `Using ${currentLabel}` : 'Use your own companion artwork with the sprite animation layout.'}</p>
      <div className="sprite-pack-actions">
        <button type="button" disabled={disabled || reading} onClick={() => inputRef.current?.click()}>
          {reading ? <Loader2 aria-hidden className="spin" /> : <ImagePlus aria-hidden />}
          {reading ? 'Checking sprite pack…' : 'Choose sprite pack'}
        </button>
        {onClear && currentLabel && <button type="button" disabled={disabled || reading} onClick={onClear}>Use default artwork</button>}
      </div>
      <input
        ref={inputRef}
        className="hidden-file-input"
        type="file"
        multiple
        accept=".json,.png,application/json,image/png"
        aria-label="Choose sprite pack files"
        disabled={disabled || reading}
        onChange={event => { void choosePack(event); }}
      />
      <p className="sprite-pack-help">Select all five files together: manifest.json, expr-mini.png, expr-avatar.png, tool.png and touch.png. Files stay on this device until you reload or sign out.</p>
      {error && <p className="sprite-pack-error" role="alert">{error}</p>}
    </section>
  );
}
