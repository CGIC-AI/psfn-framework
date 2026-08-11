import { authenticateStockZ02, type Z02AuthIo } from './rcsp-auth.js';
import {
  OMI_OPUS_CODEC_ID,
  OmiOpusFrameAssembler,
  type OmiOpusFrame,
} from './omi-audio.js';
import {
  RcspStreamDecoder,
  encodeRcspCommand,
  type RcspResponseFrame,
} from './rcsp-frame.js';

export const Z02_RCSP_SERVICE_UUID = '0000ae00-0000-1000-8000-00805f9b34fb';
export const Z02_WRITE_CHARACTERISTIC_UUID = '0000ae01-0000-1000-8000-00805f9b34fb';
export const Z02_NOTIFY_CHARACTERISTIC_UUID = '0000ae02-0000-1000-8000-00805f9b34fb';
export const OMI_AUDIO_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
export const OMI_AUDIO_CHARACTERISTIC_UUID = '19b10001-e8f2-537e-4f6c-d104768a1214';
export const OMI_CODEC_CHARACTERISTIC_UUID = '19b10002-e8f2-537e-4f6c-d104768a1214';

const CONNECTION_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 6_000;
const DISCONNECT_WRITE_TIMEOUT_MS = 1_000;
const MAX_QUEUED_NOTIFICATIONS = 32;
const RCSP_OPCODE_DATA = 0x01;
const RCSP_OPCODE_APP_RECORDING = 0x04;
const RCSP_OPCODE_APP_RECORD_END = 0x05;
const RCSP_AUDIO_CODEC_PCM = 0x00;

export type Z02LinkProgress = 'selecting' | 'connecting' | 'authenticating' | 'subscribing';

export type Z02LinkTransport = 'stock-rcsp' | 'omi-audio';

export interface Z02LinkConnection {
  readonly deviceName: string;
  readonly transport: Z02LinkTransport;
  readonly microphone: 'pcm16-16khz' | 'opus-16khz';
  disconnect(): void;
}

export interface Z02LinkConnector {
  connect(callbacks: {
    audioPcm?: (pcm: Uint8Array) => void;
    audioFrame?: (frame: OmiOpusFrame) => void;
    disconnected: () => void;
    error?: (error: Error) => void;
    progress?: (phase: Z02LinkProgress) => void;
  }): Promise<Z02LinkConnection>;
}

export interface Z02Bluetooth {
  requestDevice(options: {
    filters: Array<{ services?: string[]; namePrefix?: string }>;
    optionalServices?: string[];
  }): Promise<Z02BluetoothDevice>;
}

interface Z02BluetoothDevice {
  readonly name?: string | null;
  readonly gatt?: Z02BluetoothRemoteGatt | null;
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void;
}

interface Z02BluetoothRemoteGatt {
  readonly connected: boolean;
  connect(): Promise<Z02BluetoothGattServer>;
  disconnect(): void;
}

interface Z02BluetoothGattServer {
  getPrimaryService(uuid: string): Promise<Z02BluetoothService>;
}

interface Z02BluetoothService {
  getCharacteristic(uuid: string): Promise<Z02BluetoothCharacteristic>;
}

export interface Z02BluetoothCharacteristic {
  value?: DataView | null;
  readValue?(): Promise<DataView>;
  startNotifications(): Promise<Z02BluetoothCharacteristic>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
  writeValue?(value: Uint8Array): Promise<void>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
}

export class WebBluetoothZ02Connector implements Z02LinkConnector {
  constructor(private readonly bluetooth: Z02Bluetooth) {}

  async connect(callbacks: {
    audioPcm?: (pcm: Uint8Array) => void;
    audioFrame?: (frame: OmiOpusFrame) => void;
    disconnected: () => void;
    error?: (error: Error) => void;
    progress?: (phase: Z02LinkProgress) => void;
  }): Promise<Z02LinkConnection> {
    callbacks.progress?.('selecting');
    const device = await this.bluetooth.requestDevice({
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
    const gatt = device.gatt;
    if (!gatt) throw new Error('The selected badge has no Bluetooth GATT interface');

    let notifyCharacteristic: Z02BluetoothCharacteristic | null = null;
    let notificationListener: ((event: Event) => void) | null = null;
    let disconnectedListener: (() => void) | null = null;
    const inbox = new BoundedInbox<Uint8Array>();
    let rcspInbox: BoundedInbox<RcspResponseFrame> | null = null;
    let stopStockMicrophone: (() => Promise<void>) | null = null;

    const cleanUpListeners = () => {
      if (notifyCharacteristic && notificationListener) {
        notifyCharacteristic.removeEventListener('characteristicvaluechanged', notificationListener);
      }
      if (disconnectedListener) {
        device.removeEventListener('gattserverdisconnected', disconnectedListener);
      }
      notificationListener = null;
      disconnectedListener = null;
    };

    try {
      callbacks.progress?.('connecting');
      const server = await withTimeout(
        gatt.connect(),
        CONNECTION_TIMEOUT_MS,
        'Z02 connection timed out',
        () => {
          if (gatt.connected) gatt.disconnect();
        },
      );
      disconnectedListener = () => {
        cleanUpListeners();
        inbox.close(new Error('Z02 disconnected'));
        rcspInbox?.close(new Error('Z02 disconnected'));
        callbacks.disconnected();
      };
      device.addEventListener('gattserverdisconnected', disconnectedListener);

      let transport: Z02LinkTransport;
      let microphone: Z02LinkConnection['microphone'];
      if (isOmiAudioDevice(device.name)) {
        const service = await withTimeout(
          server.getPrimaryService(OMI_AUDIO_SERVICE_UUID),
          CONNECTION_TIMEOUT_MS,
          'Omi audio service discovery timed out',
        );
        const [audio, codec] = await withTimeout(
          Promise.all([
            service.getCharacteristic(OMI_AUDIO_CHARACTERISTIC_UUID),
            service.getCharacteristic(OMI_CODEC_CHARACTERISTIC_UUID),
          ]),
          CONNECTION_TIMEOUT_MS,
          'Omi audio characteristic discovery timed out',
        );
        if (!codec.readValue) throw new Error('The Omi codec characteristic is not readable');
        const codecValue = await withTimeout(
          codec.readValue(),
          OPERATION_TIMEOUT_MS,
          'Omi codec read timed out',
        );
        const codecId = codecValue.byteLength > 0 ? codecValue.getUint8(0) : -1;
        if (codecId !== OMI_OPUS_CODEC_ID) {
          throw new Error(`Unsupported Omi audio codec ${codecId}`);
        }

        const assembler = new OmiOpusFrameAssembler();
        notifyCharacteristic = audio;
        notificationListener = (event: Event) => {
          const source = event.target as Z02BluetoothCharacteristic | null;
          const value = source?.value;
          if (!value) return;
          const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
          try {
            for (const frame of assembler.push(bytes)) callbacks.audioFrame?.(frame);
          } catch (error) {
            assembler.reset();
            callbacks.error?.(asError(error, 'Omi audio packet was malformed'));
          }
        };
        audio.addEventListener('characteristicvaluechanged', notificationListener);
        callbacks.progress?.('subscribing');
        await withTimeout(
          audio.startNotifications(),
          OPERATION_TIMEOUT_MS,
          'Omi audio subscription timed out',
        );
        transport = 'omi-audio';
        microphone = 'opus-16khz';
      } else {
        const service = await withTimeout(
          server.getPrimaryService(Z02_RCSP_SERVICE_UUID),
          CONNECTION_TIMEOUT_MS,
          'Z02 service discovery timed out',
        );
        const [writeCharacteristic, notifications] = await withTimeout(
          Promise.all([
            service.getCharacteristic(Z02_WRITE_CHARACTERISTIC_UUID),
            service.getCharacteristic(Z02_NOTIFY_CHARACTERISTIC_UUID),
          ]),
          CONNECTION_TIMEOUT_MS,
          'Z02 characteristic discovery timed out',
        );
        notifyCharacteristic = notifications;
        notificationListener = (event: Event) => {
          const source = event.target as Z02BluetoothCharacteristic | null;
          const value = source?.value;
          if (!value) return;
          consumeNotification(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
        };
        let consumeNotification = (value: Uint8Array) => inbox.push(value);
        notifications.addEventListener('characteristicvaluechanged', notificationListener);
        await withTimeout(
          notifications.startNotifications(),
          OPERATION_TIMEOUT_MS,
          'Z02 notification subscription timed out',
        );

        callbacks.progress?.('authenticating');
        const io: Z02AuthIo = {
          write: value => withTimeout(
            writeCharacteristicValue(writeCharacteristic, value),
            OPERATION_TIMEOUT_MS,
            'Z02 authentication write timed out',
          ),
          nextNotification: timeoutMs => inbox.next(
            timeoutMs,
            'Z02 authentication timed out',
          ),
        };
        await authenticateStockZ02(io);

        const decoder = new RcspStreamDecoder();
        rcspInbox = new BoundedInbox<RcspResponseFrame>();
        consumeNotification = value => {
          for (const frame of decoder.push(value)) {
            if (frame.kind === 'command'
              && frame.opcode === RCSP_OPCODE_DATA
              && frame.data[0] === RCSP_OPCODE_APP_RECORDING) {
              const pcm = frame.data.slice(1);
              if (pcm.byteLength > 0 && pcm.byteLength % 2 === 0) callbacks.audioPcm?.(pcm);
            } else if (frame.kind === 'response') {
              rcspInbox?.push(frame);
            }
          }
        };

        const startSequence = randomRcspSequence();
        const stopSequence = (startSequence + 1) & 0xff;
        const writeRcsp = (value: Uint8Array) => withTimeout(
          writeCharacteristicValue(writeCharacteristic, value),
          OPERATION_TIMEOUT_MS,
          'Z02 RCSP write timed out',
        );
        stopStockMicrophone = () => writeCharacteristicValue(
          writeCharacteristic,
          encodeRcspCommand(RCSP_OPCODE_APP_RECORD_END, stopSequence),
        );
        callbacks.progress?.('subscribing');
        await writeRcsp(encodeRcspCommand(
          RCSP_OPCODE_APP_RECORDING,
          startSequence,
          Uint8Array.of(RCSP_AUDIO_CODEC_PCM),
        ));
        const startResponse = await rcspInbox.next(
          OPERATION_TIMEOUT_MS,
          'Z02 microphone start timed out',
          response => response.opcode === RCSP_OPCODE_APP_RECORDING
            && response.sequence === startSequence,
        );
        if (startResponse.status !== 0) throw new Error('Z02 microphone start failed');
        transport = 'stock-rcsp';
        microphone = 'pcm16-16khz';
      }

      let closed = false;
      return {
        deviceName: device.name?.trim() || 'ZNP Z02',
        microphone,
        transport,
        disconnect() {
          if (closed) return;
          closed = true;
          cleanUpListeners();
          inbox.close(new Error('Z02 link closed'));
          rcspInbox?.close(new Error('Z02 link closed'));
          const stop = stopStockMicrophone;
          stopStockMicrophone = null;
          if (!stop || !gatt.connected) {
            if (gatt.connected) gatt.disconnect();
            return;
          }
          void withTimeout(
            stop(),
            DISCONNECT_WRITE_TIMEOUT_MS,
            'Z02 microphone stop timed out',
          ).catch(error => {
            callbacks.error?.(asError(error, 'Z02 microphone stop failed'));
          }).finally(() => {
            if (gatt.connected) gatt.disconnect();
          });
        },
      };
    } catch (error) {
      cleanUpListeners();
      inbox.close(new Error('Z02 link failed'));
      rcspInbox?.close(new Error('Z02 link failed'));
      if (stopStockMicrophone && gatt.connected) {
        try {
          await withTimeout(
            stopStockMicrophone(),
            DISCONNECT_WRITE_TIMEOUT_MS,
            'Z02 microphone stop timed out',
          );
        } catch (stopError) {
          callbacks.error?.(asError(stopError, 'Z02 microphone stop failed'));
        }
      }
      if (gatt.connected) gatt.disconnect();
      throw error;
    }
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function randomRcspSequence(): number {
  const value = new Uint8Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] ?? 0;
}

function isOmiAudioDevice(name: string | null | undefined): boolean {
  return name?.trim().toLowerCase().startsWith('omi') ?? false;
}

export function readBrowserZ02Connector(): Z02LinkConnector | null {
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) return null;
  const bluetooth = (navigator as Navigator & { bluetooth: Z02Bluetooth }).bluetooth;
  return new WebBluetoothZ02Connector(bluetooth);
}

async function writeCharacteristicValue(
  characteristic: Z02BluetoothCharacteristic,
  value: Uint8Array,
): Promise<void> {
  if (characteristic.writeValueWithoutResponse) {
    await characteristic.writeValueWithoutResponse(value);
    return;
  }
  if (characteristic.writeValue) {
    await characteristic.writeValue(value);
    return;
  }
  throw new Error('The Z02 write characteristic is not writable');
}

class BoundedInbox<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Array<{
    matches: (value: T) => boolean;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }> = [];
  private closed: Error | null = null;

  push(value: T): void {
    if (this.closed) return;
    const waiterIndex = this.waiters.findIndex(waiter => waiter.matches(value));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (!waiter) return;
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    this.queued.push(value);
    if (this.queued.length > MAX_QUEUED_NOTIFICATIONS) this.queued.shift();
  }

  next(
    timeoutMs: number,
    timeoutMessage: string,
    matches: (value: T) => boolean = () => true,
  ): Promise<T> {
    const queuedIndex = this.queued.findIndex(matches);
    if (queuedIndex >= 0) {
      const [queued] = this.queued.splice(queuedIndex, 1);
      if (queued !== undefined) return Promise.resolve(queued);
    }
    if (this.closed) return Promise.reject(this.closed);

    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(timeoutMessage));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    for (const waiter of this.waiters.splice(0)) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.queued.length = 0;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onLateResolution?: (value: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let expired = false;
  const observed = promise.then(value => {
    if (expired) onLateResolution?.(value);
    return value;
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      expired = true;
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}
