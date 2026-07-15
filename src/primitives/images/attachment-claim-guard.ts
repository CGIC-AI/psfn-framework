const IMAGE_ATTACHMENT_CLAIM_PATTERNS = [
  /(?:^|\n)\s*(?:\*{1,3}|_{1,3})\s*(?:image|photo|selfie)\s+(?:is\s+)?attached\s*(?:\*{1,3}|_{1,3})(?=\s|$)/iu,
  /(?:^|\n)\s*\[(?:image|photo|selfie)\s+(?:is\s+)?attached\](?=\s|$)/iu,
  /(?:^|[.!?]\s+)\s*here(?:'s| is)\s+(?:(?:(?:the|your|my|an?)\s+)?attached\s+(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)|(?:(?:the|your|my|an?)\s+)?(?:image|photo|selfie)(?=\s*(?:[.!?]|$)|\s+(?:below|here|for you)\b))/iu,
  /(?:^|[.!?]\s+)\s*attached\s+is\s+(?:(?:the|your|my|an?)\s+)?(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)/iu,
  /(?:^|[.!?]\s+)\s*(?:your|the|my|an?)\s+(?:image|photo|selfie)\s+is\s+attached(?:\s+(?:below|here))?\b/iu,
  /(?:^|[.!?]\s+)\s*(?:please\s+)?(?:see|find|view|open)\s+(?:(?:the|your|my|an?)\s+)?attached\s+(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)/iu,
  /(?:^|[.!?]\s+)\s*(?:(?:the|your|my|an?)\s+)?attached\s+(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text)\b)(?:\s+is)?\s+(?:below|here)\b/iu,
  /(?:^|[.!?]\s+)\s*i(?:'ve| have)?\s+(?:attached|included|added)\s+(?:(?:an?|the|your|my)\s+)?(?:image|photo|selfie)(?!\s+(?:prompt|description|instructions?|caption|concept|idea|brief|analysis|text|yesterday|earlier|last\s+(?:night|week|month|year)|in\s+(?:my|the)\s+(?:previous|prior|last)\s+message))(?:\s+(?:below|here|with this message))?\b/iu,
];

export const MISSING_IMAGE_ATTACHMENT_CORRECTION =
  'I could not attach an image because no image tool completed successfully this turn. '
  + 'I need to call selfie_create or generate_image before saying an image is attached.';

export function rejectsMissingImageAttachmentClaim(input: {
  responseText: string;
  attachmentCount: number;
}): boolean {
  if (input.attachmentCount > 0) return false;
  return IMAGE_ATTACHMENT_CLAIM_PATTERNS.some(pattern => pattern.test(input.responseText));
}
