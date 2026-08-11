import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeStockAuthProof } from './rcsp-auth.js';
import {
  OMI_AUDIO_CHARACTERISTIC_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC_CHARACTERISTIC_UUID,
  Z02_NOTIFY_CHARACTERISTIC_UUID,
  Z02_RCSP_SERVICE_UUID,
  Z02_WRITE_CHARACTERISTIC_UUID,
  WebBluetoothZ02Connector,
  type Z02Bluetooth,
  type Z02BluetoothCharacteristic,
} from './web-bluetooth.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Web Bluetooth Z02 connector', () => {
  it('authenticates stock RCSP, starts PCM recording, and emits microphone chunks', async () => {
    const fixture = createBluetoothFixture();
    const progress = vi.fn();
    const disconnected = vi.fn();
    const audioPcm = vi.fn();
    const prepareAudio = vi.fn(async () => undefined);
    const connector = new WebBluetoothZ02Connector(fixture.bluetooth);

    const connection = await connector.connect({
      progress,
      disconnected,
      audioPcm,
      prepareAudio,
    });

    expect(fixture.requestDevice).toHaveBeenCalledWith({
      filters: [
        {
          namePrefix: 'ZNP Z02',
          services: [Z02_RCSP_SERVICE_UUID],
        },
        {
          namePrefix: 'Omi',
          services: [OMI_AUDIO_SERVICE_UUID],
        },
      ],
      optionalServices: [Z02_RCSP_SERVICE_UUID, OMI_AUDIO_SERVICE_UUID],
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
      'subscribing',
    ]);
    expect(connection.deviceName).toBe('Z02 Test Badge');
    expect(connection.transport).toBe('stock-rcsp');
    expect(connection.microphone).toBe('pcm16-16khz');
    expect(prepareAudio).toHaveBeenCalledOnce();
    expect(fixture.writes).toHaveLength(5);
    expect(fixture.writes[4]?.[4]).toBe(0x04);
    expect(fixture.writes[4]?.[8]).toBe(0x00);

    fixture.notify(fromHex('fedcba8001000633040001'));
    fixture.notify(fromHex('0203ef'));
    expect(audioPcm).toHaveBeenCalledWith(Uint8Array.of(0x00, 0x01, 0x02, 0x03));

    fixture.device.dispatch('gattserverdisconnected');
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('fails closed when the stock badge rejects microphone start', async () => {
    const fixture = createBluetoothFixture({ rejectMicrophone: true });
    const connector = new WebBluetoothZ02Connector(fixture.bluetooth);

    await expect(connector.connect({ disconnected: vi.fn() }))
      .rejects.toThrow('Z02 microphone start failed');
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it('sends the stock recording-stop command before a local GATT disconnect', async () => {
    const fixture = createBluetoothFixture();
    const connection = await new WebBluetoothZ02Connector(fixture.bluetooth).connect({
      disconnected: vi.fn(),
    });

    connection.disconnect();

    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(fixture.writes).toHaveLength(6);
    expect(fixture.writes[5]?.[4]).toBe(0x05);
  });

  it('disconnects and fails closed when stock authentication is rejected', async () => {
    const fixture = createBluetoothFixture({ rejectProof: true });
    const connector = new WebBluetoothZ02Connector(fixture.bluetooth);

    await expect(connector.connect({ disconnected: vi.fn() }))
      .rejects.toThrow('Z02 authentication failed');
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it('tears down a GATT connection that resolves after the visible timeout', async () => {
    vi.useFakeTimers();
    let resolveConnect!: (server: { getPrimaryService(): Promise<never> }) => void;
    const disconnect = vi.fn();
    const gatt = {
      connected: false,
      connect: vi.fn(() => new Promise<{ getPrimaryService(): Promise<never> }>(resolve => {
        resolveConnect = resolve;
      })),
      disconnect,
    };
    const bluetooth = {
      async requestDevice() {
        return {
          name: 'Z02 Test Badge',
          gatt,
          addEventListener() {},
          removeEventListener() {},
        };
      },
    } as Z02Bluetooth;
    const linking = new WebBluetoothZ02Connector(bluetooth).connect({ disconnected: vi.fn() });
    const timedOut = expect(linking).rejects.toThrow('Z02 connection timed out');
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;

    gatt.connected = true;
    resolveConnect({ getPrimaryService: async () => new Promise<never>(() => undefined) });
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('subscribes to Stark Ruby Omi audio and emits complete Opus frames', async () => {
    const fixture = createOmiBluetoothFixture();
    const audioFrame = vi.fn();
    const progress = vi.fn();
    const connector = new WebBluetoothZ02Connector(fixture.bluetooth);

    const connection = await connector.connect({
      audioFrame,
      disconnected: vi.fn(),
      progress,
    });

    expect(fixture.requestDevice).toHaveBeenCalledWith({
      filters: [
        { namePrefix: 'ZNP Z02', services: [Z02_RCSP_SERVICE_UUID] },
        { namePrefix: 'Omi', services: [OMI_AUDIO_SERVICE_UUID] },
      ],
      optionalServices: [Z02_RCSP_SERVICE_UUID, OMI_AUDIO_SERVICE_UUID],
    });
    expect(fixture.getPrimaryService).toHaveBeenCalledWith(OMI_AUDIO_SERVICE_UUID);
    expect(fixture.getCharacteristic.mock.calls.map(call => call[0])).toEqual([
      OMI_AUDIO_CHARACTERISTIC_UUID,
      OMI_CODEC_CHARACTERISTIC_UUID,
    ]);
    expect(progress.mock.calls.map(call => call[0])).toEqual([
      'selecting',
      'connecting',
      'subscribing',
    ]);
    expect(connection).toMatchObject({
      deviceName: 'Omi',
      transport: 'omi-audio',
      microphone: 'opus-16khz',
    });

    fixture.notify(Uint8Array.of(4, 0, 0, 0xa1));
    fixture.notify(Uint8Array.of(5, 0, 0, 0xb1, 0xb2));
    expect(audioFrame).toHaveBeenCalledWith({
      firstSequence: 4,
      lastSequence: 4,
      opus: Uint8Array.of(0xa1),
    });
  });

  it('rejects an Omi-named badge that reports an unsupported codec', async () => {
    const fixture = createOmiBluetoothFixture({ codec: 0x01 });
    const connector = new WebBluetoothZ02Connector(fixture.bluetooth);

    await expect(connector.connect({ disconnected: vi.fn() }))
      .rejects.toThrow('Unsupported Omi audio codec 1');
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it('reports a malformed Omi audio notification instead of silently resetting', async () => {
    const fixture = createOmiBluetoothFixture();
    const error = vi.fn();
    await new WebBluetoothZ02Connector(fixture.bluetooth).connect({
      disconnected: vi.fn(),
      error,
    });

    fixture.notify(Uint8Array.of(0x01, 0x02));

    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Omi audio packet has no Opus payload',
    }));
  });
});

function createBluetoothFixture(options: { rejectProof?: boolean; rejectMicrophone?: boolean } = {}) {
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
      } else if (bytes[0] === 0xfe && bytes[4] === 0x04) {
        const sequence = bytes[7] ?? 0;
        notify(Uint8Array.of(
          0xfe, 0xdc, 0xba, 0x00, 0x04, 0x00, 0x02,
          options.rejectMicrophone ? 0x01 : 0x00,
          sequence,
          0xef,
        ));
      }
    },
    async startNotifications() { return notifyCharacteristic; },
    addEventListener() {},
    removeEventListener() {},
  };

  notifyCharacteristic = {
    value: null,
    async startNotifications() { return notifyCharacteristic; },
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
    notify,
    writes,
  };
}

function createOmiBluetoothFixture(options: { codec?: number } = {}) {
  const listeners = new Set<(event: Event) => void>();
  let audioCharacteristic: Z02BluetoothCharacteristic;
  audioCharacteristic = {
    value: null,
    async startNotifications() { return audioCharacteristic; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const codecBytes = Uint8Array.of(options.codec ?? 0x15);
  const codecCharacteristic: Z02BluetoothCharacteristic = {
    async readValue() {
      return new DataView(codecBytes.buffer, codecBytes.byteOffset, codecBytes.byteLength);
    },
    async startNotifications() { return codecCharacteristic; },
    addEventListener() {},
    removeEventListener() {},
  };
  const getCharacteristic = vi.fn(async (uuid: string) => (
    uuid === OMI_AUDIO_CHARACTERISTIC_UUID ? audioCharacteristic : codecCharacteristic
  ));
  const getPrimaryService = vi.fn(async () => ({ getCharacteristic }));
  const disconnect = vi.fn();
  const device = {
    name: 'Omi',
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return { getPrimaryService };
      },
      disconnect,
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const requestDevice = vi.fn(async () => device);
  return {
    bluetooth: { requestDevice } satisfies Z02Bluetooth,
    disconnect,
    getCharacteristic,
    getPrimaryService,
    notify(bytes: Uint8Array) {
      audioCharacteristic.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const event = { target: audioCharacteristic } as unknown as Event;
      for (const listener of listeners) listener(event);
    },
    requestDevice,
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
