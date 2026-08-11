import { authenticateStockZ02, type Z02AuthIo } from './rcsp-auth.js';

export const Z02_RCSP_SERVICE_UUID = '0000ae00-0000-1000-8000-00805f9b34fb';
export const Z02_WRITE_CHARACTERISTIC_UUID = '0000ae01-0000-1000-8000-00805f9b34fb';
export const Z02_NOTIFY_CHARACTERISTIC_UUID = '0000ae02-0000-1000-8000-00805f9b34fb';

const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_QUEUED_NOTIFICATIONS = 32;

export type Z02LinkProgress = 'selecting' | 'connecting' | 'authenticating';

export interface Z02LinkConnection {
  readonly deviceName: string;
  disconnect(): void;
}

export interface Z02LinkConnector {
  connect(callbacks: {
    disconnected: () => void;
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
  startNotifications(): Promise<Z02BluetoothCharacteristic>;
  stopNotifications?(): Promise<Z02BluetoothCharacteristic>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
  writeValue?(value: Uint8Array): Promise<void>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
}

export class WebBluetoothZ02Connector implements Z02LinkConnector {
  constructor(private readonly bluetooth: Z02Bluetooth) {}

  async connect(callbacks: {
    disconnected: () => void;
    progress?: (phase: Z02LinkProgress) => void;
  }): Promise<Z02LinkConnection> {
    callbacks.progress?.('selecting');
    const device = await this.bluetooth.requestDevice({
      filters: [
        { services: [Z02_RCSP_SERVICE_UUID] },
        { namePrefix: 'ZNP Z02' },
      ],
      optionalServices: [Z02_RCSP_SERVICE_UUID],
    });
    const gatt = device.gatt;
    if (!gatt) throw new Error('The selected badge has no Bluetooth GATT interface');

    let notifyCharacteristic: Z02BluetoothCharacteristic | null = null;
    let notificationListener: ((event: Event) => void) | null = null;
    let disconnectedListener: (() => void) | null = null;
    const inbox = new NotificationInbox();

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
      const server = await withTimeout(gatt.connect(), CONNECTION_TIMEOUT_MS, 'Z02 connection timed out');
      const service = await withTimeout(
        server.getPrimaryService(Z02_RCSP_SERVICE_UUID),
        CONNECTION_TIMEOUT_MS,
        'Z02 RCSP service was not found',
      );
      const [writeCharacteristic, notifications] = await Promise.all([
        service.getCharacteristic(Z02_WRITE_CHARACTERISTIC_UUID),
        service.getCharacteristic(Z02_NOTIFY_CHARACTERISTIC_UUID),
      ]);
      notifyCharacteristic = notifications;
      notificationListener = (event: Event) => {
        const source = event.target as Z02BluetoothCharacteristic | null;
        const value = source?.value;
        if (!value) return;
        inbox.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      };
      notifications.addEventListener('characteristicvaluechanged', notificationListener);
      await notifications.startNotifications();

      disconnectedListener = () => {
        cleanUpListeners();
        inbox.close(new Error('Z02 disconnected'));
        callbacks.disconnected();
      };
      device.addEventListener('gattserverdisconnected', disconnectedListener);

      callbacks.progress?.('authenticating');
      const io: Z02AuthIo = {
        write: value => writeCharacteristicValue(writeCharacteristic, value),
        nextNotification: timeoutMs => inbox.next(timeoutMs),
      };
      await authenticateStockZ02(io);

      let closed = false;
      return {
        deviceName: device.name?.trim() || 'ZNP Z02',
        disconnect() {
          if (closed) return;
          closed = true;
          cleanUpListeners();
          inbox.close(new Error('Z02 link closed'));
          if (gatt.connected) gatt.disconnect();
          if (notifyCharacteristic?.stopNotifications) {
            void notifyCharacteristic.stopNotifications().catch(() => undefined);
          }
        },
      };
    } catch (error) {
      cleanUpListeners();
      inbox.close(new Error('Z02 link failed'));
      if (gatt.connected) gatt.disconnect();
      throw error;
    }
  }
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

class NotificationInbox {
  private readonly queued: Uint8Array[] = [];
  private readonly waiters: Array<{
    resolve: (value: Uint8Array) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }> = [];
  private closed: Error | null = null;

  push(value: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    this.queued.push(value);
    if (this.queued.length > MAX_QUEUED_NOTIFICATIONS) this.queued.shift();
  }

  next(timeoutMs: number): Promise<Uint8Array> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(this.closed);

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Z02 authentication timed out'));
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}
