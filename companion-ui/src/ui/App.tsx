import {
  Activity,
  AlertTriangle,
  Camera,
  ChevronDown,
  CircleStop,
  FileText,
  Image,
  Loader2,
  LockKeyhole,
  Menu,
  Mic,
  Paperclip,
  Plug,
  Plus,
  Radio,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  FormEvent,
  KeyboardEvent,
  type ReactNode,
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PSFN_SATELLITE_MOBILE_CHAT_APP_NAME,
} from '../lib/api/auth.js';
import { SatelliteHubClient } from '../lib/api/client.js';
import { deriveApprovalPanelState } from '../lib/approvals.js';
import { deriveArtifactShelfState } from '../lib/artifacts.js';
import {
  createInitialHubStreamState,
  HubStreamStore,
  type HubStreamState,
} from '../lib/stream/hub-stream.js';
import { deriveOperationalTraces, type OperationalTrace } from '../lib/traces.js';
import { readCompanionUiRuntimeConfig } from './config.js';

type OverlayDrawer = 'activity' | 'settings' | null;
type ActivityFilter = 'all' | 'messages' | 'artifacts' | 'approvals' | 'voice' | 'tools' | 'system' | 'errors';
type MicMode = 'dictation' | 'voice';
type SpriteState = 'attentive' | 'speaking' | 'listening' | 'thinking' | 'tool_use' | 'error';
type AttachmentKind = 'file' | 'image' | 'camera';

interface PendingAttachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mediaType: string;
  size: number;
}

const ACTIVITY_FILTERS: ActivityFilter[] = [
  'all',
  'messages',
  'artifacts',
  'approvals',
  'voice',
  'tools',
  'system',
  'errors',
];

export function App() {
  const [configError, setConfigError] = useState<string | null>(null);
  const [hubUrl, setHubUrl] = useState('');
  const [sessionId, setSessionId] = useState('psfn-satellite-mobile-chat-app');
  const [channelId, setChannelId] = useState('');
  const [streamState, setStreamState] = useState<HubStreamState>(() => createInitialHubStreamState());
  const [input, setInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [overlay, setOverlay] = useState<OverlayDrawer>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [micMode, setMicMode] = useState<MicMode>('dictation');
  const [micActive, setMicActive] = useState(false);
  const [autoConnect, setAutoConnect] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState('exponential');
  const [spriteEnabled, setSpriteEnabled] = useState(true);
  const [spriteAnimations, setSpriteAnimations] = useState(true);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const storeRef = useRef<HubStreamStore | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

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
    const inputElement = inputRef.current;
    if (!inputElement) return;
    inputElement.style.height = 'auto';
    inputElement.style.height = `${Math.min(inputElement.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [streamState.messages.length, streamState.liveAssistant?.content]);

  useEffect(() => {
    if (overlay === null) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOverlay(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [overlay]);

  useEffect(() => {
    if (!autoConnect || !hubUrl || storeRef.current || connecting) return;
    void connect();
  }, [autoConnect, connecting, hubUrl]);

  const identityLabel = useMemo(() => {
    const companion = streamState.session?.identity?.companion?.name;
    const user = streamState.session?.identity?.user?.name;
    if (companion && user) return `${companion} / ${user}`;
    if (companion) return companion;
    return PSFN_SATELLITE_MOBILE_CHAT_APP_NAME;
  }, [streamState.session?.identity?.companion?.name, streamState.session?.identity?.user?.name]);

  const traces = useMemo(() => deriveOperationalTraces(streamState), [streamState]);
  const filteredTraces = useMemo(
    () => traces.filter((trace) => traceMatchesFilter(trace, activityFilter)),
    [activityFilter, traces],
  );
  const approvals = useMemo(() => deriveApprovalPanelState(streamState), [streamState]);
  const artifacts = useMemo(() => deriveArtifactShelfState(streamState), [streamState]);
  const canSend = streamState.connection === 'ready' || streamState.connection === 'connected';
  const connectionTone = getConnectionTone(streamState.connection, connecting);
  const spriteState = deriveSpriteState(streamState, traces, micActive, connecting);

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
      setConfigError(null);
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

  function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = input.trim();
    if (!text) return;
    storeRef.current?.sendUserText(text, { interrupt: true });
    setInput('');
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    sendMessage();
  }

  function toggleMic() {
    setMicActive((value) => {
      const next = !value;
      setVoiceNotice(next
        ? `${micMode === 'dictation' ? 'Dictation' : 'Voice chat'} capture is selected. Browser audio capture is not wired to the hub yet, so text remains the source of truth.`
        : null);
      return next;
    });
  }

  function switchMicMode() {
    setMicMode((value) => (value === 'dictation' ? 'voice' : 'dictation'));
    setMicActive(false);
    setVoiceNotice(null);
  }

  function openAttachmentPicker(kind: AttachmentKind) {
    setAttachmentMenuOpen(false);
    if (kind === 'file') fileInputRef.current?.click();
    if (kind === 'image') imageInputRef.current?.click();
    if (kind === 'camera') cameraInputRef.current?.click();
  }

  function handleAttachmentFiles(event: ChangeEvent<HTMLInputElement>, kind: AttachmentKind) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setPendingAttachments((current) => [
      ...current,
      ...files.map((file) => ({
        id: `${kind}:${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
        kind,
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
      })),
    ]);
    event.target.value = '';
  }

  function removeAttachment(id: string) {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  return (
    <main className="app-shell">
      <div className="ornament ornament-left" aria-hidden />
      <div className="ornament ornament-right" aria-hidden />

      <button
        className="floating-button activity-button"
        type="button"
        onClick={() => setOverlay('activity')}
        aria-label="Open activity and events"
      >
        <Menu aria-hidden />
      </button>

      <div className="floating-status" aria-label={`Connection ${streamState.connection}`}>
        {connectionTone === 'bad' ? <WifiOff aria-hidden /> : <Wifi aria-hidden />}
        <span>{connecting ? 'Connecting' : streamState.connection}</span>
      </div>

      <button
        className="floating-button settings-button"
        type="button"
        onClick={() => setOverlay('settings')}
        aria-label="Open settings"
      >
        <Settings aria-hidden />
      </button>

      <section className="thread-viewport" aria-label="Companion chat">
        <div className="message-list" aria-live="polite">
          {streamState.messages.length === 0 && !streamState.liveAssistant ? (
            <div className="thread-empty">
              <Sparkles aria-hidden />
              <p>{streamState.connection === 'ready' ? 'Ready for the thread.' : 'Open settings to connect.'}</p>
            </div>
          ) : (
            <>
              {streamState.messages.map((message) => (
                <article className={`message-row ${message.role}`} key={message.id}>
                  {message.role === 'assistant' && <AvatarMark />}
                  <div className="message-bubble">
                    <p>{message.content}</p>
                  </div>
                </article>
              ))}
              {streamState.liveAssistant && (
                <article className="message-row assistant live">
                  <AvatarMark />
                  <div className="message-bubble">
                    <p>{streamState.liveAssistant.content}</p>
                  </div>
                </article>
              )}
            </>
          )}
          <div ref={threadEndRef} />
        </div>
      </section>

      {spriteEnabled && (
        <CompanionSprite
          state={spriteState}
          animated={spriteAnimations}
          label={identityLabel}
        />
      )}

      <ToastLayer
        approvals={approvals}
        artifacts={artifacts}
        error={streamState.failure?.message ?? configError}
        stacked={pendingAttachments.length > 0}
        voiceNotice={voiceNotice}
      />

      {pendingAttachments.length > 0 && (
        <AttachmentTray attachments={pendingAttachments} onRemove={removeAttachment} />
      )}

      <form className="composer-shell" onSubmit={sendMessage}>
        <div className="composer-menu-wrap">
          <button
            className="composer-button"
            type="button"
            onClick={() => setAttachmentMenuOpen((value) => !value)}
            aria-expanded={attachmentMenuOpen}
            aria-label="Open attachment menu"
          >
            <Plus aria-hidden />
          </button>
          {attachmentMenuOpen && <AttachmentMenu onPick={openAttachmentPicker} />}
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            onChange={(event) => handleAttachmentFiles(event, 'file')}
          />
          <input
            ref={imageInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => handleAttachmentFiles(event, 'image')}
          />
          <input
            ref={cameraInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => handleAttachmentFiles(event, 'camera')}
          />
        </div>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder="Message your companion..."
          rows={1}
          disabled={!canSend}
          aria-label="Message your companion"
        />
        <div className="mic-control">
          <button
            className={`composer-button mic-button ${micActive ? 'active' : ''} ${micMode}`}
            type="button"
            onClick={toggleMic}
            title={micMode === 'dictation' ? 'Dictation' : 'Voice chat'}
            aria-label={micMode === 'dictation' ? 'Toggle dictation' : 'Toggle voice chat'}
          >
            <Mic aria-hidden />
          </button>
          <button className="mic-mode" type="button" onClick={switchMicMode}>
            {micMode === 'dictation' ? 'Dictation' : 'Voice'}
          </button>
        </div>
        <button
          className="send-button"
          type="submit"
          disabled={!canSend || !input.trim()}
          aria-label="Send message"
        >
          <Send aria-hidden />
        </button>
      </form>

      {overlay && (
        <OverlayFrame onClose={() => setOverlay(null)}>
          {overlay === 'settings' ? (
            <SettingsDrawer
              autoConnect={autoConnect}
              autoReconnect={autoReconnect}
              channelId={channelId}
              connecting={connecting}
              hubUrl={hubUrl}
              micMode={micMode}
              sessionId={sessionId}
              spriteAnimations={spriteAnimations}
              spriteEnabled={spriteEnabled}
              streamState={streamState}
              onAutoConnectChange={setAutoConnect}
              onAutoReconnectChange={setAutoReconnect}
              onChannelIdChange={setChannelId}
              onClose={() => setOverlay(null)}
              onConnect={() => void connect()}
              onDisconnect={disconnect}
              onHubUrlChange={setHubUrl}
              onMicModeChange={setMicMode}
              onSessionIdChange={setSessionId}
              onSpriteAnimationsChange={setSpriteAnimations}
              onSpriteEnabledChange={setSpriteEnabled}
            />
          ) : (
            <ActivityDrawer
              filter={activityFilter}
              onClose={() => setOverlay(null)}
              onFilterChange={setActivityFilter}
              traces={filteredTraces}
              totalCount={traces.length}
            />
          )}
        </OverlayFrame>
      )}

      <button
        className="interrupt-fab"
        type="button"
        onClick={interrupt}
        disabled={!canSend}
        aria-label="Interrupt companion"
      >
        <CircleStop aria-hidden />
      </button>
    </main>
  );
}

function OverlayFrame({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="overlay-root" role="presentation">
      <button className="overlay-backdrop" type="button" onClick={onClose} aria-label="Close overlay" />
      {children}
    </div>
  );
}

function SettingsDrawer({
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

function ActivityDrawer({
  filter,
  onClose,
  onFilterChange,
  traces,
  totalCount,
}: {
  filter: ActivityFilter;
  onClose: () => void;
  onFilterChange: (filter: ActivityFilter) => void;
  traces: OperationalTrace[];
  totalCount: number;
}) {
  return (
    <aside className="overlay-drawer activity-drawer" aria-label="Activity and events">
      <DrawerHeader icon={<Activity aria-hidden />} title="Activity" onClose={onClose} />
      <div className="drawer-content">
        <div className="filter-bar" role="tablist" aria-label="Activity filters">
          {ACTIVITY_FILTERS.map((option) => (
            <button
              className={filter === option ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={filter === option}
              onClick={() => onFilterChange(option)}
              key={option}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="activity-count">
          Showing {traces.length} of {totalCount}
        </div>
        <div className="event-list">
          {traces.length === 0 ? (
            <p className="drawer-empty">No matching events</p>
          ) : (
            traces.slice().reverse().map((trace) => <TraceRow trace={trace} key={trace.id} />)
          )}
        </div>
      </div>
    </aside>
  );
}

function DrawerHeader({
  icon,
  onClose,
  title,
}: {
  icon: ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <header className="drawer-header">
      <div>
        {icon}
        <h1>{title}</h1>
      </div>
      <button type="button" onClick={onClose} aria-label={`Close ${title}`}>
        <X aria-hidden />
      </button>
    </header>
  );
}

function TraceRow({ trace }: { trace: OperationalTrace }) {
  return (
    <article className={`event-row ${trace.status}`}>
      <div className="event-icon">{iconForTrace(trace)}</div>
      <div className="event-body">
        <div>
          <strong>{titleForTrace(trace)}</strong>
          <time>{formatClock(trace.receivedAt)}</time>
        </div>
        <p>{trace.summary}</p>
        <dl>
          <div>
            <dt>Type</dt>
            <dd>{trace.type}</dd>
          </div>
          <div>
            <dt>Seq</dt>
            <dd>{trace.sequence}</dd>
          </div>
          {Object.entries(trace.metadata).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

function ToastLayer({
  approvals,
  artifacts,
  error,
  stacked,
  voiceNotice,
}: {
  approvals: ReturnType<typeof deriveApprovalPanelState>;
  artifacts: ReturnType<typeof deriveArtifactShelfState>;
  error: string | null;
  stacked: boolean;
  voiceNotice: string | null;
}) {
  const hasToasts = error || voiceNotice || approvals.requests.length > 0 || artifacts.items.length > 0;
  if (!hasToasts) return null;

  return (
    <section className={`toast-layer ${stacked ? 'stacked' : ''}`} aria-label="Contextual updates">
      {voiceNotice && (
        <article className="context-toast voice-toast">
          <Mic aria-hidden />
          <div>
            <strong>Voice Mode</strong>
            <p>{voiceNotice}</p>
          </div>
        </article>
      )}
      {error && (
        <article className="context-toast error-toast">
          <AlertTriangle aria-hidden />
          <div>
            <strong>Connection issue</strong>
            <p>{error}</p>
          </div>
        </article>
      )}
      {approvals.requests.map((request) => (
        <article className="context-toast approval-toast" key={request.id}>
          <LockKeyhole aria-hidden />
          <div>
            <strong>Approval Request</strong>
            <p>{request.redactedContext}</p>
            <div className="toast-actions">
              <button type="button" disabled>Deny</button>
              <button type="button" disabled>Approve</button>
            </div>
          </div>
        </article>
      ))}
      {artifacts.items.map((item) => (
        <article className="context-toast artifact-toast" key={item.id}>
          <FileText aria-hidden />
          <div>
            <strong>Artifact Created</strong>
            <p>{item.label} · {item.mediaType}</p>
            <div className="toast-actions">
              <button type="button" disabled>View</button>
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <section className="attachment-tray" aria-label="Pending attachments">
      {attachments.map((attachment) => (
        <article className="pending-attachment" key={attachment.id}>
          {attachment.kind === 'file' ? <Paperclip aria-hidden /> : <Image aria-hidden />}
          <div>
            <strong>{attachment.name}</strong>
            <p>{attachment.mediaType} · {formatFileSize(attachment.size)} · local only</p>
          </div>
          <button type="button" onClick={() => onRemove(attachment.id)} aria-label={`Remove ${attachment.name}`}>
            <X aria-hidden />
          </button>
        </article>
      ))}
    </section>
  );
}

function CompanionSprite({
  animated,
  label,
  state,
}: {
  animated: boolean;
  label: string;
  state: SpriteState;
}) {
  return (
    <button
      className={`companion-sprite ${state} ${animated ? 'animated' : 'static'}`}
      type="button"
      aria-label={`${label} sprite, ${state}`}
      title={label}
    >
      <span className="sprite-aura" aria-hidden />
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

function AttachmentMenu({ onPick }: { onPick: (kind: AttachmentKind) => void }) {
  return (
    <div className="attachment-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => onPick('file')}>
        <Paperclip aria-hidden />
        Upload file
      </button>
      <button type="button" role="menuitem" onClick={() => onPick('image')}>
        <Image aria-hidden />
        Upload image
      </button>
      <button type="button" role="menuitem" onClick={() => onPick('camera')}>
        <Camera aria-hidden />
        Take photo
      </button>
    </div>
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

function AvatarMark() {
  return (
    <div className="avatar-mark" aria-hidden>
      <Sparkles />
    </div>
  );
}

function traceMatchesFilter(trace: OperationalTrace, filter: ActivityFilter): boolean {
  if (filter === 'all') return true;
  const operation = trace.operationClass.toLowerCase();
  const type = trace.type.toLowerCase();
  switch (filter) {
    case 'messages':
      return type === 'message' || operation.includes('message');
    case 'artifacts':
      return operation.includes('artifact');
    case 'approvals':
      return operation.includes('approval');
    case 'voice':
      return operation.includes('relay_stt') || operation.includes('relay_tts') || type.includes('audio');
    case 'tools':
      return operation.includes('tool');
    case 'system':
      return operation.includes('hub') || operation.includes('heartbeat') || type === 'pong';
    case 'errors':
      return trace.status === 'failed' || type.includes('error');
  }
}

function iconForTrace(trace: OperationalTrace) {
  if (trace.status === 'failed') return <AlertTriangle aria-hidden />;
  if (trace.operationClass.includes('message')) return <Radio aria-hidden />;
  if (trace.operationClass.includes('relay')) return <Volume2 aria-hidden />;
  if (trace.operationClass.includes('hub')) return <Wifi aria-hidden />;
  return <ShieldCheck aria-hidden />;
}

function titleForTrace(trace: OperationalTrace): string {
  if (trace.operationClass.includes('assistant_message')) return 'Message Received';
  if (trace.operationClass.includes('user_message')) return 'Message Sent';
  if (trace.operationClass.includes('relay_stt')) return 'Voice Transcript';
  if (trace.operationClass.includes('relay_tts')) return 'Voice Playback';
  if (trace.operationClass.includes('hub_error')) return 'Error';
  if (trace.operationClass.includes('hub_session')) return 'Session Started';
  if (trace.operationClass.includes('hub_handshake')) return 'Connected';
  if (trace.operationClass.includes('hub_status')) return 'System';
  return trace.operationClass.replaceAll('_', ' ');
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function getConnectionTone(connection: HubStreamState['connection'], connecting: boolean): 'good' | 'wait' | 'bad' {
  if (connecting || connection === 'connecting') return 'wait';
  if (connection === 'ready' || connection === 'connected') return 'good';
  if (connection === 'failed' || connection === 'disconnected') return 'bad';
  return 'wait';
}

function deriveSpriteState(
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
