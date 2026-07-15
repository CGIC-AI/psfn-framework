const IDENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/@[\p{L}\p{N}_.-]+/gu, '[person]'],
  [/\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/giu, '[contact]'],
  [/\b(?:my|your|our)\s+(?:partner|wife|husband|girlfriend|boyfriend|spouse|sister|brother|mother|father|boss|employee|therapist|doctor)\b/giu, '[relationship]'],
  [/\b(?:at|for|from|with)\s+[A-Z][\p{L}\p{N}&.-]*(?:\s+[A-Z][\p{L}\p{N}&.-]*){0,3}\b/gu, '[affiliation]'],
  [/\b(?:you(?:'re| are)?|we(?:'re| are)?)\s+(?:always\s+)?on\s+(?:my|our)\s+side\b/giu, '[reassurance cue]'],
  [/\b(?:promise|tell)\s+me\s+(?:that\s+)?you(?:'ll| will| still)?\b/giu, '[reassurance cue]'],
];

/**
 * Deterministic pre-model blinding for the stable-reply estimator. It strips
 * direct identity, relationship, affiliation, and reassurance cues before
 * untrusted public text crosses the auditor boundary. This is a structural
 * privacy reduction, not a probabilistic classifier.
 */
export function blindPublicStimulus(input: string): string {
  let blinded = input.normalize('NFKC');
  for (const [pattern, replacement] of IDENTITY_PATTERNS) {
    blinded = blinded.replace(pattern, replacement);
  }
  return blinded.replace(/\s+/g, ' ').trim();
}
