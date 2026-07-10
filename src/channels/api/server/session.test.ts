import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MAX_BODY_SIZE, SATELLITE_HUB_BODY_SIZE } from './http.js';
import { resolveChatCompletionBodyLimit } from './request.js';
import {
  getLastUserMessage,
  getLastUserMessageAttachments,
  getMessageFileParts,
  ingestApiDocumentFileParts,
} from './session.js';
import { validateChatCompletionRequest } from '../request-validation.js';
import type { ChatCompletionRequest } from '../types.js';

describe('API chat message content handling', () => {
  it('extracts text and inline base64 image attachments from typed message content', () => {
    const messages: ChatCompletionRequest['messages'] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'what do you see?' },
        {
          type: 'image',
          data: ' YWJjZA==\n',
          mimeType: 'image/jpeg',
          name: 'vam-screen.jpg',
        },
      ],
    }];

    expect(getLastUserMessage(messages)).toBe('what do you see?');
    expect(getLastUserMessageAttachments(messages)).toEqual([{
      url: 'inline:image:0',
      contentType: 'image/jpeg',
      name: 'vam-screen.jpg',
      dataBase64: 'YWJjZA==',
    }]);
  });

  it('decodes OpenAI image_url data URLs into inline image attachments', () => {
    const messages: ChatCompletionRequest['messages'] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,YWJjZA==',
          },
        },
      ],
    }];

    expect(getLastUserMessageAttachments(messages)).toEqual([{
      url: 'inline:image:0',
      contentType: 'image/png',
      name: 'inline-image-1.png',
      dataBase64: 'YWJjZA==',
    }]);
  });

  it('doubles chat body size only for satellite hub transactions', () => {
    expect(resolveChatCompletionBodyLimit(requestWithHeaders({}))).toBe(MAX_BODY_SIZE);
    expect(resolveChatCompletionBodyLimit(requestWithHeaders({
      'x-psfn-channel-type': 'satellite.endpoint',
    }))).toBe(SATELLITE_HUB_BODY_SIZE);
    expect(resolveChatCompletionBodyLimit(requestWithHeaders({
      'x-psfn-satellite-id': 'voxta-vam',
    }))).toBe(SATELLITE_HUB_BODY_SIZE);
  });
});

function requestWithHeaders(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

// ── htm9.9: OpenAI-compatible `file` content parts ──

describe('API file content parts (htm9.9)', () => {
  const mdBase64 = Buffer.from('# Notes\n\nhello from the api', 'utf8').toString('base64');

  it('extracts supported file parts as document ingest candidates', () => {
    const extraction = getMessageFileParts({
      role: 'user',
      content: [
        { type: 'text', text: 'please read this' },
        { type: 'file', file: { filename: 'notes.md', file_data: mdBase64 } },
        { type: 'file', file: { filename: 'report.bin', file_data: mdBase64 } },
      ],
    });

    expect(extraction.candidates).toHaveLength(1);
    expect(extraction.candidates[0]).toMatchObject({
      name: 'notes.md',
      contentType: 'text/markdown',
    });
    expect(extraction.candidates[0]!.bytes?.toString('utf8')).toContain('hello from the api');
    // Unsupported format, not metadata-risky: refused with a visible reason,
    // never silently dropped.
    expect(extraction.rejected).toHaveLength(1);
    expect(extraction.rejected[0]!.name).toBe('report.bin');
    expect(extraction.rejected[0]!.reason).toContain('unsupported file attachment type');
  });

  it('reads the declared MIME from base64 data: URLs', () => {
    const extraction = getMessageFileParts({
      role: 'user',
      content: [
        { type: 'file', file: { filename: 'notes.txt', file_data: `data:text/plain;base64,${mdBase64}` } },
      ],
    });
    expect(extraction.candidates).toHaveLength(1);
    expect(extraction.candidates[0]).toMatchObject({ contentType: 'text/plain' });
  });

  it('fails closed into a soft notice when document ingestion is not configured', async () => {
    const extraction = getMessageFileParts({
      role: 'user',
      content: [{ type: 'file', file: { filename: 'notes.md', file_data: mdBase64 } }],
    });
    const outcome = await ingestApiDocumentFileParts({
      extraction,
      content: 'please read this',
      channelId: 'api:test',
      messageId: 'msg-1',
      authorId: 'author-1',
      attachmentIndexBase: 0,
      documentIngest: null,
    });

    expect(outcome.attachments).toEqual([]);
    expect(outcome.intakeEnvelopes).toEqual([]);
    expect(outcome.content).toContain('[Attached file parse failed: notes.md]');
    expect(outcome.content).toContain('document ingestion is not configured');
    expect(outcome.content).not.toContain('hello from the api');
  });

  it('validates file content parts fail-closed at the request boundary', () => {
    const base = {
      model: 'companion',
      messages: [{
        role: 'user',
        content: [{ type: 'file', file: { filename: 'notes.md', file_data: mdBase64 } }],
      }],
    };
    expect(validateChatCompletionRequest(base).ok).toBe(true);

    const malformed = {
      model: 'companion',
      messages: [{
        role: 'user',
        content: [{ type: 'file', file: { filename: 'notes.md', file_data: '!!!not-base64!!!' } }],
      }],
    };
    const result = validateChatCompletionRequest(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('file_data must be base64');
    }
  });
});
