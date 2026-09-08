import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MonitorSmartphone, RefreshCw, ShieldCheck } from 'lucide-react';
import type { BrowserEmbodimentPort, BrowserEmbodimentStatus } from '../lib/api/primary-embodiment.js';
import type { HubStreamStore } from '../lib/stream/hub-stream.js';

type EmbodimentReadState = Readonly<{
  port: BrowserEmbodimentPort;
  companionId: string;
  phase: 'loading' | 'switching' | 'ready' | 'error';
  status: BrowserEmbodimentStatus | null;
  error?: string;
}>;

export function EmbodimentSection({
  stream,
  companionId,
  companionName,
  connected,
  signedIn,
}: {
  stream: Pick<HubStreamStore, 'primaryEmbodiment'> | null;
  companionId: string | null;
  companionName: string;
  connected: boolean;
  signedIn: boolean;
}) {
  const port = connected ? stream?.primaryEmbodiment : undefined;
  const [state, setState] = useState<EmbodimentReadState | null>(null);
  const attemptRef = useRef(0);
  const current = port && state?.port === port && state.companionId === companionId ? state : null;
  const busy = current?.phase === 'loading' || current?.phase === 'switching';
  const status = current?.phase === 'ready' ? current.status : null;

  const request = useCallback(async (expectedGeneration?: number) => {
    if (!port || !companionId) return;
    const attempt = ++attemptRef.current;
    const owner = { port, companionId };
    const switching = expectedGeneration !== undefined;
    setState({ ...owner, phase: switching ? 'switching' : 'loading', status: null });
    try {
      const next = switching ? await port.handoff(expectedGeneration) : await port.read();
      if (attemptRef.current === attempt) setState({ ...owner, phase: 'ready', status: next });
    } catch {
      if (attemptRef.current === attempt) {
        setState({
          ...owner,
          phase: 'error',
          status: null,
          error: switching
            ? 'The switch could not be confirmed. Refresh the status before trying again.'
            : 'Embodiment status is unavailable. Refresh to try again.',
        });
      }
    }
  }, [port, companionId]);

  useEffect(() => {
    void request();
    return () => { attemptRef.current += 1; };
  }, [request]);

  return (
    <section className="settings-section" aria-label="Primary embodiment">
      <h2>Primary embodiment</h2>
      <p>Choose where {companionName || 'your companion'} is embodied. Switching to this device moves their primary presence from the previous device.</p>
      <p role="status" aria-live="polite">
        {!connected || !companionId ? 'Connect to a companion to check this device.'
          : !port ? 'Embodiment controls are unavailable on this connection.'
            : current?.phase === 'switching' ? 'Switching primary embodiment to this device…'
              : !current || current.phase === 'loading' ? 'Checking primary embodiment…'
                : status?.currentDeviceIsPrimary ? 'This device is the primary embodiment.'
                  : status?.primaryPresent ? 'Another device is the primary embodiment.'
                    : status ? 'No device is currently the primary embodiment.'
                      : current.error}
      </p>
      {!signedIn && <p>Sign in as a Partner to switch primary embodiment.</p>}
      <div className="drawer-actions">
        <button
          className="primary-action"
          type="button"
          disabled={!signedIn || !status || status.currentDeviceIsPrimary || busy}
          onClick={() => {
            if (signedIn && status && !status.currentDeviceIsPrimary && !busy) void request(status.generation);
          }}
        >
          {current?.phase === 'switching' ? <Loader2 aria-hidden className="spin" />
            : status?.currentDeviceIsPrimary ? <ShieldCheck aria-hidden /> : <MonitorSmartphone aria-hidden />}
          {status?.currentDeviceIsPrimary ? 'Primary on this device' : 'Use this device as primary'}
        </button>
        <button type="button" onClick={() => { void request(); }} disabled={!port || !companionId || busy}>
          <RefreshCw aria-hidden /> Refresh status
        </button>
      </div>
    </section>
  );
}
