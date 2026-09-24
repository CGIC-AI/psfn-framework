// ── Compose Satellite Hub / companion-ui verification (psfn-framework-2ahwj) ──
// Drives the hub and companion-ui services added to docker/docker-compose.smoke.yml
// and reports exactly what the running stack proves:
//
//   * both surfaces answer over HTTP;
//   * the gateway ADMITS the hub's satellite claim on the companion relay, and
//     REJECTS a claim that is not in satellites.json (the positive alone would
//     also pass against a vacuous registry);
//   * the hub enforces its device registry: a hello without the enrolled
//     device credential is refused (psfn-framework-gdv64);
//   * a session that authenticates as the enrolled smoke device with
//     companion-ui's own hello capabilities completes the handshake with
//     session.ready, is granted the `emotion` output, and answers a
//     companion-ui-serialized ping with pong;
//   * companion-ui's own protocol decoder accepts the hub's pong, and whether it
//     accepts the hub's session.ready;
//   * (openEmotionRelaySession + judgeRelayedEmotionSnapshot, driven by
//     smoke-docker around the chat turn) a real relay PAYLOAD: the turn's
//     post_turn emotion.snapshot travels agent -> gateway relay -> hub -> a hub
//     websocket session and decodes with companion-ui's own codec.
//
// The last check is a real contract boundary, not a plumbing failure, so it has
// its own outcome: companion-ui's strict session.ready validator and the hub's
// session.ready frame have diverged.

import { parseHubToClientMessage, serializeClientToHubMessage } from '../companion-ui/src/lib/protocol/framing.js';
import { buildSatelliteHello } from '../companion-ui/src/lib/api/auth.js';
import { isRecord } from '../src/shared/utils/types.js';

/** Keys companion-ui's strict session.ready validator accepts. */
const COMPANION_UI_SESSION_READY_KEYS: readonly string[] = [
  'type', 'sessionId', 'channelId', 'deviceId', 'deviceName', 'satelliteId', 'audioFormat',
  'identity', 'place',
];

export interface HubVerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The enrolled smoke device (docker/docker-compose.smoke.yml hub-device
 * volume, scripts/ops/psfn-compose-smoke-hub-device.mjs). The credential is
 * generated per run by smoke:docker; only its digest is enrolled.
 */
export interface HubDeviceCredential {
  deviceId: string;
  credential: string;
}

export interface HubVerificationOptions {
  hubBase: string;
  hubDevice: HubDeviceCredential;
  hubWsUrl: string;
  companionUiBase: string;
  gatewayApiBase: string;
  satelliteApiKey: string;
  satelliteId: string;
  endpointId: string;
  claimType: string;
  timeoutMs: number;
}

/**
 * Keys the hub sends on session.ready that companion-ui's decoder does not
 * accept. Empty means the two protocol declarations agree.
 */
export function companionUiSessionReadyDivergence(frame: unknown): string[] {
  if (!isRecord(frame)) return ['<not an object>'];
  return Object.keys(frame).filter(key => !COMPANION_UI_SESSION_READY_KEYS.includes(key)).sort();
}

/** Structural assertion against the hub's own session.ready declaration. */
export function assertHubSessionReady(frame: unknown): asserts frame is Record<string, unknown> {
  if (!isRecord(frame) || frame.type !== 'session.ready') {
    throw new Error(`first hub frame was not session.ready: ${JSON.stringify(frame)?.slice(0, 200)}`);
  }
  for (const key of ['sessionId', 'channelId', 'deviceId', 'deviceName', 'satelliteId', 'audioFormat']) {
    if (typeof frame[key] !== 'string' || frame[key].length === 0) {
      throw new Error(`hub session.ready is missing ${key}`);
    }
  }
  if (!isRecord(frame.capabilities)) {
    throw new Error('hub session.ready is missing capabilities');
  }
}

export function relayEventsUrl(options: {
  gatewayApiBase: string;
  satelliteId: string;
  endpointId: string;
  claimType: string;
}): string {
  const query = new URLSearchParams({
    satelliteId: options.satelliteId,
    endpointId: options.endpointId,
    claimType: options.claimType,
  });
  return `${options.gatewayApiBase}/companion/events?${query.toString()}`;
}

async function readFirstChunk(response: Response, timeoutMs: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), timeoutMs);
  try {
    const { value } = await reader.read();
    return value ? new TextDecoder().decode(value) : '';
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}

/** A live hub websocket session that records every frame it receives. */
export interface HubSession {
  sessionReady: unknown;
  send(frame: string): void;
  waitForFrame(type: string, timeoutMs: number): Promise<unknown>;
  close(): void;
}

/**
 * companion-ui's own hello (buildSatelliteHello, validated by companion-ui's
 * strict codec) plus the device authentication a registry Hub requires. The
 * browser codec deliberately cannot carry device authority, so the credential
 * envelope is added after companion-ui has serialized its hello.
 */
export function buildEnrolledDeviceHello(device: HubDeviceCredential): string {
  const hello = JSON.parse(serializeClientToHubMessage(buildSatelliteHello())) as Record<string, unknown>;
  return JSON.stringify({ ...hello, deviceId: device.deviceId, credential: device.credential });
}

/**
 * Open a hub websocket, authenticate as the enrolled device with companion-ui's
 * hello capabilities, and wait for the post-authentication session.ready and
 * hello.ack. Every frame is buffered, so a frame that arrives before the caller
 * starts waiting for it is not lost.
 */
export async function openHubSession(
  wsUrl: string,
  timeoutMs: number,
  device: HubDeviceCredential,
): Promise<HubSession & { helloAck: unknown }> {
  const socket = new WebSocket(wsUrl);
  const frames: unknown[] = [];
  const waiters = new Set<(frame: unknown) => void>();
  socket.addEventListener('message', (event: MessageEvent) => {
    const frame: unknown = JSON.parse(String(event.data));
    frames.push(frame);
    for (const waiter of [...waiters]) waiter(frame);
  });
  const isType = (type: string) => (frame: unknown): boolean => isRecord(frame) && frame.type === type;
  const waitForFrame = (type: string, waitMs: number): Promise<unknown> =>
    new Promise((resolvePromise, rejectPromise) => {
      const existing = frames.find(isType(type));
      if (existing) {
        resolvePromise(existing);
        return;
      }
      const waiter = (frame: unknown): void => {
        if (!isType(type)(frame)) return;
        clearTimeout(timer);
        waiters.delete(waiter);
        resolvePromise(frame);
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        const seen = frames.map(frame => (isRecord(frame) ? String(frame.type) : typeof frame)).join(', ');
        rejectPromise(new Error(`timed out waiting for ${type} from ${wsUrl} (received: ${seen || 'nothing'})`));
      }, waitMs);
      waiters.add(waiter);
    });

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`hub websocket ${wsUrl} did not open`)), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectPromise(new Error(`hub websocket ${wsUrl} failed to connect`));
      }, { once: true });
    });
    socket.send(buildEnrolledDeviceHello(device));
    const sessionReady = await waitForFrame('session.ready', timeoutMs);
    const helloAck = await waitForFrame('hello.ack', timeoutMs);
    return {
      sessionReady,
      helloAck,
      send: frame => socket.send(frame),
      waitForFrame,
      close: () => socket.close(),
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

/**
 * Open the hub websocket, collect the unsolicited handshake frame, then elicit
 * the deterministic hub reply that needs no provider and no audio device.
 */
export async function collectHubHandshake(
  wsUrl: string,
  timeoutMs: number,
  device: HubDeviceCredential,
): Promise<{ sessionReady: unknown; helloAck: unknown; pong: unknown }> {
  const session = await openHubSession(wsUrl, timeoutMs, device);
  try {
    // Serialized by companion-ui's own encoder, so the outbound half of the
    // exchange is the real client codec rather than a hand-rolled frame.
    session.send(serializeClientToHubMessage({ type: 'ping', sentAt: Date.now() }));
    const pong = await session.waitForFrame('pong', timeoutMs);
    return { sessionReady: session.sessionReady, helloAck: session.helloAck, pong };
  } finally {
    session.close();
  }
}

/**
 * The relay-proof session: authenticated as the enrolled device with
 * companion-ui's own hello, which advertises the `emotion` output. The hub
 * forwards a companion relay event only for outputs the session advertised AND
 * its device enrollment grants; a registry-less hub would clamp `emotion` away.
 */
export async function openEmotionRelaySession(
  wsUrl: string,
  timeoutMs: number,
  device: HubDeviceCredential,
): Promise<HubSession> {
  const session = await openHubSession(wsUrl, timeoutMs, device);
  if (!grantsOutput(session.helloAck, 'emotion')) {
    session.close();
    throw new Error(`hub hello.ack did not grant the emotion output: ${JSON.stringify(session.helloAck)?.slice(0, 200)}`);
  }
  return session;
}

/** Whether a hello.ack grants the given output capability. */
export function grantsOutput(helloAck: unknown, output: string): boolean {
  if (!isRecord(helloAck) || !isRecord(helloAck.capabilities)) return false;
  const outputs = helloAck.capabilities.output;
  return Array.isArray(outputs) && outputs.includes(output);
}

/**
 * Send companion-ui's hello WITHOUT the device credential and report how the
 * hub answered: a registry hub must refuse it (error-event, then close), which
 * is what makes the enrolled grant meaningful.
 */
export async function probeUnauthenticatedHello(
  wsUrl: string,
  timeoutMs: number,
): Promise<{ refused: boolean; detail: string }> {
  const socket = new WebSocket(wsUrl);
  const frames: unknown[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    frames.push(JSON.parse(String(event.data)));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolvePromise) => {
    socket.addEventListener('close', event => resolvePromise({ code: event.code, reason: event.reason }), { once: true });
  });
  const timeout = new Promise<null>(resolvePromise => setTimeout(() => resolvePromise(null), timeoutMs));
  socket.addEventListener('open', () => {
    socket.send(serializeClientToHubMessage(buildSatelliteHello()));
  }, { once: true });
  const outcome = await Promise.race([closed, timeout]);
  socket.close();
  const types = frames.map(frame => (isRecord(frame) ? String(frame.type) : typeof frame));
  if (!outcome) {
    return { refused: false, detail: `socket stayed open (received: ${types.join(', ') || 'nothing'})` };
  }
  const granted = types.includes('hello.ack') || types.includes('session.ready');
  return {
    refused: !granted && outcome.code === 1008,
    detail: `close ${outcome.code} ${outcome.reason} (received: ${types.join(', ') || 'nothing'})`,
  };
}

/**
 * Judge a frame the hub relayed from the gateway companion relay after a chat
 * turn: it must be a post_turn emotion.snapshot that companion-ui's own
 * decoder accepts. This is the payload half of the relay proof; the SSE
 * admission check only shows the subscription was accepted.
 */
export function judgeRelayedEmotionSnapshot(frame: unknown): HubVerificationCheck {
  const name = 'hub relays the turn\'s emotion.snapshot payload to a satellite session (companion-ui codec decodes it)';
  try {
    const decoded = parseHubToClientMessage(JSON.stringify(frame));
    if (decoded.type !== 'emotion.snapshot') {
      return { name, ok: false, detail: `decoded ${decoded.type}, expected emotion.snapshot` };
    }
    const data: unknown = decoded.data;
    const trigger = isRecord(data) ? data.trigger : undefined;
    return {
      name,
      ok: trigger === 'post_turn',
      detail: `decoded emotion.snapshot trigger=${String(trigger)}`
        + (isRecord(data) ? ` confidence=${String(data.confidence)}` : ''),
    };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function verifyComposeHub(
  options: HubVerificationOptions,
): Promise<{ checks: HubVerificationCheck[]; contractBoundary: string | null }> {
  const checks: HubVerificationCheck[] = [];
  let contractBoundary: string | null = null;
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const signal = (): AbortSignal => AbortSignal.timeout(options.timeoutMs);

  const hub = await fetch(`${options.hubBase}/`, { signal: signal() });
  const hubBody = (await hub.text()).trim();
  record('hub HTTP surface', hub.ok && hubBody === 'psfn-satellite-hub', `HTTP ${hub.status} ${hubBody.slice(0, 60)}`);

  const ui = await fetch(`${options.companionUiBase}/companion-ui/`, { signal: signal() });
  const uiBody = await ui.text();
  record(
    'companion-ui app shell',
    ui.ok && uiBody.toLowerCase().includes('<!doctype html'),
    `HTTP ${ui.status}, ${uiBody.length} bytes`,
  );

  const relayUrl = relayEventsUrl(options);
  const relay = await fetch(relayUrl, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${options.satelliteApiKey}` },
    signal: signal(),
  });
  const relayFirst = relay.ok ? await readFirstChunk(relay, options.timeoutMs) : (await relay.text()).slice(0, 200);
  record(
    'gateway admits the hub satellite claim on the companion relay',
    relay.ok && relay.headers.get('content-type')?.includes('text/event-stream') === true
      && relayFirst.includes(': connected'),
    `HTTP ${relay.status} ${relayFirst.trim().slice(0, 120)}`,
  );

  const unregistered = await fetch(
    relayEventsUrl({ ...options, endpointId: `${options.endpointId}-unregistered` }),
    {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${options.satelliteApiKey}` },
      signal: signal(),
    },
  );
  const unregisteredBody = (await unregistered.text()).slice(0, 200);
  record(
    'gateway rejects an unregistered satellite endpoint',
    unregistered.status === 403 && unregisteredBody.includes('companion_relay_not_registered'),
    `HTTP ${unregistered.status} ${unregisteredBody.replace(/\s+/gu, ' ').slice(0, 120)}`,
  );

  const unauthenticated = await probeUnauthenticatedHello(options.hubWsUrl, options.timeoutMs);
  record(
    'hub refuses a hello without the enrolled device credential (device registry enforced)',
    unauthenticated.refused,
    unauthenticated.detail,
  );

  const handshake = await collectHubHandshake(options.hubWsUrl, options.timeoutMs, options.hubDevice);
  let sessionReadyOk = true;
  try {
    assertHubSessionReady(handshake.sessionReady);
  } catch (error) {
    sessionReadyOk = false;
    record('hub session.ready handshake', false, error instanceof Error ? error.message : String(error));
  }
  if (sessionReadyOk) {
    const frame = handshake.sessionReady as Record<string, unknown>;
    record(
      'hub session.ready handshake',
      frame.audioFormat === 'text_only',
      `sessionId=${String(frame.sessionId)} audioFormat=${String(frame.audioFormat)}`,
    );
  }

  record(
    'hub grants the enrolled device companion-ui\'s emotion output (hello.ack)',
    grantsOutput(handshake.helloAck, 'emotion'),
    JSON.stringify(isRecord(handshake.helloAck) ? handshake.helloAck.capabilities : handshake.helloAck)?.slice(0, 200) ?? '',
  );

  record(
    'hub answers a client ping with pong',
    isRecord(handshake.pong) && typeof handshake.pong.sentAt === 'number',
    JSON.stringify(handshake.pong).slice(0, 120),
  );

  let pongDecoded = false;
  let pongDetail = '';
  try {
    const decoded = parseHubToClientMessage(JSON.stringify(handshake.pong));
    pongDecoded = decoded.type === 'pong';
    pongDetail = `decoded ${decoded.type}`;
  } catch (error) {
    pongDetail = error instanceof Error ? error.message : String(error);
  }
  record('companion-ui decoder accepts a live hub frame (pong)', pongDecoded, pongDetail);

  try {
    parseHubToClientMessage(JSON.stringify(handshake.sessionReady));
    record('companion-ui decoder accepts the hub session.ready', true, 'decoded session.ready');
  } catch (error) {
    const extras = companionUiSessionReadyDivergence(handshake.sessionReady);
    contractBoundary = `companion-ui's strict session.ready validator rejects the hub frame over unexpected key(s): ${extras.join(', ') || '<none>'}`;
    record(
      'companion-ui decoder accepts the hub session.ready',
      false,
      `${error instanceof Error ? error.message : String(error)}; unexpected key(s): ${extras.join(', ') || '<none>'}`,
    );
  }

  return { checks, contractBoundary };
}
