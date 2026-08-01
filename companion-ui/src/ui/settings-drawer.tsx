import {
  ChevronDown,
  CircleStop,
  Loader2,
  LogIn,
  LogOut,
  Plug,
  Settings,
  UserRoundCog,
} from 'lucide-react';
import type { HubStreamState } from '../lib/stream/hub-stream.js';
import type { FleetRosterCompanion } from '../lib/fleet-roster.js';
import { DrawerHeader } from './overlay-drawer.js';
import type { MicMode } from './types.js';
import type { DeviceLocationStatus } from './use-device-location.js';

export type CompanionUiAccessPresentation = Readonly<{
  state: 'loading' | 'offline' | 'signed_out' | 'signed_in' | 'guest';
  humanLabel: string;
  humanDetail: string;
  guestAvailable: boolean;
}>;

export function SettingsDrawer({
  access,
  activeCompanionId,
  companions,
  connecting,
  micMode,
  spriteAnimations,
  spriteEnabled,
  locationEnabled,
  locationStatus,
  streamState,
  onClose,
  onConnect,
  onDisconnect,
  onGuest,
  onLogin,
  onLogout,
  onMicModeChange,
  onCompanionChange,
  onSpriteAnimationsChange,
  onSpriteEnabledChange,
  onLocationEnabledChange,
  onSwitchUser,
}: {
  access: CompanionUiAccessPresentation;
  activeCompanionId: string | null;
  companions: readonly FleetRosterCompanion[];
  connecting: boolean;
  micMode: MicMode;
  spriteAnimations: boolean;
  spriteEnabled: boolean;
  locationEnabled: boolean;
  locationStatus: DeviceLocationStatus;
  streamState: HubStreamState;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onGuest: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onMicModeChange: (value: MicMode) => void;
  onCompanionChange: (companionId: string) => void;
  onSpriteAnimationsChange: (value: boolean) => void;
  onSpriteEnabledChange: (value: boolean) => void;
  onLocationEnabledChange: (value: boolean) => void;
  onSwitchUser: () => void;
}) {
  const attached = streamState.session;
  return (
    <aside className="overlay-drawer" aria-label="Settings">
      <DrawerHeader icon={<Settings aria-hidden />} title="Settings" onClose={onClose} />
      <div className="drawer-content">
        <section className="settings-section" aria-label="Account and device authority">
          <h2>Account</h2>
          <ReadOnlyAuthority label="Partner" value={access.humanLabel} detail={access.humanDetail} />
          <ReadOnlyAuthority
            label="Device"
            value={attached?.deviceName ?? 'Not attached'}
            detail={attached?.deviceId ? 'Verified by Satellite Hub' : 'No current device authority'}
          />
          <ReadOnlyAuthority
            label="Place"
            value={attached?.place?.name ?? 'Not available'}
            detail={attached?.place ? 'Server-owned enrollment place' : 'No current place authority'}
          />
          <p>Partner login and enrolled device/place authority remain separate. Connecting or signing in never claims primary embodiment.</p>
          <div className="drawer-actions">
            {access.state === 'signed_out' && (
              <button className="primary-action" type="button" onClick={onLogin}>
                <LogIn aria-hidden /> Sign in with Discord
              </button>
            )}
            {access.state === 'signed_out' && access.guestAvailable && (
              <button type="button" onClick={onGuest}><Plug aria-hidden /> Continue as guest</button>
            )}
            {access.state === 'signed_in' && (
              <button type="button" onClick={onSwitchUser}><UserRoundCog aria-hidden /> Switch Partner</button>
            )}
            {(access.state === 'signed_in' || access.state === 'guest') && (
              <button type="button" onClick={onLogout}><LogOut aria-hidden /> Log out</button>
            )}
          </div>
        </section>

        <section className="settings-section">
          <h2>Connection</h2>
          <p>The WebSocket path, device, place, session, and channel are supplied by the same-origin gateway and authenticated Hub. They are never editable here.</p>
          <div className="drawer-actions">
            <button
              className="primary-action"
              type="button"
              onClick={onConnect}
              disabled={access.state === 'loading' || access.state === 'offline' || access.state === 'signed_out' || connecting}
            >
              {connecting ? <Loader2 aria-hidden className="spin" /> : <Plug aria-hidden />}
              Reconnect with fresh authority
            </button>
            <button type="button" onClick={onDisconnect} disabled={streamState.connection === 'idle'}>
              <CircleStop aria-hidden /> Close
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2>Audio</h2>
          <SegmentedControl
            label="Mic mode"
            options={[
              { label: 'Dictation', value: 'dictation' },
              { label: 'Voice', value: 'voice' },
            ]}
            value={micMode}
            onChange={onMicModeChange}
          />
        </section>

        <section className="settings-section">
          <h2>Companion</h2>
          {access.state === 'signed_in' && companions.length > 0 && (
            <label className="segmented-field">
              <span>Active companion</span>
              <select
                aria-label="Active companion"
                value={activeCompanionId ?? ''}
                onChange={(event) => onCompanionChange(event.target.value)}
              >
                {companions.map(companion => (
                  <option value={companion.companionId} key={companion.companionId}>
                    {companion.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ToggleRow label="Sprite enabled" checked={spriteEnabled} onChange={onSpriteEnabledChange} />
          <ToggleRow label="Animation enabled" checked={spriteAnimations} onChange={onSpriteAnimationsChange} />
        </section>

        <section className="settings-section" aria-label="Location awareness">
          <h2>Location</h2>
          <p>
            Share your phone&apos;s location while the app is open so she knows where you are
            as a place (home, out) — never as raw coordinates. Coordinates are geofenced at the
            satellite hub and never reach the runtime. Turns off when the app is backgrounded.
          </p>
          <ToggleRow
            label="Share location while open"
            checked={locationEnabled}
            onChange={onLocationEnabledChange}
          />
          <p className="location-status" role="status">{describeLocationStatus(locationStatus)}</p>
        </section>

        <details className="settings-section advanced-section">
          <summary><span>Advanced</span><ChevronDown aria-hidden /></summary>
          <p>Diagnostics remain redacted. OAuth, session, assertion, enrollment, device, and channel credentials are never written to browser storage or logs.</p>
        </details>
      </div>
    </aside>
  );
}

function describeLocationStatus(status: DeviceLocationStatus): string {
  switch (status) {
    case 'off':
      return 'Location sharing is off.';
    case 'unsupported':
      return 'This device has no geolocation support.';
    case 'transport-unavailable':
      return 'Location needs a satellite hub connection that keeps coordinates on-device; unavailable on this connection.';
    case 'suspended':
      return 'Paused while the app is in the background.';
    case 'watching':
      return 'Sharing your place while the app is open.';
    case 'denied':
      return 'Location permission was denied. Enable it in your browser settings to share your place.';
    case 'error':
      return 'Location is temporarily unavailable.';
    default:
      return '';
  }
}

function ReadOnlyAuthority({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="authority-row">
      <strong>{label}</strong>
      <span>{value}</span>
      <small>{detail}</small>
    </div>
  );
}

function ToggleRow({ checked, label, onChange }: {
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

function SegmentedControl<T extends string>({ label, onChange, options, value }: {
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
