import {
  Menu,
  Heart,
  Settings,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PSFN_SATELLITE_MOBILE_CHAT_APP_NAME } from '../lib/api/auth.js';
import { CompanionGatewayClient } from '../lib/api/gateway-client.js';
import {
  hasPendingApprovalExpiry,
  mergeFleetApprovals,
  routeFleetApprovalDecision,
} from '../lib/fleet-approval-routing.js';
import { deriveArtifactShelfState, readArtifactPreview } from '../lib/artifacts.js';
import {
  FleetSessionClient,
  type FleetSessionStatus,
} from '../lib/fleet-session.js';
import {
  getServiceWorkerUpdateReady,
  subscribeToServiceWorkerUpdates,
} from '../lib/service-worker-updates.js';
import {
  createInitialHubStreamState,
  HubStreamStore,
  type HubStreamState,
} from '../lib/stream/hub-stream.js';
import { deriveOperationalTraces } from '../lib/traces.js';
import { HeadpatCoalescer } from '../lib/touch-interactions.js';
import { useSpriteManifest } from '../lib/sprites/use-sprite-manifest.js';
import type { DeviceLocationSample } from '../lib/geolocation.js';
import { useDeviceLocation } from './use-device-location.js';
import { ActivityDrawer, traceMatchesFilter } from './activity-drawer.js';
import { CompanionSelectorPage } from './companion-selector.js';
import { CompanionSprite, deriveSpriteState } from './companion-sprite.js';
import { Composer } from './composer.js';
import { useComposerController } from './composer-controller.js';
import {
  readCompanionUiRuntimeConfig,
  resolveCompanionUiWebSocketUrl,
  type CompanionUiRuntimeConfig,
} from './config.js';
import { AttachmentTray, ToastLayer } from './context-layers.js';
import { OverlayFrame } from './overlay-drawer.js';
import {
  SettingsDrawer,
  type CompanionUiAccessPresentation,
} from './settings-drawer.js';
import { ThreadView } from './thread-view.js';
import type { ActivityFilter, OverlayDrawer } from './types.js';
import { useFleetRouting } from './use-fleet-routing.js';
import { useVoicePlayback } from './use-voice-playback.js';
import { useZ02Link } from './use-z02-link.js';
import { WishlistDrawer } from './wishlist-drawer.js';

type AccessState = FleetSessionStatus
  | Readonly<{ state: 'loading' | 'offline' }>
  | Readonly<{ state: 'guest'; guestMode: 'explicit'; websocketPath: string }>;

export function App() {
  const [runtime, setRuntime] = useState<CompanionUiRuntimeConfig | null>(null);
  const [access, setAccess] = useState<AccessState>({ state: 'loading' });
  const [configError, setConfigError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<HubStreamState>(() => createInitialHubStreamState());
  const [connecting, setConnecting] = useState(false);
  const [overlay, setOverlay] = useState<OverlayDrawer>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [spriteEnabled, setSpriteEnabled] = useState(true);
  const [spriteAnimations, setSpriteAnimations] = useState(true);
  const [spritePetted, setSpritePetted] = useState(false);
  const [touchError, setTouchError] = useState<string | null>(null);
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const composer = useComposerController({
    captureReady: false,
    playbackReady: streamState.voicePlayback.supported,
  });
  const spriteManifest = useSpriteManifest(spriteEnabled);
  const updateReady = useSyncExternalStore(
    subscribeToServiceWorkerUpdates,
    getServiceWorkerUpdateReady,
    () => false,
  );
  const fleetSessionRef = useRef<FleetSessionClient | null>(null);
  const storeRef = useRef<HubStreamStore | null>(null);
  const z02AudioStoreRef = useRef<HubStreamStore | null>(null);
  const headpatCoalescerRef = useRef<HeadpatCoalescer | null>(null);
  const headpatReactionTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const authorityEpochRef = useRef(0);
  const manualDisconnectRef = useRef(false);
  const fleet = useFleetRouting({
    accessState: access.state,
    connect,
    reportError: setConfigError,
  });
  const z02AudioRelay = useMemo(() => ({
    async start(): Promise<void> {
      const store = storeRef.current;
      if (!store) throw new Error('Companion is not connected');
      await store.startPcmAudioStream();
      z02AudioStoreRef.current = store;
    },
    write(pcm: Uint8Array): Promise<void> {
      const store = z02AudioStoreRef.current;
      if (!store) throw new Error('Companion audio stream is not ready');
      return store.sendPcmAudio(pcm);
    },
    async stop(): Promise<void> {
      const store = z02AudioStoreRef.current;
      z02AudioStoreRef.current = null;
      await store?.stopPcmAudioStream();
    },
  }), []);
  const z02Link = useZ02Link(undefined, { audioRelay: z02AudioRelay });
  const mouthOpen = useVoicePlayback(streamState.voicePlayback, storeRef.current);

  const sendDeviceLocation = useCallback((sample: DeviceLocationSample) => {
    // Only ever reached when the transport can terminate coordinates at a hub
    // (canSendLocation). Raw lat/lon must never cross into PSFN.
    storeRef.current?.sendDeviceLocation(sample);
  }, []);
  const canSendLocation =
    streamState.connection === 'ready' && (storeRef.current?.canSendDeviceLocation() ?? false);
  const locationStatus = useDeviceLocation({
    enabled: locationEnabled,
    canSend: canSendLocation,
    send: sendDeviceLocation,
  });

  useEffect(() => {
    const coalescer = new HeadpatCoalescer({
      emit: (interaction) => {
        try {
          const store = storeRef.current;
          if (!store) throw new Error('Satellite Hub is not connected');
          store.sendTouchInteraction(interaction);
          setTouchError(null);
        } catch (error) {
          setTouchError(error instanceof Error ? error.message : 'Headpat delivery failed');
        }
      },
    });
    headpatCoalescerRef.current = coalescer;
    try {
      setRuntime(readCompanionUiRuntimeConfig());
      fleetSessionRef.current = new FleetSessionClient();
      void refreshAuthority(true);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Companion UI configuration is invalid');
      setAccess({ state: 'offline' });
    }
    const onOffline = () => {
      clearHumanScopedState();
      setAccess({ state: 'offline' });
      setConfigError('Offline shell: authentication and device authority are unavailable');
    };
    const onOnline = () => { void refreshAuthority(true); };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      coalescer.destroy();
      headpatCoalescerRef.current = null;
      if (headpatReactionTimerRef.current !== null) window.clearTimeout(headpatReactionTimerRef.current);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      authorityEpochRef.current += 1;
      const store = storeRef.current;
      storeRef.current = null;
      store?.destroy();
      store?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (overlay === null) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOverlay(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [overlay]);

  useEffect(() => {
    if (manualDisconnectRef.current || !navigator.onLine
      || (access.state !== 'signed_in' && access.state !== 'guest')
      || (streamState.connection !== 'disconnected' && streamState.connection !== 'failed')
      || reconnectTimerRef.current !== null) return undefined;
    const delay = Math.min(30_000, 500 * (2 ** reconnectAttemptRef.current));
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current += 1;
      void refreshAuthority(true);
    }, delay);
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [access.state, streamState.connection]);

  const identityLabel = useMemo(
    () => streamState.session?.identity?.companion?.name ?? PSFN_SATELLITE_MOBILE_CHAT_APP_NAME,
    [streamState.session?.identity?.companion?.name],
  );
  const accessPresentation = useMemo(() => presentAccess(access), [access]);
  const hasPendingExpiry = useMemo(
    () => hasPendingApprovalExpiry(
      streamState,
      access.state === 'signed_in' ? fleet.approvals : [],
    ),
    [access.state, fleet.approvals, streamState],
  );

  useEffect(() => {
    if (!hasPendingExpiry) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasPendingExpiry]);

  const traces = useMemo(() => deriveOperationalTraces(streamState), [streamState]);
  const filteredTraces = useMemo(
    () => traces.filter(trace => traceMatchesFilter(trace, activityFilter)),
    [activityFilter, traces],
  );
  const approvals = useMemo(
    () => mergeFleetApprovals(
      streamState,
      access.state === 'signed_in' ? fleet.approvals : [],
      now,
      access.state === 'signed_in' ? fleet.approvalHistory : [],
    ),
    [access.state, fleet.approvalHistory, fleet.approvals, now, streamState],
  );
  const artifacts = useMemo(() => deriveArtifactShelfState(streamState), [streamState]);
  const canSend = (access.state === 'signed_in' || access.state === 'guest')
    && streamState.connection === 'ready';
  const connectionTone = getConnectionTone(streamState.connection, connecting);
  const spriteState = deriveSpriteState(streamState, traces, composer.micActive, connecting);
  const latestToolActivity = streamState.toolActivity.at(-1) ?? null;
  const latestTrace = traces.at(-1);
  const companionTalking = Boolean(streamState.liveAssistant)
    || (latestTrace?.operationClass === 'relay_tts' && latestTrace.status === 'active');
  const voiceStopActive = composer.micMode === 'voice' && companionTalking;
  const generationStopActive = Boolean(streamState.liveAssistant)
    || (z02Link.state.phase === 'linked' && streamState.phase === 'responding');

  async function refreshAuthority(connectWhenAllowed: boolean) {
    const authorityEpoch = authorityEpochRef.current + 1;
    authorityEpochRef.current = authorityEpoch;
    const fleetSession = fleetSessionRef.current;
    if (!fleetSession || !navigator.onLine) {
      clearHumanScopedState();
      setAccess({ state: 'offline' });
      return;
    }
    try {
      const status = await fleetSession.readStatus();
      if (authorityEpoch !== authorityEpochRef.current) return;
      setAccess(status);
      setConfigError(null);
      if (status.state === 'signed_out') {
        clearHumanScopedState();
      } else {
        await fleet.load(
          status,
          authorityEpoch,
          () => authorityEpoch === authorityEpochRef.current,
          connectWhenAllowed,
        );
      }
    } catch (error) {
      if (authorityEpoch !== authorityEpochRef.current) return;
      clearHumanScopedState();
      setAccess({ state: 'offline' });
      setConfigError(error instanceof Error ? error.message : 'Cluster session status failed');
    }
  }

  async function connect(
    path = websocketPath(access),
    expectedAuthorityEpoch?: number,
  ): Promise<boolean> {
    if (!path) return false;
    const authorityEpoch = expectedAuthorityEpoch ?? authorityEpochRef.current + 1;
    if (expectedAuthorityEpoch === undefined) authorityEpochRef.current = authorityEpoch;
    if (authorityEpoch !== authorityEpochRef.current) return false;
    manualDisconnectRef.current = false;
    setConnecting(true);
    const oldStore = storeRef.current;
    storeRef.current = null;
    oldStore?.destroy();
    oldStore?.disconnect();
    const client = new CompanionGatewayClient({
      url: resolveCompanionUiWebSocketUrl(path),
    });
    const store = new HubStreamStore(client);
    storeRef.current = store;
    store.subscribe((state) => {
      if (storeRef.current === store) setStreamState(state);
    });
    try {
      await store.connect();
      if (authorityEpoch !== authorityEpochRef.current) {
        store.destroy();
        store.disconnect();
        return false;
      }
      reconnectAttemptRef.current = 0;
      if (store.snapshot().session?.canListShards) {
        store.refreshShards();
      }
      setConfigError(null);
      return true;
    } catch (error) {
      if (authorityEpoch !== authorityEpochRef.current) {
        store.destroy();
        store.disconnect();
        return false;
      }
      setStreamState(current => ({
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
      return false;
    } finally {
      if (authorityEpoch === authorityEpochRef.current) setConnecting(false);
    }
  }

  function clearHumanScopedState() {
    authorityEpochRef.current += 1;
    const store = storeRef.current;
    storeRef.current = null;
    store?.destroy();
    store?.disconnect();
    setConnecting(false);
    setStreamState(createInitialHubStreamState());
    fleet.clear();
    composer.clearHumanScopedState();
    setTouchError(null);
  }

  function disconnect() {
    manualDisconnectRef.current = true;
    storeRef.current?.disconnect();
  }

  function login() {
    if (runtime) window.location.assign(runtime.loginPath);
  }

  async function logout() {
    const wasGuest = access.state === 'guest';
    const guestPath = (access.state === 'guest'
      || (access.state === 'signed_in' && access.guestMode === 'explicit'))
      ? access.websocketPath
      : undefined;
    clearHumanScopedState();
    setAccess(guestPath
      ? { schemaVersion: 1, state: 'signed_out', guestMode: 'explicit', websocketPath: guestPath }
      : { schemaVersion: 1, state: 'signed_out', guestMode: 'disabled' });
    if (wasGuest) return;
    try {
      await fleetSessionRef.current?.logout();
      await refreshAuthority(false);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Logout failed');
    }
  }

  async function switchUser() {
    clearHumanScopedState();
    try {
      await fleetSessionRef.current?.logout();
      login();
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Partner switch failed');
    }
  }

  function continueAsGuest() {
    if (access.state !== 'signed_out' || access.guestMode !== 'explicit' || !access.websocketPath) return;
    clearHumanScopedState();
    const guest: AccessState = {
      state: 'guest', guestMode: 'explicit', websocketPath: access.websocketPath,
    };
    setAccess(guest);
    void connect(guest.websocketPath);
  }

  function sendUserText(text: string) {
    if (canSend) storeRef.current?.sendUserText(text, { interrupt: true });
  }

  function giveHeadpat() {
    setSpritePetted(true);
    if (headpatReactionTimerRef.current !== null) window.clearTimeout(headpatReactionTimerRef.current);
    headpatReactionTimerRef.current = window.setTimeout(() => {
      setSpritePetted(false);
      headpatReactionTimerRef.current = null;
    }, 900);
    if (canSend) headpatCoalescerRef.current?.tap();
  }

  async function decideApproval(id: string, decision: 'approve' | 'deny') {
    if (access.state !== 'signed_in') return;
    const fleetApproval = fleet.approvals.find(entry => entry.id === id);
    try {
      await routeFleetApprovalDecision({
        id,
        decision,
        ...(fleetApproval ? { fleetApproval } : {}),
        activeCompanionId: fleet.activeCompanionIdRef.current,
        switchCompanion: fleet.select,
        currentStore: () => storeRef.current,
      });
    } catch {
      // The transport error event owns Partner-visible denial state.
    }
  }

  function previewArtifact(artifactId: string) {
    const store = storeRef.current;
    if (!store || access.state !== 'signed_in') return;
    try {
      readArtifactPreview(store, streamState, artifactId);
    } catch {
      // The transport error event owns Partner-visible denial state.
    }
  }

  return (
    <main className="app-shell">
      <div className="ornament ornament-left" aria-hidden />
      <div className="ornament ornament-right" aria-hidden />
      <button className="floating-button activity-button" type="button" onClick={() => setOverlay('activity')} aria-label="Open activity and events">
        <Menu aria-hidden />
      </button>
      <button
        className="floating-button wishlist-button"
        type="button"
        onClick={() => setOverlay('wishlist')}
        aria-label="Open wishlist"
      >
        <Heart aria-hidden />
      </button>
      <button
        className="floating-button companions-button"
        type="button"
        onClick={() => setOverlay('companions')}
        aria-label="Choose a companion"
      >
        <Users aria-hidden />
      </button>

      <div className="floating-status" aria-label={`Connection ${streamState.connection}`}>
        {connectionTone === 'bad' ? <WifiOff aria-hidden /> : <Wifi aria-hidden />}
        <span>{connecting ? 'Connecting' : streamState.connection}</span>
      </div>
      <button className="floating-button settings-button" type="button" onClick={() => setOverlay('settings')} aria-label="Open settings">
        <Settings aria-hidden />
      </button>

      <section className="authority-summary" aria-label="Current Partner and device authority">
        <span aria-label="Partner authority">Partner: {accessPresentation.humanLabel}</span>
        <span aria-label="Device authority">Device: {streamState.session?.deviceName ?? 'not attached'}</span>
        <span aria-label="Place authority">Place: {streamState.session?.place?.name ?? 'not available'}</span>
      </section>

      <ThreadView
        streamState={streamState}
        targetLabel={streamState.session?.activeShardId
          ? streamState.session.shards?.find(
              shard => shard.shardId === streamState.session?.activeShardId,
            )?.label
          : undefined}
      />
      {spriteEnabled && (
        <CompanionSprite
          state={spriteState}
          animated={spriteAnimations}
          label={identityLabel}
          mouthOpen={mouthOpen}
          onHeadpat={giveHeadpat}
          petted={spritePetted}
          manifest={spriteManifest.state === 'ready' ? spriteManifest.manifest : null}
          touch={spritePetted ? 'headpat-happy' : null}
          emotion={streamState.emotion}
          toolActivity={latestToolActivity}
        />
      )}
      <ToastLayer
        approvals={approvals}
        artifacts={artifacts}
        error={streamState.failure?.message ?? touchError ?? configError}
        onApprovalDecision={(id, decision) => { void decideApproval(id, decision); }}
        onArtifactPreview={previewArtifact}
        stacked={composer.pendingAttachments.length > 0}
        updateReady={updateReady}
        voiceNotice={composer.voiceNotice}
      />
      {composer.pendingAttachments.length > 0 && (
        <AttachmentTray attachments={composer.pendingAttachments} onRemove={composer.removeAttachment} />
      )}
      <Composer
        canSend={canSend}
        controller={composer}
        generationStopActive={generationStopActive}
        onSendText={sendUserText}
        onStopGeneration={() => storeRef.current?.interrupt()}
        voiceStopActive={voiceStopActive}
        targetLabel={streamState.session?.activeShardId
          ? streamState.session.shards?.find(
              shard => shard.shardId === streamState.session?.activeShardId,
            )?.label
          : undefined}
      />
      {overlay && (
        <OverlayFrame onClose={() => setOverlay(null)} side={overlay === 'activity' ? 'left' : 'right'}>
          {overlay === 'settings' ? (
            <SettingsDrawer
              access={accessPresentation}
              activeCompanionId={fleet.activeCompanionId}
              companions={fleet.roster}
              connecting={connecting}
              micMode={composer.micMode}
              spriteAnimations={spriteAnimations}
              spriteEnabled={spriteEnabled}
              locationEnabled={locationEnabled}
              locationStatus={locationStatus}
              streamState={streamState}
              z02LinkState={z02Link.state}
              onClose={() => setOverlay(null)}
              onLocationEnabledChange={setLocationEnabled}
              onConnect={() => void refreshAuthority(true)}
              onDisconnect={disconnect}
              onGuest={() => {
                setOverlay(null);
                continueAsGuest();
              }}
              onLogin={login}
              onLogout={() => {
                setOverlay(null);
                void logout();
              }}
              onMicModeChange={composer.selectMicMode}
              onCompanionChange={(companionId) => { void fleet.select(companionId); }}
              onSpriteAnimationsChange={setSpriteAnimations}
              onSpriteEnabledChange={setSpriteEnabled}
              onSwitchUser={() => {
                setOverlay(null);
                void switchUser();
              }}
              onZ02Disconnect={z02Link.disconnect}
              onZ02Link={() => { void z02Link.link(); }}
            />
          ) : overlay === 'wishlist' ? (
            <WishlistDrawer
              canSend={canSend}
              onClose={() => setOverlay(null)}
              onRequestReview={(prompt) => {
                sendUserText(prompt);
                setOverlay(null);
              }}
            />
          ) : overlay === 'companions' ? (
            <CompanionSelectorPage
              activeShardId={streamState.session?.activeShardId ?? null}
              activeCompanionId={fleet.activeCompanionId}
              approvals={approvals}
              companions={fleet.roster}
              connecting={connecting}
              shards={streamState.session?.shards ?? []}
              onApprovalDecision={(id, decision) => { void decideApproval(id, decision); }}
              onClose={() => setOverlay(null)}
              onSelect={(companionId) => {
                void fleet.select(companionId).then((selected) => {
                  if (selected) setOverlay(null);
                });
              }}
              onSelectShard={(shardId) => {
                try {
                  storeRef.current?.selectShard(shardId);
                  setOverlay(null);
                } catch (error) {
                  setConfigError(error instanceof Error ? error.message : 'Shard selection failed');
                }
              }}
            />
          ) : (
            <ActivityDrawer filter={activityFilter} onClose={() => setOverlay(null)} onFilterChange={setActivityFilter} traces={filteredTraces} totalCount={traces.length} />
          )}
        </OverlayFrame>
      )}
    </main>
  );
}

function websocketPath(access: AccessState): string | undefined {
  return access.state === 'signed_in' || access.state === 'guest'
    || (access.state === 'signed_out' && access.guestMode === 'explicit')
    ? access.websocketPath
    : undefined;
}

function presentAccess(access: AccessState): CompanionUiAccessPresentation {
  switch (access.state) {
    case 'loading':
      return { state: 'loading', humanLabel: 'Checking session', humanDetail: 'No authority yet', guestAvailable: false };
    case 'offline':
      return { state: 'offline', humanLabel: 'Unavailable offline', humanDetail: 'Offline shell is not authenticated', guestAvailable: false };
    case 'signed_out':
      return { state: 'signed_out', humanLabel: 'Signed out', humanDetail: 'No Partner attached', guestAvailable: access.guestMode === 'explicit' };
    case 'signed_in':
      return { state: 'signed_in', humanLabel: access.human.label, humanDetail: `Discord · ${access.human.role}`, guestAvailable: false };
    case 'guest':
      return { state: 'guest', humanLabel: 'Guest', humanDetail: 'No cluster Partner attached', guestAvailable: true };
  }
}

function getConnectionTone(connection: HubStreamState['connection'], connecting: boolean): 'good' | 'wait' | 'bad' {
  if (connecting || connection === 'connecting') return 'wait';
  if (connection === 'ready' || connection === 'connected') return 'good';
  if (connection === 'failed' || connection === 'disconnected') return 'bad';
  return 'wait';
}
