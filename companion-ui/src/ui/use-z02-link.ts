import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WebCodecsOmiOpusDecoder,
  type OmiOpusDecoderCallbacks,
} from '../lib/z02/omi-opus-decoder.js';
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
  decodedFrames?: number;
  relayedFrames?: number;
  audioError?: string;
  deviceName?: string;
  microphone?: 'pcm16-16khz' | 'opus-16khz';
  transport?: Z02LinkTransport;
}>;

type OmiDecoder = Pick<WebCodecsOmiOpusDecoder, 'close' | 'decode'>;

export interface Z02AudioRelay {
  start(): Promise<void>;
  write(pcm: Uint8Array): void;
  stop(): Promise<void> | void;
}

export interface Z02LinkOptions {
  createOmiDecoder?: (callbacks: OmiOpusDecoderCallbacks) => OmiDecoder;
  audioRelay?: Z02AudioRelay;
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
  const omiDecoderRef = useRef<OmiDecoder | null>(null);
  const attemptRef = useRef(0);
  const audioFramesRef = useRef(0);
  const decodedFramesRef = useRef(0);
  const relayedFramesRef = useRef(0);
  const audioErrorRef = useRef<string | null>(null);
  const audioRelayRef = useRef(options.audioRelay);
  const activeAudioRelayRef = useRef<Z02AudioRelay | null>(null);
  const createOmiDecoderRef = useRef(options.createOmiDecoder ?? createBrowserOmiDecoder);
  createOmiDecoderRef.current = options.createOmiDecoder ?? createBrowserOmiDecoder;
  audioRelayRef.current = options.audioRelay;

  const stopAudioRelay = useCallback(() => {
    const relay = activeAudioRelayRef.current;
    activeAudioRelayRef.current = null;
    if (!relay) return;
    try {
      void Promise.resolve(relay.stop()).catch(() => undefined);
    } catch {
      // The Bluetooth teardown must still complete when the backend is gone.
    }
  }, []);

  const link = useCallback(async () => {
    if (!connector || connectionRef.current || isZ02LinkBusy(state.phase)) return;
    const attempt = ++attemptRef.current;
    let disconnectedBeforeReady = false;
    closeOmiDecoder(omiDecoderRef.current);
    omiDecoderRef.current = null;
    audioFramesRef.current = 0;
    decodedFramesRef.current = 0;
    relayedFramesRef.current = 0;
    audioErrorRef.current = null;
    setState(progressState('selecting'));

    try {
      const publishAudioState = () => {
        setState(current => current.phase === 'linked'
          ? linkedState(
            connectionRef.current,
            audioFramesRef.current,
            decodedFramesRef.current,
            relayedFramesRef.current,
            audioErrorRef.current,
          )
          : current);
      };
      const reportAudioError = (message: string) => {
        if (attemptRef.current !== attempt) return;
        audioErrorRef.current = message;
        publishAudioState();
      };
      const relayPcm = (pcm: Uint8Array) => {
        const relay = activeAudioRelayRef.current;
        if (!relay) return;
        try {
          relay.write(pcm);
          relayedFramesRef.current += 1;
        } catch {
          reportAudioError('The Companion audio relay could not accept badge audio.');
        }
      };
      const connection = await connector.connect({
        ...(audioRelayRef.current ? {
          prepareAudio: async () => {
            const relay = audioRelayRef.current;
            if (!relay) throw new Error('Companion audio relay is unavailable');
            await relay.start();
            activeAudioRelayRef.current = relay;
          },
        } : {}),
        audioPcm: (pcm) => {
          if (attemptRef.current !== attempt) return;
          audioFramesRef.current += 1;
          decodedFramesRef.current += 1;
          relayPcm(pcm);
          publishAudioState();
        },
        audioFrame: frame => {
          if (attemptRef.current !== attempt) return;
          audioFramesRef.current += 1;
          try {
            omiDecoderRef.current ??= createOmiDecoderRef.current({
              pcm: ({ pcm }) => {
                if (attemptRef.current !== attempt) return;
                decodedFramesRef.current += 1;
                relayPcm(pcm);
                publishAudioState();
              },
              error: () => reportAudioError('The browser failed to decode Omi audio.'),
            });
            omiDecoderRef.current.decode(frame.opus);
          } catch {
            reportAudioError('This browser cannot decode the Omi audio stream.');
          }
          publishAudioState();
        },
        error: () => reportAudioError('The badge audio stream reported an error.'),
        progress: phase => {
          if (attemptRef.current === attempt) setState(progressState(phase));
        },
        disconnected: () => {
          disconnectedBeforeReady = true;
          if (attemptRef.current !== attempt) return;
          connectionRef.current = null;
          stopAudioRelay();
          closeOmiDecoder(omiDecoderRef.current);
          omiDecoderRef.current = null;
          setState({ phase: 'idle', detail: 'Badge disconnected.' });
        },
      });

      if (attemptRef.current !== attempt || disconnectedBeforeReady) {
        connection.disconnect();
        return;
      }
      connectionRef.current = connection;
      setState(linkedState(
        connection,
        audioFramesRef.current,
        decodedFramesRef.current,
        relayedFramesRef.current,
        audioErrorRef.current,
      ));
    } catch (error) {
      if (attemptRef.current !== attempt) return;
      connectionRef.current = null;
      stopAudioRelay();
      closeOmiDecoder(omiDecoderRef.current);
      omiDecoderRef.current = null;
      if (disconnectedBeforeReady) {
        setState({ phase: 'idle', detail: 'Badge disconnected.' });
        return;
      }
      setState({ phase: 'error', detail: describeLinkError(error) });
    }
  }, [connector, state.phase, stopAudioRelay]);

  const disconnect = useCallback(() => {
    attemptRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    closeOmiDecoder(omiDecoderRef.current);
    omiDecoderRef.current = null;
    audioFramesRef.current = 0;
    decodedFramesRef.current = 0;
    relayedFramesRef.current = 0;
    audioErrorRef.current = null;
    stopAudioRelay();
    connection?.disconnect();
    setState(connector ? IDLE_STATE : UNSUPPORTED_STATE);
  }, [connector, stopAudioRelay]);

  useEffect(() => () => {
    attemptRef.current += 1;
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    stopAudioRelay();
    closeOmiDecoder(omiDecoderRef.current);
    omiDecoderRef.current = null;
  }, [stopAudioRelay]);

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
  decodedFrames: number,
  relayedFrames: number,
  audioError: string | null,
): Z02LinkState {
  if (!connection) return { phase: 'idle', detail: 'Badge disconnected.' };
  if (connection.transport === 'omi-audio') {
    return {
      phase: 'linked',
      audioFrames,
      decodedFrames,
      relayedFrames,
      ...(audioError ? { audioError } : {}),
      deviceName: connection.deviceName,
      microphone: connection.microphone,
      transport: connection.transport,
      detail: audioError
        ?? (decodedFrames > 0
          ? `Omi audio active — ${audioFrames} Opus frame${audioFrames === 1 ? '' : 's'} received; ${decodedFrames} decoded to PCM${relayedFrames > 0 ? `; ${relayedFrames} relayed to Companion` : ''}.`
          : audioFrames > 0
            ? `Received ${audioFrames} Opus frame${audioFrames === 1 ? '' : 's'}; waiting for decoded PCM.`
            : 'Omi microphone subscribed. Waiting for the badge to deliver its first audio frame.'),
    };
  }
  return {
    phase: 'linked',
    audioFrames,
    decodedFrames,
    relayedFrames,
    ...(audioError ? { audioError } : {}),
    deviceName: connection.deviceName,
    microphone: connection.microphone,
    transport: connection.transport,
    detail: audioError
      ?? (audioFrames === 0
        ? 'Stock microphone started. Waiting for the first PCM chunk.'
        : relayedFrames > 0
          ? `Relayed ${relayedFrames} PCM chunk${relayedFrames === 1 ? '' : 's'} from the stock badge to Companion.`
          : `Phone received ${audioFrames} PCM chunk${audioFrames === 1 ? '' : 's'} from the stock badge.`),
  };
}

function createBrowserOmiDecoder(
  callbacks: OmiOpusDecoderCallbacks,
): WebCodecsOmiOpusDecoder {
  return new WebCodecsOmiOpusDecoder(callbacks);
}

function closeOmiDecoder(decoder: OmiDecoder | null): void {
  decoder?.close();
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
