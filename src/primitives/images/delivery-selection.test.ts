import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_IMAGE_ATTACHMENT_LIMIT,
  selectGeneratedImageAssetsForDelivery,
} from './delivery-selection.js';

function imageResult(toolName: string, fileName: string) {
  return {
    message: { toolName, toolCallId: `call-${fileName}` },
    result: {
      provider: 'fal' as const,
      mode: 'create' as const,
      fallbackUsed: false,
      images: [{
        url: `https://images.example.test/${fileName}`,
        fileName,
      }],
    },
  };
}

describe('selectGeneratedImageAssetsForDelivery', () => {
  it('falls back to the last successful result from each image tool when no fileName is referenced', () => {
    const imageResults = [
      imageResult('selfie_create', 'selfie-draft.png'),
      imageResult('generate_image', 'scene-draft.png'),
      imageResult('selfie_create', 'selfie-final.png'),
      imageResult('generate_image', 'scene-final.png'),
    ];

    const selected = selectGeneratedImageAssetsForDelivery({
      imageResults,
      turnMessages: [fromAny({
        role: 'assistant',
        content: [{ type: 'text', text: 'Here are the images I settled on.' }],
      })],
    });

    expect([...selected].map(asset => asset.fileName)).toEqual([
      'selfie-final.png',
      'scene-final.png',
    ]);
  });

  it('caps explicitly referenced generated image attachments per turn', () => {
    const imageResults = Array.from(
      { length: GENERATED_IMAGE_ATTACHMENT_LIMIT + 1 },
      (_, index) => imageResult('generate_image', `selection-${index + 1}.png`),
    );
    const reply = imageResults
      .map(entry => entry.result.images[0]!.fileName)
      .join(' ');

    const selected = selectGeneratedImageAssetsForDelivery({
      imageResults,
      turnMessages: [fromAny({
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
      })],
    });

    expect([...selected].map(asset => asset.fileName)).toEqual([
      'selection-1.png',
      'selection-2.png',
      'selection-3.png',
      'selection-4.png',
    ]);
  });

  it('uses only the latest asset when repeated provider results reuse a fileName', () => {
    const first = imageResult('selfie_create', 'output.png');
    const latest = imageResult('selfie_create', 'output.png');

    const selected = selectGeneratedImageAssetsForDelivery({
      imageResults: [first, latest],
      turnMessages: [fromAny({
        role: 'assistant',
        content: [{ type: 'text', text: 'I picked `output.png`.' }],
      })],
    });

    expect([...selected]).toEqual([latest.result.images[0]]);
  });

  it('uses the supplied generation order for fallback selection', () => {
    const olderRecovered = imageResult('selfie_create', 'older-draft.png');
    const newerTranscript = imageResult('selfie_create', 'newer-final.png');

    const selected = selectGeneratedImageAssetsForDelivery({
      imageResults: [olderRecovered, newerTranscript],
      turnMessages: [fromAny({
          role: 'assistant',
          content: [{ type: 'text', text: 'This one feels right.' }],
      })],
    });

    expect([...selected]).toEqual([newerTranscript.result.images[0]]);
  });
});
