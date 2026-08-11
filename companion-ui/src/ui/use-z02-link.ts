import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readBrowserZ02Connector,
  type Z02LinkConnection,
  type Z02LinkConnector,
  type Z02LinkProgress,
  type Z02LinkTransport,
} from '../lib/z02/web-bluetooth.js';

export type Z02LinkPhase =
  | 'unsupported'
  | 'idle'
  | Z02LinkProgress
  | 'linked'
  | 'error';

export type Z02LinkState = Readonly<{
  phase: Z02LinkPhase;
  detail: string;
  audioFrames?: number;
  relayedFrames?: number;
  deviceName?: string;
  microphone?: 'pcm16-16khz' | 'opus-16khz';
  transport?: Z02LinkTransport;
}>;

export interface Z02LinkOptions {
  /** Return true only when the PCM chunk was accepted by the active Companion transport. */
  relayMicrophonePcm?: (pcm: Uint8Array) => boolean;
}

const IDLE_STATE: Z02LinkState = {
  phase: 'idle',
  detail: 'Ready to discover a stock Z02 nearby.',
};

const UNSUPPORTED_STATE: Z02LinkState = {
  phase: 'unsupported',
  detail: 'Bluetooth linking needs Chrome on Android or another Web Bluetooth browser.',
};

export function useZ02Link(
  connectorOverride?: Z02LinkConnector | null,
  options: Z02LinkOptions = {},
) {
  const [connector] = useState<Z02LinkConnector | null>(() => (
    connectorOverride === undefined ? readBrowserZ02Connector() : connectorOverride
  ));
  const [state, setState] = useState<Z02LinkState>(() => connector ? IDLE_STATE : UNSUPPORTED_STATE);
  const connectionRef = useRef<Z02LinkConnection | null>(null);
  const attemptRef = useRef(0);
  const audioFramesRef = useRef(0);
  const relayedFramesRef = useRef(0);
  const relayMicrophonePcmRef = useRef(options.relayMicrophonePcm);
  relayMicrophonePcmRef.current = options.relayMicrophonePcm;

  const link = useCallback(async () => {
    if (!connector || connectionRef.current || isZ02LinkBusy(state.phase)) return;
    const attempt = ++attemptRef.current;
    let disconnectedBeforeReady = false;
    audioFramesRef.current = 0;
    relayedFramesRef.current = 0;
    setState(progressState('selecting'));

    try {
      const connection = await connector.connect({
        audioPcm: pcm => {
          if (attemptRef.current !== attempt) return;
          audioFramesRef.current += 1;
          try {
            if (relayMicrophonePcmRef.current?.(pcm)) relayedFramesRef.current += 1;
          } catch {
            // A transient upstream failure must not tear down the BLE link.
          }
          setState(current => current.phase === 'linked'
            ? linkedState(
              connectionRef.current,
              audioFramesRef.current,
              relayedFramesRef.current,
            )
            : current);
        },
        audioFrame: () => {
          if (attemptRef.current !== attempt) return;
          audioFramesRef.current += 1;
          setState(current => current.phase === 'linked'
            ? linkedState(
              connectionRef.current,
              audioFramesRef.current,
              relayedFramesRef.current,
            )
            : current);
        },
        progress: phase => {
          if (attemptRef.current === attempt) setState(progressState(phase));
        },
        disconnected: () => {
          disconnectedBeforeReady = true;
          if (attemptRef.current !== attempt) return;
          connectionRef.current = null;
          setState({ phase: 'idle', detail: 'Badge disconnected.' });
        },
      });

      if (attemptRef.current !== attempt || disconnectedBeforeReady) {
        connection.disconnect();
        return;
      }
      connectionRef.current = connection;
      setState(linkedState(connection, audioFramesRef.current, relayedFramesRef.current));
    } catch (error) {
      if (attemptRef.current !== attempt) return;
      connectionRef.current = null;
      if (disconnectedBeforeReady) {
        setState({ phase: 'idle', detail: 'Badge disconnected.' });
        return;
      }
      setState({ phase: 'error', detail: describeLinkError(error) });
    }
  }, [connector, state.phase]);

  const disconnect = useCallback(() => {
    attemptRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    audioFramesRef.current = 0;
    relayedFramesRef.current = 0;
    connection?.disconnect();
    setState(connector ? IDLE_STATE : UNSUPPORTED_STATE);
  }, [connector]);

  useEffect(() => () => {
    attemptRef.current += 1;
    connectionRef.current?.disconnect();
    connectionRef.current = null;
  }, []);

  return { state, link, disconnect } as const;
}

function progressState(phase: Z02LinkProgress): Z02LinkState {
  switch (phase) {
    case 'selecting':
      return { phase, detail: 'Choose the Z02 in the Bluetooth picker.' };
    case 'connecting':
      return { phase, detail: 'Opening the stock AE00 RCSP service…' };
    case 'authenticating':
      return { phase, detail: 'Verifying the badge with the stock mutual-auth handshake…' };
    case 'subscribing':
      return { phase, detail: 'Starting the badge microphone stream…' };
  }
}

export function isZ02LinkBusy(phase: Z02LinkPhase): boolean {
  return phase === 'selecting' || phase === 'connecting'
    || phase === 'authenticating' || phase === 'subscribing';
}

function linkedState(
  connection: Z02LinkConnection | null,
  audioFrames: number,
  relayedFrames: number,
): Z02LinkState {
  if (!connection) return { phase: 'idle', detail: 'Badge disconnected.' };
  if (connection.transport === 'omi-audio') {
    return {
      phase: 'linked',
      audioFrames,
      relayedFrames,
      deviceName: connection.deviceName,
      microphone: connection.microphone,
      transport: connection.transport,
      detail: audioFrames > 0
        ? `Audio stream active — ${audioFrames} Opus frame${audioFrames === 1 ? '' : 's'} received.`
        : 'Omi microphone subscribed. Waiting for the badge to deliver its first audio frame.',
    };
  }
  return {
    phase: 'linked',
    audioFrames,
    relayedFrames,
    deviceName: connection.deviceName,
    microphone: connection.microphone,
    transport: connection.transport,
    detail: audioFrames === 0
      ? 'Stock microphone started. Waiting for the first PCM chunk.'
      : relayedFrames > 0
        ? `PCM relay active — ${audioFrames} chunk${audioFrames === 1 ? '' : 's'} received; ${relayedFrames} sent to Companion.`
        : `Badge microphone active — ${audioFrames} PCM chunk${audioFrames === 1 ? '' : 's'} received. Waiting for Companion audio relay.`,
  };
}

function describeLinkError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No badge was selected. Tap Link Z02 to try again.';
  }
  if (error instanceof DOMException && error.name === 'SecurityError') {
    return 'Bluetooth permission was blocked. Open the app over HTTPS and allow nearby devices.';
  }
  if (error instanceof Error && error.message === 'Z02 authentication failed') {
    return 'The badge rejected stock authentication.';
  }
  if (error instanceof Error && error.message.includes('timed out')) {
    return 'The badge stopped responding before the link completed. Tap Link Z02 to retry.';
  }
  return 'Could not link the Z02. Make sure it is on, nearby, and not connected to BagiBagi.';
}
