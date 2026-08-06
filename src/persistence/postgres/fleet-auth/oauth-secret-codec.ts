import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { fleetAuthPersistenceBoundaryValues } from './boundary-values-port.js';

const CIPHERTEXT_VERSION = 1;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export class FleetAuthSecretCodec {
  private readonly sessionPepper: string;
  private readonly encryptionKey: Buffer;

  constructor(options: { sessionPepper: string; tokenEncryptionKey: string }) {
    this.sessionPepper = options.sessionPepper;
    this.encryptionKey = createHash('sha256')
      .update(options.tokenEncryptionKey, 'utf8')
      .digest();
  }

  digest(value: string): string {
    return createHmac('sha256', this.sessionPepper).update(value).digest('hex');
  }

  encrypt(value: string): Buffer {
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([
      Buffer.from([CIPHERTEXT_VERSION]),
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  decrypt(value: Buffer): string {
    const minimumLength = 1 + AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES + 1;
    if (value.length < minimumLength || value[0] !== CIPHERTEXT_VERSION) {
      throw new fleetAuthPersistenceBoundaryValues.FleetAuthBrokerError(
        'invalid_oauth_state',
        400,
        'OAuth transaction is not usable',
      );
    }
    const ivStart = 1;
    const tagStart = ivStart + AES_GCM_IV_BYTES;
    const ciphertextStart = tagStart + AES_GCM_TAG_BYTES;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      value.subarray(ivStart, tagStart),
    );
    decipher.setAuthTag(value.subarray(tagStart, ciphertextStart));
    try {
      return Buffer.concat([
        decipher.update(value.subarray(ciphertextStart)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new fleetAuthPersistenceBoundaryValues.FleetAuthBrokerError(
        'invalid_oauth_state',
        400,
        'OAuth transaction is not usable',
      );
    }
  }
}
