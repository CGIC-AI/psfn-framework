import type { FleetSessionStatus } from '../lib/fleet-session.js';
import type { HubStreamState } from '../lib/stream/hub-stream.js';
import type { CompanionUiAccessPresentation } from './settings-drawer.js';

export type AccessState = FleetSessionStatus
  | Readonly<{ state: 'loading' | 'offline' }>
  | Readonly<{ state: 'guest'; guestMode: 'explicit'; websocketPath: string }>;

export function websocketPath(access: AccessState): string | undefined {
  return access.state === 'signed_in' || access.state === 'guest'
    || (access.state === 'signed_out' && access.guestMode === 'explicit')
    ? access.websocketPath
    : undefined;
}

export function presentAccess(access: AccessState): CompanionUiAccessPresentation {
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

export function getConnectionTone(connection: HubStreamState['connection'], connecting: boolean): 'good' | 'wait' | 'bad' {
  if (connecting || connection === 'connecting') return 'wait';
  if (connection === 'ready' || connection === 'connected') return 'good';
  if (connection === 'failed' || connection === 'disconnected') return 'bad';
  return 'wait';
}
