import {
  CircleStop,
  Menu,
  Mic,
  Plus,
  Send,
  Settings,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
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
import { deriveOperationalTraces } from '../lib/traces.js';
import { ActivityDrawer, traceMatchesFilter } from './activity-drawer.js';
import { AvatarMark, CompanionSprite, deriveSpriteState } from './companion-sprite.js';
import { AttachmentMenu, AttachmentTray, ToastLayer } from './context-layers.js';
import { OverlayFrame } from './overlay-drawer.js';
import { SettingsDrawer } from './settings-drawer.js';
import type { ActivityFilter, AttachmentKind, MicMode, OverlayDrawer, PendingAttachment } from './types.js';
import { readCompanionUiRuntimeConfig } from './config.js';

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

function getConnectionTone(connection: HubStreamState['connection'], connecting: boolean): 'good' | 'wait' | 'bad' {
  if (connecting || connection === 'connecting') return 'wait';
  if (connection === 'ready' || connection === 'connected') return 'good';
  if (connection === 'failed' || connection === 'disconnected') return 'bad';
  return 'wait';
}
