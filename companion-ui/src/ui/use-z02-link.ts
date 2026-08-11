import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readBrowserZ02Connector,
  type Z02LinkConnection,
  type Z02LinkConnector,
  type Z02LinkProgress,
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
  deviceName?: string;
}>;

const IDLE_STATE: Z02LinkState = {
  phase: 'idle',
  detail: 'Ready to discover a stock Z02 nearby.',
};

const UNSUPPORTED_STATE: Z02LinkState = {
  phase: 'unsupported',
  detail: 'Bluetooth linking needs Chrome on Android or another Web Bluetooth browser.',
};

export function useZ02Link(connectorOverride?: Z02LinkConnector | null) {
  const [connector] = useState<Z02LinkConnector | null>(() => (
    connectorOverride === undefined ? readBrowserZ02Connector() : connectorOverride
  ));
  const [state, setState] = useState<Z02LinkState>(() => connector ? IDLE_STATE : UNSUPPORTED_STATE);
  const connectionRef = useRef<Z02LinkConnection | null>(null);
  const attemptRef = useRef(0);

  const link = useCallback(async () => {
    if (!connector || connectionRef.current || isZ02LinkBusy(state.phase)) return;
    const attempt = ++attemptRef.current;
    let disconnectedBeforeReady = false;
    setState(progressState('selecting'));

    try {
      const connection = await connector.connect({
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
      setState({
        phase: 'linked',
        deviceName: connection.deviceName,
        detail: 'Mutual stock authentication passed. The badge is linked locally.',
      });
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
  }
}

export function isZ02LinkBusy(phase: Z02LinkPhase): boolean {
  return phase === 'selecting' || phase === 'connecting' || phase === 'authenticating';
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
