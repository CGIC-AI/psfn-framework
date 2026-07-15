import { describe, expect, it } from 'vitest';
import { rejectsMissingImageAttachmentClaim } from './attachment-claim-guard.js';

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
