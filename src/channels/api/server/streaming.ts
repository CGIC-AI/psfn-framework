import type { ServerResponse } from 'node:http';
import {
  SSE_RESPONSE_HEADERS,
  buildStreamingContentChunk,
  buildStreamingErrorEvent,
  buildStreamingFinishChunk,
  buildStreamingRoleChunk,
  formatSseDataEvent,
  formatSseDoneEvent,
  formatSseErrorEvent,
  type StreamingChunkMetadata,
} from '../response-format.js';
import type { ChatCompletionChunk } from '../types.js';
import { canWriteResponse } from './http.js';

export class SseStreamingTransport {
  private readonly res: ServerResponse;
  private readonly metadata: StreamingChunkMetadata;

  constructor(res: ServerResponse, metadata: StreamingChunkMetadata) {
    this.res = res;
    this.metadata = metadata;
  }

  open(): void {
    this.res.writeHead(200, SSE_RESPONSE_HEADERS);
  }

  writeRole(): void {
    this.writeChunk(buildStreamingRoleChunk(this.metadata));
  }

  writeContent(content: string): void {
    this.writeChunk(buildStreamingContentChunk(this.metadata, content));
  }

  writeFinish(): void {
    this.writeChunk(buildStreamingFinishChunk(this.metadata));
  }

  writeErrorAndDone(
    type: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.res.write(formatSseErrorEvent(buildStreamingErrorEvent(type, message, details)));
    this.writeDone();
  }

  writeDone(): void {
    this.res.write(formatSseDoneEvent());
  }

  endIfWritable(): void {
    if (canWriteResponse(this.res)) {
      this.res.end();
    }
  }

  private writeChunk(chunk: ChatCompletionChunk): void {
    this.res.write(formatSseDataEvent(chunk));
  }
}
