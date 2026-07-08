import {
  ChevronDown,
  CircleStop,
  Loader2,
  Plug,
  Settings,
} from 'lucide-react';
import type { HubStreamState } from '../lib/stream/hub-stream.js';
import { DrawerHeader } from './overlay-drawer.js';
import type { MicMode } from './types.js';

export function SettingsDrawer({
  autoConnect,
  autoReconnect,
  channelId,
  connecting,
  hubUrl,
  micMode,
  sessionId,
  spriteAnimations,
  spriteEnabled,
  streamState,
  onAutoConnectChange,
  onAutoReconnectChange,
  onChannelIdChange,
  onClose,
  onConnect,
  onDisconnect,
  onHubUrlChange,
  onMicModeChange,
  onSessionIdChange,
  onSpriteAnimationsChange,
  onSpriteEnabledChange,
}: {
  autoConnect: boolean;
  autoReconnect: string;
  channelId: string;
  connecting: boolean;
  hubUrl: string;
  micMode: MicMode;
  sessionId: string;
  spriteAnimations: boolean;
  spriteEnabled: boolean;
  streamState: HubStreamState;
  onAutoConnectChange: (value: boolean) => void;
  onAutoReconnectChange: (value: string) => void;
  onChannelIdChange: (value: string) => void;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onHubUrlChange: (value: string) => void;
  onMicModeChange: (value: MicMode) => void;
  onSessionIdChange: (value: string) => void;
  onSpriteAnimationsChange: (value: boolean) => void;
  onSpriteEnabledChange: (value: boolean) => void;
}) {
  return (
    <aside className="overlay-drawer" aria-label="Settings">
      <DrawerHeader icon={<Settings aria-hidden />} title="Settings" onClose={onClose} />
      <div className="drawer-content">
        <section className="settings-section">
          <h2>Connection</h2>
          <LabelledInput label="Hub URL" value={hubUrl} onChange={onHubUrlChange} placeholder="ws://hub.local:8787/" />
          <LabelledInput label="Session" value={sessionId} onChange={onSessionIdChange} />
          <LabelledInput label="Channel" value={channelId} onChange={onChannelIdChange} placeholder="optional" />
          <ToggleRow label="Auto-connect on start" checked={autoConnect} onChange={onAutoConnectChange} />
          <label className="field-label">
            <span>Reconnect behavior</span>
            <select value={autoReconnect} onChange={(event) => onAutoReconnectChange(event.target.value)}>
              <option value="exponential">Exponential backoff</option>
              <option value="manual">Manual only</option>
            </select>
          </label>
          <div className="drawer-actions">
            <button className="primary-action" type="button" onClick={onConnect} disabled={!hubUrl || connecting}>
              {connecting ? <Loader2 aria-hidden className="spin" /> : <Plug aria-hidden />}
              Connect
            </button>
            <button type="button" onClick={onDisconnect} disabled={streamState.connection === 'idle'}>
              <CircleStop aria-hidden />
              Close
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2>Audio</h2>
          <label className="field-label">
            <span>Microphone input</span>
            <select defaultValue="default">
              <option value="default">Default microphone</option>
            </select>
          </label>
          <label className="field-label">
            <span>Speaker output</span>
            <select defaultValue="default">
              <option value="default">Default speakers</option>
            </select>
          </label>
          <SegmentedControl
            label="Mic mode"
            options={[
              { label: 'Dictation', value: 'dictation' },
              { label: 'Voice', value: 'voice' },
            ]}
            value={micMode}
            onChange={onMicModeChange}
          />
          <label className="field-label">
            <span>Voice message behavior</span>
            <select defaultValue="text-visible">
              <option value="text-visible">Text remains visible</option>
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h2>Notifications</h2>
          <ToggleRow label="Approval request popups" checked onChange={() => undefined} />
          <ToggleRow label="Artifact created toasts" checked onChange={() => undefined} />
          <ToggleRow label="Sound effects" checked={false} onChange={() => undefined} />
          <ToggleRow label="Voice playback" checked={micMode === 'voice'} onChange={() => undefined} />
        </section>

        <section className="settings-section">
          <h2>Companion</h2>
          <ToggleRow label="Sprite enabled" checked={spriteEnabled} onChange={onSpriteEnabledChange} />
          <label className="field-label">
            <span>Sprite emotion source</span>
            <select defaultValue="stream">
              <option value="stream">Local stream state</option>
            </select>
          </label>
          <ToggleRow label="Animation enabled" checked={spriteAnimations} onChange={onSpriteAnimationsChange} />
          <ToggleRow label="Speaking animation enabled" checked={spriteAnimations} onChange={onSpriteAnimationsChange} />
          <ToggleRow label="Tool-use animation enabled" checked={spriteAnimations} onChange={onSpriteAnimationsChange} />
        </section>

        <details className="settings-section advanced-section">
          <summary>
            <span>Advanced</span>
            <ChevronDown aria-hidden />
          </summary>
          <p>Activity, diagnostics, and raw protocol inspection live in the Activity drawer.</p>
          <p>Raw logs stay redacted; transcript content is not copied into diagnostics.</p>
        </details>
      </div>
    </aside>
  );
}

function LabelledInput({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="field-label">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function ToggleRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SegmentedControl<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: Array<{ label: string; value: T }>;
  value: T;
}) {
  return (
    <div className="segmented-field">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <button
            className={value === option.value ? 'active' : ''}
            type="button"
            onClick={() => onChange(option.value)}
            key={option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
