import { Bluetooth, CircleStop, Loader2, ShieldCheck } from 'lucide-react';
import { isZ02LinkBusy, type Z02LinkState } from './use-z02-link.js';

export function Z02LinkSection({
  state,
  onDisconnect,
  onLink,
}: {
  state: Z02LinkState;
  onDisconnect: () => void;
  onLink: () => void;
}) {
  const busy = isZ02LinkBusy(state.phase);
  const linked = state.phase === 'linked';

  return (
    <section className="settings-section z02-link-section" aria-label="Z02 badge link">
      <h2>Z02 badge</h2>
      <p>Use this phone as the network relay for an untouched stock badge over JieLi RCSP or a Stark Ruby badge over its Omi audio service. Discovery starts only when you tap the button.</p>
      <div className={`z02-link-summary ${linked ? 'linked' : ''}`}>
        {linked ? <ShieldCheck aria-hidden /> : <Bluetooth aria-hidden />}
        <span>
          <strong>{state.deviceName ?? 'ZNP Z02 / Stark Ruby'}</strong>
          <small>{linked ? linkedLabel(state) : statusLabel(state.phase)}</small>
        </span>
      </div>
      <p className="z02-link-detail" role="status" aria-live="polite">{state.detail}</p>
      <div className="drawer-actions">
        {!linked && (
          <button
            className="primary-action"
            type="button"
            onClick={onLink}
            disabled={busy || state.phase === 'unsupported'}
          >
            {busy ? <Loader2 aria-hidden className="spin" /> : <Bluetooth aria-hidden />}
            {busy ? busyLabel(state.phase) : 'Link Z02'}
          </button>
        )}
        {linked && (
          <button type="button" onClick={onDisconnect}>
            <CircleStop aria-hidden /> Disconnect Z02
          </button>
        )}
      </div>
    </section>
  );
}

function statusLabel(phase: Z02LinkState['phase']): string {
  switch (phase) {
    case 'unsupported':
      return 'Unavailable in this browser';
    case 'error':
      return 'Link failed';
    case 'selecting':
      return 'Waiting for selection';
    case 'connecting':
      return 'Connecting';
    case 'authenticating':
      return 'Authenticating';
    case 'subscribing':
      return 'Subscribing to audio';
    default:
      return 'Not linked';
  }
}

function busyLabel(phase: Z02LinkState['phase']): string {
  switch (phase) {
    case 'selecting':
      return 'Choose badge…';
    case 'connecting':
      return 'Connecting…';
    case 'subscribing':
      return 'Subscribing…';
    default:
      return 'Authenticating…';
  }
}

function linkedLabel(state: Z02LinkState): string {
  if (state.audioError) return 'Audio error';
  if (state.transport === 'omi-audio') {
    if ((state.decodedFrames ?? 0) > 0) return 'Mic decoded';
    return (state.audioFrames ?? 0) > 0 ? 'Opus received' : 'Mic subscribed';
  }
  return (state.audioFrames ?? 0) > 0 ? 'Mic received' : 'Mic started';
}
