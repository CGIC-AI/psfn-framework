// ── Minimal Multipart Form-Data Parser ──
// Handles single-file uploads only. No external dependencies.
// Parses boundary from Content-Type, extracts file field from body.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendText } from '../http/primitives.js';

const MAX_UPLOAD_SIZE = 2 * 1024 * 1024; // 2MB
const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

export interface ParsedFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartParseSuccess {
  ok: true;
  file: ParsedFile;
}

export interface MultipartParseFailure {
  ok: false;
  error: string;
  status: number;
}

export type MultipartParseResult = MultipartParseSuccess | MultipartParseFailure;

/**
 * Extract the boundary string from a Content-Type header.
 * Example: "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW"
 */
export function extractBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return null;

  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) return null;

  // Strip surrounding quotes if present
  let boundary = boundaryMatch[1];
  if (boundary.startsWith('"') && boundary.endsWith('"')) {
    boundary = boundary.slice(1, -1);
  }
  return boundary || null;
}

/**
 * Parse Content-Disposition header to extract field name and filename.
 * Example: 'form-data; name="file"; filename="character.json"'
 */
function parseContentDisposition(header: string): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};

  const nameMatch = header.match(/\bname="([^"]*?)"/i);
  if (nameMatch) result.name = nameMatch[1];

  const filenameMatch = header.match(/\bfilename="([^"]*?)"/i);
  if (filenameMatch) result.filename = filenameMatch[1];

  return result;
}

/**
 * Parse a multipart/form-data body buffer and extract the first file part.
 * Only supports a single file field — returns the first file found.
 */
export function parseMultipartBody(body: Buffer, boundary: string): MultipartParseResult {
  const delimiter = Buffer.from(`--${boundary}`);
  const endDelimiter = Buffer.from(`--${boundary}--`);

  // Split body by delimiter
  let searchFrom = 0;
  const parts: Buffer[] = [];

  while (true) {
    const delimStart = body.indexOf(delimiter, searchFrom);
    if (delimStart === -1) break;

    const afterDelim = delimStart + delimiter.length;
    // Check for end delimiter
    if (body.indexOf(endDelimiter, delimStart) === delimStart) break;

    // Skip past the CRLF after delimiter
    const partStart = body.indexOf(CRLF, afterDelim);
    if (partStart === -1) break;

    const contentStart = partStart + CRLF.length;

    // Find next delimiter
    const nextDelim = body.indexOf(delimiter, contentStart);
    if (nextDelim === -1) break;

    // Part content is between contentStart and the CRLF before nextDelim
    const partEnd = nextDelim - CRLF.length;
    if (partEnd > contentStart) {
      parts.push(body.subarray(contentStart, partEnd));
    }

    searchFrom = nextDelim;
  }

  // Parse each part looking for a file upload
  for (const part of parts) {
    const headerEnd = part.indexOf(DOUBLE_CRLF);
    if (headerEnd === -1) continue;

    const headersRaw = part.subarray(0, headerEnd).toString('utf-8');
    const fileData = part.subarray(headerEnd + DOUBLE_CRLF.length);

    const headers = headersRaw.split('\r\n');
    let disposition: { name?: string; filename?: string } = {};
    let partContentType = 'application/octet-stream';

    for (const headerLine of headers) {
      const colonIndex = headerLine.indexOf(':');
      if (colonIndex === -1) continue;
      const headerName = headerLine.substring(0, colonIndex).trim().toLowerCase();
      const headerValue = headerLine.substring(colonIndex + 1).trim();

      if (headerName === 'content-disposition') {
        disposition = parseContentDisposition(headerValue);
      } else if (headerName === 'content-type') {
        partContentType = headerValue;
      }
    }

    if (disposition.filename) {
      return {
        ok: true,
        file: {
          fieldName: disposition.name ?? 'file',
          filename: disposition.filename,
          contentType: partContentType,
          data: fileData,
        },
      };
    }
  }

  return {
    ok: false,
    error: 'No file found in upload',
    status: 400,
  };
}

/**
 * Read the raw request body as a Buffer with a size limit.
 * Returns null and sends 413 if the body exceeds the limit.
 */
export function readRawBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;

    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer): void => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        sendText(res, 413, 'Payload Too Large');
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      if (totalSize > maxBytes) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks));
    };

    const onError = (err: Error): void => fail(err);

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Full multipart upload handler: reads body, parses multipart, extracts file.
 * Validates Content-Type, size limit, and boundary presence.
 */
export async function handleMultipartUpload(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { maxBytes?: number },
): Promise<MultipartParseResult> {
  const maxBytes = options?.maxBytes ?? MAX_UPLOAD_SIZE;

  const boundary = extractBoundary(req.headers['content-type']);
  if (!boundary) {
    return {
      ok: false,
      error: 'Content-Type must be multipart/form-data with a boundary',
      status: 400,
    };
  }

  const body = await readRawBody(req, res, maxBytes);
  if (body === null) {
    return {
      ok: false,
      error: 'Request body too large (max 2MB)',
      status: 413,
    };
  }

  return parseMultipartBody(body, boundary);
}

/**
 * Validate that a parsed file is a JSON file and parse its contents.
 */
export function validateAndParseJsonFile(
  file: ParsedFile,
): { ok: true; data: unknown; filename: string } | { ok: false; error: string } {
  // Check filename extension
  const lowerFilename = file.filename.toLowerCase();
  if (!lowerFilename.endsWith('.json')) {
    return {
      ok: false,
      error: `File must be a .json file, got: ${file.filename}`,
    };
  }

  // Parse JSON content
  const text = file.data.toString('utf-8');
  try {
    const data: unknown = JSON.parse(text);
    return { ok: true, data, filename: file.filename };
  } catch {
    return {
      ok: false,
      error: 'File contains invalid JSON',
    };
  }
}
