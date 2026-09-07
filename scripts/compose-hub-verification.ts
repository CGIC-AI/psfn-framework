// ── Compose Satellite Hub / companion-ui verification (psfn-framework-2ahwj) ──
// Drives the hub and companion-ui services added to docker/docker-compose.smoke.yml
// and reports exactly what the running stack proves:
//
//   * both surfaces answer over HTTP;
//   * the gateway ADMITS the hub's satellite claim on the companion relay, and
//     REJECTS a claim that is not in satellites.json (the positive alone would
//     also pass against a vacuous registry);
//   * the hub completes the websocket handshake with session.ready and answers
//     a companion-ui-serialized ping with pong;
//   * companion-ui's own protocol decoder accepts the hub's pong, and whether it
//     accepts the hub's session.ready.
//
// The last check is a real contract boundary, not a plumbing failure, so it has
// its own outcome: companion-ui's strict session.ready validator and the hub's
// session.ready frame have diverged.

import { parseHubToClientMessage, serializeClientToHubMessage } from '../companion-ui/src/lib/protocol/framing.js';
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

export interface HubVerificationOptions {
  hubBase: string;
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

/**
 * Open the hub websocket, collect the unsolicited handshake frame, then elicit
 * the two deterministic hub replies that need no provider and no audio device.
 */
export async function collectHubHandshake(
  wsUrl: string,
  timeoutMs: number,
): Promise<{ sessionReady: unknown; pong: unknown }> {
  const socket = new WebSocket(wsUrl);
  const frames: unknown[] = [];
  const waitFor = (predicate: (frame: unknown) => boolean, label: string): Promise<unknown> =>
    new Promise((resolvePromise, rejectPromise) => {
      const existing = frames.find(predicate);
      if (existing) {
        resolvePromise(existing);
        return;
      }
      const timer = setTimeout(() => {
        socket.removeEventListener('message', onMessage);
        rejectPromise(new Error(`timed out waiting for ${label} from ${wsUrl}`));
      }, timeoutMs);
      const onMessage = (event: MessageEvent): void => {
        const frame: unknown = JSON.parse(String(event.data));
        frames.push(frame);
        if (!predicate(frame)) return;
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolvePromise(frame);
      };
      socket.addEventListener('message', onMessage);
    });
  const isType = (type: string) => (frame: unknown): boolean => isRecord(frame) && frame.type === type;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`hub websocket ${wsUrl} did not open`)), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectPromise(new Error(`hub websocket ${wsUrl} failed to connect`));
      }, { once: true });
    });
    const sessionReady = await waitFor(isType('session.ready'), 'session.ready');
    // Serialized by companion-ui's own encoder, so the outbound half of the
    // exchange is the real client codec rather than a hand-rolled frame.
    socket.send(serializeClientToHubMessage({ type: 'ping', sentAt: Date.now() }));
    const pong = await waitFor(isType('pong'), 'pong');
    return { sessionReady, pong };
  } finally {
    socket.close();
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

  const handshake = await collectHubHandshake(options.hubWsUrl, options.timeoutMs);
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
