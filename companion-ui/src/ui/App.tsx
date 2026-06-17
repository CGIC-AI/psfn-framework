import {
  AlertTriangle,
  CircleStop,
  Loader2,
  Plug,
  Send,
  Signal,
  SignalZero,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  PSFN_SATELLITE_MOBILE_CHAT_APP_NAME,
} from '../lib/api/auth.js';
import { SatelliteHubClient } from '../lib/api/client.js';
import {
  createInitialHubStreamState,
  HubStreamStore,
  type HubStreamState,
} from '../lib/stream/hub-stream.js';
import { readCompanionUiRuntimeConfig } from './config.js';

export function App() {
  const [configError, setConfigError] = useState<string | null>(null);
  const [hubUrl, setHubUrl] = useState<string>('');
  const [sessionId, setSessionId] = useState('psfn-satellite-mobile-chat-app');
  const [channelId, setChannelId] = useState('');
  const [streamState, setStreamState] = useState<HubStreamState>(() => createInitialHubStreamState());
  const [input, setInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const storeRef = useRef<HubStreamStore | null>(null);

  useEffect(() => {
    try {
      const config = readCompanionUiRuntimeConfig();
      setHubUrl(config.hubWsUrl);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Missing Satellite Hub websocket URL');
    }

    return () => {
      storeRef.current?.destroy();
      storeRef.current = null;
    };
  }, []);

  const identityLabel = useMemo(() => {
    const companion = streamState.session?.identity?.companion?.name;
    const user = streamState.session?.identity?.user?.name;
    if (companion && user) return `${companion} / ${user}`;
    if (companion) return companion;
    return PSFN_SATELLITE_MOBILE_CHAT_APP_NAME;
  }, [streamState.session?.identity?.companion?.name, streamState.session?.identity?.user?.name]);

  async function connect() {
    if (!hubUrl || connecting) return;
    setConnecting(true);
    storeRef.current?.destroy();
    const client = new SatelliteHubClient({
      url: hubUrl,
      sessionId,
      channelId: channelId.trim() || undefined,
    });
    const store = new HubStreamStore(client);
    storeRef.current = store;
    store.subscribe(setStreamState);
    try {
      await store.connect();
    } catch (error) {
      setStreamState((current) => ({
        ...current,
        connection: 'failed',
        phase: 'failed',
        failure: {
          message: error instanceof Error ? error.message : 'Failed to connect to Satellite Hub',
          recoverable: false,
          at: new Date().toISOString(),
          cause: error,
        },
      }));
    } finally {
      setConnecting(false);
    }
  }

  function disconnect() {
    storeRef.current?.disconnect();
  }

  function interrupt() {
    storeRef.current?.interrupt();
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    storeRef.current?.sendUserText(text, { interrupt: true });
    setInput('');
  }

  const canSend = streamState.connection === 'ready' || streamState.connection === 'connected';
  const connectionTone = streamState.connection === 'ready'
    ? 'good'
    : streamState.connection === 'failed' || streamState.connection === 'disconnected'
      ? 'bad'
      : 'wait';

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Satellite connection">
        <div>
          <p className="eyebrow">Satellite</p>
          <h1>{identityLabel}</h1>
        </div>
        <StatusPill tone={connectionTone} label={streamState.connection} />
      </section>

      <section className="setup-panel" aria-label="Connection settings">
        <label>
          <span>Hub WS</span>
          <input
            value={hubUrl}
            onChange={(event) => setHubUrl(event.target.value)}
            placeholder="ws://hub.local:8787/"
            inputMode="url"
          />
        </label>
        <label>
          <span>Session</span>
          <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
        </label>
        <label>
          <span>Channel</span>
          <input value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="optional" />
        </label>
        <div className="setup-actions">
          <button className="primary" type="button" onClick={() => void connect()} disabled={!hubUrl || connecting}>
            {connecting ? <Loader2 aria-hidden className="spin" /> : <Plug aria-hidden />}
            Connect
          </button>
          <button type="button" onClick={disconnect} disabled={streamState.connection === 'idle'}>
            <CircleStop aria-hidden />
            Close
          </button>
        </div>
      </section>

      {(configError || streamState.failure) && (
        <section className="failure-band" role="status">
          <AlertTriangle aria-hidden />
          <span>{streamState.failure?.message ?? configError}</span>
        </section>
      )}

      <section className="presence-strip" aria-label="Presence">
        <PresenceItem label="Connection" value={streamState.connection} />
        <PresenceItem label="Phase" value={streamState.phase} />
        <PresenceItem label="Status" value={streamState.status ?? 'none'} />
        <PresenceItem label="Events" value={String(streamState.sequence)} />
      </section>

      <section className="chat-pane" aria-label="Chat">
        <div className="messages">
          {streamState.messages.length === 0 && !streamState.liveAssistant ? (
            <div className="empty-state">
              {streamState.connection === 'ready' ? <Signal aria-hidden /> : <SignalZero aria-hidden />}
              <p>{streamState.connection === 'ready' ? 'Ready' : 'Disconnected'}</p>
            </div>
          ) : (
            <>
              {streamState.messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <p>{message.content}</p>
                </article>
              ))}
              {streamState.liveAssistant && (
                <article className="message assistant live">
                  <p>{streamState.liveAssistant.content}</p>
                </article>
              )}
            </>
          )}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <button type="button" onClick={interrupt} disabled={!canSend} title="Interrupt">
            <CircleStop aria-hidden />
          </button>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Message"
            rows={1}
            disabled={!canSend}
          />
          <button className="primary icon-only" type="submit" disabled={!canSend || !input.trim()} title="Send">
            <Send aria-hidden />
          </button>
        </form>
      </section>
    </main>
  );
}

function PresenceItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ tone, label }: { tone: 'good' | 'wait' | 'bad'; label: string }) {
  return <div className={`status-pill ${tone}`}>{label}</div>;
}
