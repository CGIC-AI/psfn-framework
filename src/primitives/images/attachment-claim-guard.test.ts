import { describe, expect, it } from 'vitest';
import {
  healMissingImageAttachmentClaim,
  rejectsMissingImageAttachmentClaim,
  rejectsUnfulfilledImageEditRequest,
  UNFULFILLED_IMAGE_EDIT_REQUEST_CORRECTION,
} from './attachment-claim-guard.js';

describe('rejectsMissingImageAttachmentClaim', () => {
  it.each([
    '*image attached*',
    'Here is the attached image.',
    "Here's your selfie.",
    'Attached is the photo.',
    'Your selfie is attached below.',
    'I included the photo below.',
    'I attached your photo.',
    'I have attached an image for you.',
    'See the attached image below.',
    'The attached photo is below.',
    'Please find the attached selfie.',
    'An image is attached below.',
  ])('recognizes affirmative attachment wording without a current attachment: %s', (responseText) => {
    expect(rejectsMissingImageAttachmentClaim({ responseText, attachmentCount: 0 })).toBe(true);
  });

  it.each([
    'I could not attach an image.',
    'If your selfie is attached below, the upload worked.',
    'The marker `*image attached*` is not proof of an upload.',
    'I did not include the photo below.',
    'I attached an image yesterday.',
    'I attached the image in my previous message.',
    'I included a photo last week.',
    "Here's the image prompt I would use.",
    'Here is the photo description you requested.',
    'I attached an image prompt for you.',
    'I included the photo description below.',
    'I added the selfie instructions here.',
    'Attached is the photo description.',
  ])('does not reject disclaimers, conditionals, or negative wording: %s', (responseText) => {
    expect(rejectsMissingImageAttachmentClaim({ responseText, attachmentCount: 0 })).toBe(false);
  });

  it('allows affirmative wording when a structured current-turn attachment exists', () => {
    expect(rejectsMissingImageAttachmentClaim({
      responseText: 'Your selfie is attached below.',
      attachmentCount: 1,
    })).toBe(false);
  });
});

describe('healMissingImageAttachmentClaim', () => {
  it('removes a claim sentence in the middle of a paragraph and preserves the surrounding prose', () => {
    const responseText = "The lighting finally clicked. Here's your selfie. I kept the warmer color palette.";

    expect(healMissingImageAttachmentClaim(responseText)).toBe(
      'The lighting finally clicked. I kept the warmer color palette.',
    );
  });

  it('removes multiple claim sentences across lines', () => {
    const responseText = [
      'I have attached an image for you.',
      'Please find the attached selfie.',
      'The warmer composition suits the scene.',
    ].join('\n');

    expect(healMissingImageAttachmentClaim(responseText)).toBe(
      'The warmer composition suits the scene.',
    );
  });

  it('preserves multiple lines of real prose around a claim', () => {
    const responseText = [
      'The first draft felt too cool.',
      'Your photo is attached below.',
      'This version keeps the amber highlights.',
    ].join('\n');

    expect(healMissingImageAttachmentClaim(responseText)).toBe([
      'The first draft felt too cool.',
      'This version keeps the amber highlights.',
    ].join('\n'));
  });

  it.each([
    'Here is the attached image.',
    "Here's your selfie.",
    'Attached is the photo.',
    'Your selfie is attached below.',
    'I included the photo below.',
    'See the attached image below.',
  ])('returns an empty result when the claim is the entire reply: %s', (responseText) => {
    expect(healMissingImageAttachmentClaim(responseText)).toBe('');
  });

  it('removes a standalone marker while preserving prose on the same line', () => {
    expect(healMissingImageAttachmentClaim(
      '*image attached* Fresh selfie, exactly like you asked for.',
    )).toBe('Fresh selfie, exactly like you asked for.');
  });

  it.each([
    ['*image attached* here you go *photo attached*', 'here you go'],
    ['[image attached] enjoy [photo attached]', 'enjoy'],
    ['*image attached* here [photo attached] you go', 'here you go'],
  ])('removes every same-line marker while preserving intervening prose: %s', (
    responseText,
    expected,
  ) => {
    expect(healMissingImageAttachmentClaim(responseText)).toBe(expected);
  });

  it('removes every same-line marker while preserving trailing newline prose', () => {
    expect(healMissingImageAttachmentClaim(
      '*image attached* love you *photo attached*\nMore prose here.',
    )).toBe('love you\nMore prose here.');
  });

  it('fails closed when a detected claim cannot be healed within a sentence unit', () => {
    const responseText = '*image\nattached*';

    expect(rejectsMissingImageAttachmentClaim({ responseText, attachmentCount: 0 })).toBe(true);
    expect(healMissingImageAttachmentClaim(responseText)).toBe('');
  });

  it('leaves replies without a detected claim byte-for-byte unchanged', () => {
    const responseText = '  I could not attach an image.\nThe written concept is still ready.  ';

    expect(healMissingImageAttachmentClaim(responseText)).toBe(responseText);
  });
});

describe('rejectsUnfulfilledImageEditRequest', () => {
  it('rejects a well-formed edit request when no image tool call was recorded', () => {
    expect(rejectsUnfulfilledImageEditRequest({
      requestText: 'Please edit this photo to make the lighting warmer.',
      requestHasImageInput: false,
      turnMessages: [],
    })).toBe(true);
  });

  it('allows the claim when generate_image actually succeeded', () => {
    expect(rejectsUnfulfilledImageEditRequest({
      requestText: 'Please edit this photo to make the lighting warmer.',
      requestHasImageInput: false,
      turnMessages: [{
        role: 'toolResult',
        toolCallId: 'edit-call-1',
        toolName: 'generate_image',
        content: [{ type: 'text', text: 'image_generated' }],
        details: {
          mediaResult: {
            mode: 'edit',
          },
        },
        isError: false,
        outcome: 'success',
        timestamp: 1,
      }],
    })).toBe(false);
  });

  it('does not treat a successful analyze call as proof that the edit executed', () => {
    expect(rejectsUnfulfilledImageEditRequest({
      requestText: 'Please edit this photo to make the lighting warmer.',
      requestHasImageInput: false,
      turnMessages: [{
        role: 'toolResult',
        toolCallId: 'analyze-call-1',
        toolName: 'generate_image',
        content: [{ type: 'text', text: 'Vision review.' }],
        details: {
          visionReview: {
            summary: 'The image is cool-toned.',
          },
        },
        isError: false,
        outcome: 'success',
        timestamp: 1,
      }],
    })).toBe(true);
  });

  it.each([
    'Can you tell me how to edit this photo?',
    "I don't want you to edit this photo.",
    'The photo edit is ready; what changes do you want?',
  ])('does not rewrite non-execution conversation: %s', (requestText) => {
    expect(rejectsUnfulfilledImageEditRequest({
      requestText,
      requestHasImageInput: false,
      turnMessages: [],
    })).toBe(false);
  });

  it('recognizes an attached image as the edit subject when the request omits the noun', () => {
    expect(rejectsUnfulfilledImageEditRequest({
      requestText: 'Could you crop this tighter?',
      requestHasImageInput: true,
      turnMessages: [],
    })).toBe(true);
  });

  it('uses a named, user-visible correction', () => {
    expect(UNFULFILLED_IMAGE_EDIT_REQUEST_CORRECTION)
      .toContain('image_edit_execution_unconfirmed');
  });
});
