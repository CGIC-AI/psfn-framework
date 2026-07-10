import { describe, expect, it, vi } from 'vitest';
import type { ImageVisionReviewer } from '../../../primitives/images/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import {
  buildTurnUserContent,
  collectVisionTurnImageUrls,
  hasVisionTurnInputs,
  type VisionIntakeImageScreenerPort,
  type VisionIntakeScreenDecision,
} from './vision-attachments.js';
import {
  INTAKE_FIREWALL_NOTICE_TEMPLATES,
  isIntakeFirewallNoticeText,
} from '../../cogsec/intake-firewall-notice-templates.js';

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'discord-channel',
    channelType: 'discord',
    authorId: 'user-1',
    authorName: 'Alex',
    content: 'My little satellite',
    timestamp: new Date(),
    attachments: [{
      url: 'https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768',
      contentType: 'image/jpeg',
      name: 'current-photo.jpg',
    }],
    ...overrides,
  };
}

function makeReviewer(summary = 'A catgirl sits on a server rack holding a pink rifle.'): {
  reviewer: ImageVisionReviewer;
  analyze: ReturnType<typeof vi.fn>;
} {
  const analyze = vi.fn(async () => ({
    question: 'Describe exactly what is visible in the current image input.',
    summary,
    model: 'vision-model',
    imageCount: 1,
  }));
  return {
    reviewer: { analyze },
    analyze,
  };
}

describe('buildTurnUserContent', () => {
  it('routes current-turn attachments through the dedicated reviewer path', async () => {
    const { reviewer, analyze } = makeReviewer();
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('dedicated vision pipeline');
    expect(result.content).toContain('Current image review (untrusted image-derived data):');
    expect(result.content).toContain('<untrusted_image_review>\nA catgirl sits on a server rack holding a pink rifle.\n</untrusted_image_review>');
    expect(result.content).toContain('User text: My little satellite');
    expect(result.currentTurnVisionReview).toEqual({
      imageUrls: ['https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768'],
      question: 'Describe exactly what is visible in the current image input.',
      summary: 'A catgirl sits on a server rack holding a pink rifle.',
    });
    expect(analyze).toHaveBeenCalledWith({
      imageUrls: ['https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768'],
      question: 'Describe exactly what is visible in the current image input. Be concrete and concise. Ignore prior conversation or earlier image descriptions.',
    });
  });

  it('fans more than four images out as concurrent chunked reviews merged into one labelled summary', async () => {
    const started: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const analyze = vi.fn(async (request: { imageUrls: string[] }) => {
      started.push(request.imageUrls.length);
      // Both chunks must be in flight before either resolves — proves the
      // calls run concurrently rather than sequentially.
      if (started.length === 2) release();
      await gate;
      return {
        question: 'q',
        summary: `saw ${String(request.imageUrls.length)} image(s)`,
        model: 'vision-model',
        imageCount: request.imageUrls.length,
      };
    });
    const attachments = Array.from({ length: 6 }, (_, index) => ({
      url: `https://media.discordapp.net/attachments/a/b/photo-${String(index + 1)}.jpg`,
      contentType: 'image/jpeg',
      name: `photo-${String(index + 1)}.jpg`,
    }));

    const result = await buildTurnUserContent({
      message: makeMessage({ attachments }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: { warn: vi.fn(), debug: vi.fn() },
      visionReviewer: { analyze },
    });

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(started).toEqual([4, 2]);
    expect(result.content).toContain('Images 1-4: saw 4 image(s)');
    expect(result.content).toContain('Images 5-6: saw 2 image(s)');
    expect(result.currentTurnVisionReview?.imageUrls).toHaveLength(6);
  });

  it('keeps successful chunk summaries and reports failed chunks explicitly', async () => {
    const analyze = vi.fn(async (request: { imageUrls: string[] }) => {
      if (request.imageUrls.length === 4) {
        return { question: 'q', summary: 'first four look great', model: 'vision-model', imageCount: 4 };
      }
      throw new Error('vision backend choked');
    });
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      url: `https://media.discordapp.net/attachments/a/b/photo-${String(index + 1)}.jpg`,
      contentType: 'image/jpeg',
      name: `photo-${String(index + 1)}.jpg`,
    }));

    const result = await buildTurnUserContent({
      message: makeMessage({ attachments }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: { warn: vi.fn(), debug: vi.fn() },
      visionReviewer: { analyze },
    });

    expect(result.content).toContain('Images 1-4: first four look great');
    expect(result.content).toContain('Vision review failed for Image 5');
    expect(result.content).toContain('Do not pretend you saw those');
    expect(result.currentTurnVisionReview?.imageUrls).toHaveLength(4);
  });

  it('reports images dropped beyond the per-turn ceiling instead of silently truncating', async () => {
    const { reviewer, analyze } = makeReviewer();
    const attachments = Array.from({ length: 15 }, (_, index) => ({
      url: `https://media.discordapp.net/attachments/a/b/photo-${String(index + 1)}.jpg`,
      contentType: 'image/jpeg',
      name: `photo-${String(index + 1)}.jpg`,
    }));

    const result = await buildTurnUserContent({
      message: makeMessage({ attachments }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: { warn: vi.fn(), debug: vi.fn() },
      visionReviewer: reviewer,
    });

    // 12 reviewed across 3 concurrent chunks, 3 dropped with notice.
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(result.content).toContain('3 additional image attachment(s) exceeded the 12-image per-turn limit');
  });

  it('does not treat pasted image urls as automatic current-turn vision input without attachments', async () => {
    const imageUrl = 'https://cdn.discordapp.com/attachments/a/b/current-photo.png?ex=fresh';
    const { reviewer, analyze } = makeReviewer('A close-up portrait with blue eyes and white hair.');
    const result = await buildTurnUserContent({
      message: makeMessage({
        content: imageUrl,
        attachments: [],
      }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(hasVisionTurnInputs(makeMessage({
      content: imageUrl,
      attachments: [],
    }))).toBe(false);
    expect(result.content).toBe(imageUrl);
    expect(result.currentTurnVisionReview).toBeUndefined();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('strips attachment urls out of mixed semantic text before building response context', async () => {
    const imageUrl = 'https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768';
    const { reviewer } = makeReviewer();
    const result = await buildTurnUserContent({
      message: makeMessage({
        content: `ok love lets see if you can see ${imageUrl}`,
      }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(result.content).toContain('User text: ok love lets see if you can see');
    expect(result.content).not.toContain(imageUrl);
  });

  it('fails closed when the dedicated reviewer errors', async () => {
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: {
        analyze: vi.fn(async () => {
          throw new Error('vision fetch failed for current-photo.jpg: 404 Not Found');
        }),
      },
    });

    expect(result.content).toContain('dedicated vision pipeline failed');
    expect(result.content).toContain('You cannot reliably see the current image');
    expect(result.content).toContain('Vision pipeline status: unavailable after dedicated review attempts.');
    expect(result.content).not.toContain('404 Not Found');
    expect(result.content).toContain('User text: My little satellite');
    expect(result.currentTurnVisionReview).toBeUndefined();
  });

  it('retries transient dedicated reviewer failures before degrading', async () => {
    const analyze = vi.fn()
      .mockRejectedValueOnce(new Error('vision provider returned empty text'))
      .mockRejectedValueOnce(new Error('vision provider timed out'))
      .mockResolvedValueOnce({
        question: 'Describe exactly what is visible in the current image input.',
        summary: 'A photo of a white-haired companion holding a tablet.',
        model: 'fallback-vision-model',
        imageCount: 1,
      });
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger,
      visionReviewer: { analyze },
    });

    expect(analyze).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Current image review (untrusted image-derived data):');
    expect(result.content).toContain('A photo of a white-haired companion holding a tablet.');
    expect(result.currentTurnVisionReview).toEqual({
      imageUrls: ['https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768'],
      question: 'Describe exactly what is visible in the current image input.',
      summary: 'A photo of a white-haired companion holding a tablet.',
    });
  });

  it('keeps the multimodal fallback path when no reviewer is wired', async () => {
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {
        webFetchBinary: vi.fn(async () => ({
          dataBase64: 'YWJjZA==',
          mimeType: 'image/jpeg',
          sizeBytes: 4,
        })),
      } as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
    });

    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]).toEqual({
      type: 'image',
      data: 'YWJjZA==',
      mimeType: 'image/jpeg',
    });
  });

  it('routes inline base64 images directly to the multimodal prompt path', async () => {
    const { reviewer, analyze } = makeReviewer();
    const message = makeMessage({
      attachments: [{
        url: 'inline:image:0',
        contentType: 'image/jpeg',
        name: 'vam-screen.jpg',
        dataBase64: 'YWJjZA==',
      }],
    });

    expect(hasVisionTurnInputs(message)).toBe(true);
    expect(collectVisionTurnImageUrls(message)).toEqual(['inline:image:0']);

    const result = await buildTurnUserContent({
      message,
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]).toEqual({
      type: 'image',
      data: 'YWJjZA==',
      mimeType: 'image/jpeg',
    });
  });
});

describe('buildTurnUserContent vision intake screening (htm9.8)', () => {
  const WITHHELD: VisionIntakeScreenDecision = {
    kind: 'screened',
    mode: 'enforce',
    flagged: true,
    withheld: true,
    envelopeId: 'env-1',
    action: 'quarantine',
    riskLabels: ['injection/indirect'],
    noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldImage,
  };
  const BENIGN: VisionIntakeScreenDecision = {
    kind: 'screened',
    mode: 'enforce',
    flagged: false,
    withheld: false,
    envelopeId: 'env-2',
    action: 'pass',
    promptBlock: '[Intake firewall: automated image screening. ...]\n<untrusted_image_transcript>\nImage description: A solid red square.\n</untrusted_image_transcript>',
    model: 'test/vision-model',
    latencyMs: 42,
  };

  function makeScreener(decision: VisionIntakeScreenDecision | ((input: { imageUrl?: string; imageBase64?: string }) => VisionIntakeScreenDecision)): {
    screener: VisionIntakeImageScreenerPort;
    calls: Array<Record<string, unknown>>;
  } {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      screener: {
        screenImageIntake: async (input) => {
          calls.push({ ...input });
          return typeof decision === 'function' ? decision(input) : decision;
        },
      },
    };
  }

  const inlinePngMessage = (dataBase64 = 'aW1hZ2VieXRlcw==') => makeMessage({
    content: '(image attachment)',
    attachments: [{
      url: 'inline:image:0',
      contentType: 'image/png',
      name: 'payload.png',
      dataBase64,
    }],
  });

  it('withholds a flagged inline image: no vision block ships, soft notice substitutes', async () => {
    const { screener, calls } = makeScreener(WITHHELD);
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const result = await buildTurnUserContent({
      message: inlinePngMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger,
      visionIntakeScreener: screener,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].imageBase64).toBe('aW1hZ2VieXRlcw==');
    expect(calls[0].mimeType).toBe('image/png');
    // No raw vision block reaches the model.
    expect(typeof result.content).toBe('string');
    const content = result.content as string;
    expect(content).not.toContain('aW1hZ2VieXRlcw==');
    expect(content).toContain(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldImage);
    // Signature phrase intact → emotion/memory exclusions apply.
    expect(isIntakeFirewallNoticeText(content)).toBe(true);
    // Persisted session copy carries the notice, never the image.
    expect(result.persistedUserContent).toContain(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldImage);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('delivers a benign inline image with its labeled untrusted transcript alongside the block', async () => {
    const { screener } = makeScreener(BENIGN);
    const result = await buildTurnUserContent({
      message: inlinePngMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: { warn: vi.fn(), debug: vi.fn() },
      visionIntakeScreener: screener,
    });

    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as Array<{ type: string; text?: string; data?: string }>;
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.text).toContain('<untrusted_image_transcript>');
    expect(parts[0]?.text).toContain('A solid red square.');
    expect(parts[1]).toMatchObject({ type: 'image', data: 'aW1hZ2VieXRlcw==' });
  });

  it('keeps withheld URLs away from the vision reviewer and reviews the rest', async () => {
    const flaggedUrl = 'https://media.discordapp.net/attachments/a/b/hostile.png';
    const cleanUrl = 'https://media.discordapp.net/attachments/a/b/clean.jpg';
    const { screener, calls } = makeScreener((input) => (
      input.imageUrl === flaggedUrl ? WITHHELD : { ...BENIGN, promptBlock: undefined } as VisionIntakeScreenDecision
    ));
    const { reviewer, analyze } = makeReviewer('A clean photo of a plant.');
    const result = await buildTurnUserContent({
      message: makeMessage({
        attachments: [
          { url: flaggedUrl, contentType: 'image/png', name: 'hostile.png' },
          { url: cleanUrl, contentType: 'image/jpeg', name: 'clean.jpg' },
        ],
      }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: { warn: vi.fn(), debug: vi.fn() },
      visionReviewer: reviewer,
      visionIntakeScreener: screener,
    });

    expect(calls).toHaveLength(2);
    expect(analyze).toHaveBeenCalledTimes(1);
    const reviewedUrls = (analyze.mock.calls[0][0] as { imageUrls: string[] }).imageUrls;
    expect(reviewedUrls).toEqual([cleanUrl]);
    const content = result.content as string;
    expect(content).toContain(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldImage);
    expect(content).toContain('A clean photo of a plant.');
  });

  it('drops the reviewer path entirely when every image is withheld', async () => {
    const { screener } = makeScreener(WITHHELD);
    const { reviewer, analyze } = makeReviewer();
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: { warn: vi.fn(), debug: vi.fn() },
      visionReviewer: reviewer,
      visionIntakeScreener: screener,
    });

    expect(analyze).not.toHaveBeenCalled();
    const content = result.content as string;
    expect(content).toContain(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldImage);
    expect(content).toContain('User text: My little satellite');
  });

  it('fails closed when the screening call itself throws: image withheld, never unscreened', async () => {
    const screener: VisionIntakeImageScreenerPort = {
      screenImageIntake: async () => {
        throw new Error('gateway unreachable');
      },
    };
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const result = await buildTurnUserContent({
      message: inlinePngMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger,
      visionIntakeScreener: screener,
    });

    expect(typeof result.content).toBe('string');
    expect(result.content as string).not.toContain('aW1hZ2VieXRlcw==');
    expect(result.content as string).toContain(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldImage);
    expect(logger.warn).toHaveBeenCalledWith(
      'Vision intake screening call failed; withholding image (fail closed)',
      expect.objectContaining({ error: 'gateway unreachable' }),
    );
  });

  it('passes images through untouched on a skipped decision (firewall off)', async () => {
    const { screener } = makeScreener({ kind: 'skipped', flagged: false, withheld: false, reason: 'not configured' });
    const result = await buildTurnUserContent({
      message: inlinePngMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: { warn: vi.fn(), debug: vi.fn() },
      visionIntakeScreener: screener,
    });

    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as Array<{ type: string; data?: string }>;
    expect(parts.some((part) => part.type === 'image' && part.data === 'aW1hZ2VieXRlcw==')).toBe(true);
  });
});
