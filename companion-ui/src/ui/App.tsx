import {
  AlertTriangle,
  CircleStop,
  ChevronDown,
  ChevronRight,
  FileX2,
  Loader2,
  LockKeyhole,
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
import { derivePresenceState, formatElapsed } from '../lib/presence.js';
import { deriveOperationalTraces, type OperationalTrace } from '../lib/traces.js';
import { deriveApprovalPanelState } from '../lib/approvals.js';
import { deriveArtifactShelfState } from '../lib/artifacts.js';
import { readCompanionUiRuntimeConfig } from './config.js';

export function App() {
  const [configError, setConfigError] = useState<string | null>(null);
  const [hubUrl, setHubUrl] = useState<string>('');
  const [sessionId, setSessionId] = useState('psfn-satellite-mobile-chat-app');
  const [channelId, setChannelId] = useState('');
  const [streamState, setStreamState] = useState<HubStreamState>(() => createInitialHubStreamState());
  const [input, setInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
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
  const presence = derivePresenceState(streamState, nowMs);
  const traces = useMemo(() => deriveOperationalTraces(streamState), [streamState]);
  const approvals = useMemo(() => deriveApprovalPanelState(streamState), [streamState]);
  const artifacts = useMemo(() => deriveArtifactShelfState(streamState), [streamState]);
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

        <ActivityStrip presence={presence} eventCount={streamState.sequence} status={streamState.status} />
        <TraceDrawer open={drawerOpen} traces={traces} onToggle={() => setDrawerOpen((value) => !value)} />
        <ApprovalPanel state={approvals} />
        <ArtifactShelf state={artifacts} />

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

function ActivityStrip({
  presence,
  eventCount,
  status,
}: {
  presence: ReturnType<typeof derivePresenceState>;
  eventCount: number;
  status: string | null;
}) {
  return (
    <section className={`activity-strip ${presence.failed ? 'failed' : ''}`} aria-label="Activity">
      <PresenceItem label="Connection" value={presence.connection} />
      <PresenceItem label="Phase" value={presence.phase} />
      <PresenceItem label="Operation" value={presence.operationClass} />
      <PresenceItem label="Elapsed" value={formatElapsed(presence.elapsedMs)} />
      <PresenceItem label="Input" value={presence.inputExpected} />
      <PresenceItem label="Emanation" value={presence.satelliteId ?? presence.emanation} />
      <PresenceItem label="Status" value={status ?? presence.silence} />
      <PresenceItem label="Events" value={String(eventCount)} />
    </section>
  );
}

function TraceDrawer({
  open,
  traces,
  onToggle,
}: {
  open: boolean;
  traces: OperationalTrace[];
  onToggle: () => void;
}) {
  const latest = traces.at(-1);
  return (
    <section className="trace-drawer" aria-label="Operational traces">
      <button type="button" onClick={onToggle} className="trace-toggle" aria-expanded={open}>
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        <span>Activity</span>
        <strong>{latest ? latest.operationClass : 'none'}</strong>
      </button>
      {open && (
        <div className="trace-list">
          {traces.length === 0 ? (
            <p className="trace-empty">No hub events</p>
          ) : traces.slice(-12).map((trace) => (
            <TraceRow trace={trace} key={trace.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function TraceRow({ trace }: { trace: OperationalTrace }) {
  return (
    <article className={`trace-row ${trace.status}`}>
      <div>
        <strong>{trace.operationClass}</strong>
        <span>{trace.summary}</span>
      </div>
      <dl>
        <div>
          <dt>Seq</dt>
          <dd>{trace.sequence}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{trace.type}</dd>
        </div>
        {Object.entries(trace.metadata).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function ApprovalPanel({ state }: { state: ReturnType<typeof deriveApprovalPanelState> }) {
  return (
    <section className="approval-panel" aria-label="Approvals">
      <div>
        <LockKeyhole aria-hidden />
        <strong>Approvals</strong>
      </div>
      {state.requests.length === 0 ? (
        <p>{state.blockedReason ?? 'No pending approvals'}</p>
      ) : (
        state.requests.map((request) => (
          <article className="approval-card" key={request.id}>
            <strong>{request.title}</strong>
            <p>{request.redactedContext}</p>
          </article>
        ))
      )}
    </section>
  );
}

function ArtifactShelf({ state }: { state: ReturnType<typeof deriveArtifactShelfState> }) {
  return (
    <section className="artifact-shelf" aria-label="Artifacts">
      <div>
        <FileX2 aria-hidden />
        <strong>Artifacts</strong>
      </div>
      {state.items.length === 0 ? (
        <p>{state.blockedReason ?? 'No artifacts'}</p>
      ) : (
        state.items.map((item) => (
          <article className="artifact-item" key={item.id}>
            <strong>{item.label}</strong>
            <p>{item.mediaType} · {item.provenance}</p>
          </article>
        ))
      )}
    </section>
  );
}

function StatusPill({ tone, label }: { tone: 'good' | 'wait' | 'bad'; label: string }) {
  return <div className={`status-pill ${tone}`}>{label}</div>;
}
