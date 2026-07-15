import type { Attachment } from '../../shared/contracts/runtime.js';
import { materializeContainedFileSync } from '../../shared/utils/contained-file.js';
import { isRecord } from '../../shared/utils/types.js';

const MAX_GATEWAY_ATTACHMENTS = 10;
const MAX_GATEWAY_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function requireAttachmentString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Gateway attachment ${field} is invalid`);
  }
  return value.trim();
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length > Math.ceil(MAX_GATEWAY_ATTACHMENT_BYTES * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error('Gateway attachment dataBase64 is invalid or oversized');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_GATEWAY_ATTACHMENT_BYTES
    || bytes.toString('base64') !== value) {
    throw new Error('Gateway attachment dataBase64 is invalid or oversized');
  }
  return bytes;
}

/**
 * Converts an attachment owned by the authenticated companion into immutable
 * bytes before it crosses into a host adapter. Local paths and parsed sidecar
 * paths never leave this boundary.
 */
export function materializeGatewayAttachment(
  attachment: Attachment,
  personalWorkspacePath: string,
): Attachment {
  if (!isRecord(attachment)) throw new Error('Gateway attachment must be an object');
  const url = requireAttachmentString(attachment.url, 'url', 8_192);
  const contentType = requireAttachmentString(attachment.contentType, 'contentType', 255);
  const name = requireAttachmentString(attachment.name, 'name', 512);
  const localPath = typeof attachment.localPath === 'string' && attachment.localPath.trim()
    ? attachment.localPath.trim()
    : null;
  const dataBase64 = typeof attachment.dataBase64 === 'string' && attachment.dataBase64
    ? attachment.dataBase64
    : null;
  if (localPath && dataBase64) {
    throw new Error('Gateway attachment must not provide both localPath and dataBase64');
  }

  if (localPath) {
    const materialized = materializeContainedFileSync({
      path: localPath,
      root: personalWorkspacePath,
      readMaxBytes: MAX_GATEWAY_ATTACHMENT_BYTES,
    });
    if (!materialized.bytes) throw new Error('Gateway attachment exceeds the byte limit');
    return { url, contentType, name, dataBase64: materialized.bytes.toString('base64') };
  }
  if (dataBase64) {
    const bytes = decodeCanonicalBase64(dataBase64);
    return { url, contentType, name, dataBase64: bytes.toString('base64') };
  }
  return { url, contentType, name };
}

export function materializeGatewayAttachments(
  attachments: readonly Attachment[] | undefined,
  personalWorkspacePath: string,
): Attachment[] | undefined {
  if (attachments === undefined) return undefined;
  if (!Array.isArray(attachments) || attachments.length > MAX_GATEWAY_ATTACHMENTS) {
    throw new Error('Gateway attachments exceed the materialization limit');
  }
  return attachments.map((attachment) => materializeGatewayAttachment(
    attachment,
    personalWorkspacePath,
  ));
}
