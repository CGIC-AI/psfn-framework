import { describe, expect, it, vi } from 'vitest';
import { computeStockAuthProof } from './rcsp-auth.js';
import {
  Z02_NOTIFY_CHARACTERISTIC_UUID,
  Z02_RCSP_SERVICE_UUID,
  Z02_WRITE_CHARACTERISTIC_UUID,
  WebBluetoothZ02Connector,
  type Z02Bluetooth,
  type Z02BluetoothCharacteristic,
} from './web-bluetooth.js';

describe('Web Bluetooth Z02 connector', () => {
  it('selects the stock service, discovers AE01/AE02, and authenticates before linking', async () => {
    const fixture = createBluetoothFixture();
    const progress = vi.fn();
    const disconnected = vi.fn();
    const connector = new WebBluetoothZ02Connector(fixture.bluetooth);

    const connection = await connector.connect({ progress, disconnected });

    expect(fixture.requestDevice).toHaveBeenCalledWith({
      filters: [
        { services: [Z02_RCSP_SERVICE_UUID] },
        { namePrefix: 'ZNP Z02' },
      ],
      optionalServices: [Z02_RCSP_SERVICE_UUID],
    });
    expect(fixture.getPrimaryService).toHaveBeenCalledWith(Z02_RCSP_SERVICE_UUID);
    expect(fixture.getCharacteristic.mock.calls.map(call => call[0])).toEqual([
      Z02_WRITE_CHARACTERISTIC_UUID,
      Z02_NOTIFY_CHARACTERISTIC_UUID,
    ]);
    expect(progress.mock.calls.map(call => call[0])).toEqual([
      'selecting',
      'connecting',
      'authenticating',
    ]);
    expect(connection.deviceName).toBe('Z02 Test Badge');
    expect(fixture.writes).toHaveLength(4);

    fixture.device.dispatch('gattserverdisconnected');
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('disconnects and fails closed when stock authentication is rejected', async () => {
    const fixture = createBluetoothFixture({ rejectProof: true });
    const connector = new WebBluetoothZ02Connector(fixture.bluetooth);

    await expect(connector.connect({ disconnected: vi.fn() }))
      .rejects.toThrow('Z02 authentication failed');
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });
});

function createBluetoothFixture(options: { rejectProof?: boolean } = {}) {
  const writes: Uint8Array[] = [];
  const listeners = new Set<(event: Event) => void>();
  let notifyCharacteristic: Z02BluetoothCharacteristic;
  const badgeChallenge = fromHex('24c11127fce7368b4ca77aa7e378c48e');

  const writeCharacteristic: Z02BluetoothCharacteristic = {
    async writeValueWithoutResponse(value) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      writes.push(bytes);
      if (bytes[0] === 0x00 && bytes.length === 17) {
        notify(options.rejectProof
          ? concat(0x01, new Uint8Array(16))
          : concat(0x01, computeStockAuthProof(bytes.slice(1))));
      } else if (toHex(bytes) === '0270617373') {
        notify(concat(0x00, badgeChallenge));
      } else if (bytes[0] === 0x01 && bytes.length === 17) {
        notify(fromHex('0270617373'));
      }
    },
    async startNotifications() { return notifyCharacteristic; },
    async stopNotifications() { return notifyCharacteristic; },
    addEventListener() {},
    removeEventListener() {},
  };

  notifyCharacteristic = {
    value: null,
    async startNotifications() { return notifyCharacteristic; },
    async stopNotifications() { return notifyCharacteristic; },
    async writeValueWithoutResponse() {},
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };

  function notify(bytes: Uint8Array) {
    notifyCharacteristic.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const event = { target: notifyCharacteristic } as unknown as Event;
    for (const listener of listeners) listener(event);
  }

  const getCharacteristic = vi.fn(async (uuid: string) => (
    uuid === Z02_WRITE_CHARACTERISTIC_UUID ? writeCharacteristic : notifyCharacteristic
  ));
  const getPrimaryService = vi.fn(async () => ({ getCharacteristic }));
  const disconnect = vi.fn();
  const deviceListeners = new Map<string, Set<() => void>>();
  const device = {
    name: 'Z02 Test Badge',
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return { getPrimaryService };
      },
      disconnect,
    },
    addEventListener(type: string, listener: () => void) {
      const bucket = deviceListeners.get(type) ?? new Set();
      bucket.add(listener);
      deviceListeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: () => void) {
      deviceListeners.get(type)?.delete(listener);
    },
    dispatch(type: string) {
      for (const listener of deviceListeners.get(type) ?? []) listener();
    },
  };
  const requestDevice = vi.fn(async () => device);
  const bluetooth: Z02Bluetooth = { requestDevice };

  return {
    bluetooth,
    device,
    disconnect,
    getCharacteristic,
    getPrimaryService,
    requestDevice,
    writes,
  };
}

function concat(prefix: number, value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.length + 1);
  result[0] = prefix;
  result.set(value, 1);
  return result;
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}
