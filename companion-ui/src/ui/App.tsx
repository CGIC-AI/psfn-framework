import {
  CircleStop,
  Menu,
  Settings,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
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
import { CompanionSprite, deriveSpriteState } from './companion-sprite.js';
import { Composer } from './composer.js';
import { useComposerController } from './composer-controller.js';
import { AttachmentTray, ToastLayer } from './context-layers.js';
import { OverlayFrame } from './overlay-drawer.js';
import { SettingsDrawer } from './settings-drawer.js';
import { ThreadView } from './thread-view.js';
import type { ActivityFilter, OverlayDrawer } from './types.js';
import { readCompanionUiRuntimeConfig } from './config.js';

export function App() {
  const [configError, setConfigError] = useState<string | null>(null);
  const [hubUrl, setHubUrl] = useState('');
  const [sessionId, setSessionId] = useState('psfn-satellite-mobile-chat-app');
  const [channelId, setChannelId] = useState('');
  const [streamState, setStreamState] = useState<HubStreamState>(() => createInitialHubStreamState());
  const [connecting, setConnecting] = useState(false);
  const [overlay, setOverlay] = useState<OverlayDrawer>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [autoConnect, setAutoConnect] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState('exponential');
  const [spriteEnabled, setSpriteEnabled] = useState(true);
  const [spriteAnimations, setSpriteAnimations] = useState(true);
  const composer = useComposerController();
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
  const spriteState = deriveSpriteState(streamState, traces, composer.micActive, connecting);

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

  function sendUserText(text: string) {
    storeRef.current?.sendUserText(text, { interrupt: true });
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

      <ThreadView streamState={streamState} />

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
        stacked={composer.pendingAttachments.length > 0}
        voiceNotice={composer.voiceNotice}
      />

      {composer.pendingAttachments.length > 0 && (
        <AttachmentTray attachments={composer.pendingAttachments} onRemove={composer.removeAttachment} />
      )}

      <Composer canSend={canSend} controller={composer} onSendText={sendUserText} />

      {overlay && (
        <OverlayFrame onClose={() => setOverlay(null)}>
          {overlay === 'settings' ? (
            <SettingsDrawer
              autoConnect={autoConnect}
              autoReconnect={autoReconnect}
              channelId={channelId}
              connecting={connecting}
              hubUrl={hubUrl}
              micMode={composer.micMode}
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
              onMicModeChange={composer.selectMicMode}
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
