import { useId } from 'react';
import type { CompanionDisplayController, CompanionDisplayMode } from './use-companion-display.js';
import { SpritePackPicker } from './sprite-pack-picker.js';
import '../styles/avatar-display-settings.css';

export function AvatarDisplaySettings({ display, label }: {
  display: CompanionDisplayController;
  label: string;
}) {
  const pickerId = useId();
  return (
    <section className="settings-section avatar-display-settings" aria-label="Companion appearance">
      <h2>Appearance</h2>
      <p>Choose how to see {label}. Chat and voice work with every display option.</p>
      <div className="appearance-options" role="group" aria-label="Avatar display">
        {(['none', 'sprite', 'model'] as const).map((mode: CompanionDisplayMode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={display.mode === mode}
            disabled={!display.available}
            onClick={() => display.choose(mode)}
          >
            {{ none: 'No avatar', sprite: 'Animated sprite', model: '3D model' }[mode]}
          </button>
        ))}
      </div>
      {display.mode === 'sprite' && <>
        <p>The default artwork is a labelled animation preview. Choose a sprite pack to use your companion’s artwork.</p>
        <SpritePackPicker onSelect={display.selectSpritePack}
          currentLabel={display.spritePack?.manifest.generator}
          onClear={display.removeSpritePack} disabled={!display.available} />
      </>}
      {display.mode === 'model' && (
        <div className="avatar-model-picker">
          <label className="avatar-file-label" htmlFor={pickerId}>Choose a VRM or GLB model</label>
          <input
            id={pickerId}
            type="file"
            accept=".vrm,.glb"
            onChange={event => {
              const file = event.currentTarget.files?.[0];
              if (file) display.selectFile(file);
              event.currentTarget.value = '';
            }}
          />
          {display.file && (
            <div className="avatar-model-selection">
              <span>{display.file.name}</span>
              <button type="button" onClick={display.removeFile}>Remove model</button>
            </div>
          )}
          <p>Models stay on this device for this open session. Select a separate model for each companion.</p>
        </div>
      )}
      {!display.available && <p>Connect to a companion to choose an appearance.</p>}
    </section>
  );
}
