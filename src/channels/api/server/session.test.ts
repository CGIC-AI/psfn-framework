import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MAX_BODY_SIZE, SATELLITE_HUB_BODY_SIZE } from './http.js';
import { resolveChatCompletionBodyLimit } from './request.js';
import {
  getLastUserMessage,
  getLastUserMessageAttachments,
} from './session.js';
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
