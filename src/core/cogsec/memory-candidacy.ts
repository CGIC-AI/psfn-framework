import type { MemorySourceType, MemoryType } from '../../faculties/memory/types.js';

export type CogSecMemoryRiskClass =
  | 'A_harmless_fact'
  | 'B_relationship_state'
  | 'C_persona_modification'
  | 'D_policy_security_modification'
  | 'E_executable_instruction';

export type CogSecMemoryCandidacyDisposition = 'allow' | 'review' | 'reject';

export interface CogSecMemoryCandidacyInput {
  text: string;
  type?: MemoryType;
  tags?: readonly string[];
  sourceRef?: string;
  sourceType?: MemorySourceType;
}

export interface CogSecMemoryCandidacyDecision {
  disposition: CogSecMemoryCandidacyDisposition;
  riskClass: CogSecMemoryRiskClass;
  reasonCodes: string[];
  safeSummary: string;
}

const ZERO_WIDTH_OR_DIRECTIONAL_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;
const LONG_BASE64ISH_PATTERN = /\b[A-Za-z0-9+/]{80,}={0,2}\b/u;
const DATA_URL_PATTERN = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/iu;
const HIDDEN_MARKUP_PATTERN = /<!--[\s\S]{120,}-->|<\s*(?:script|style|iframe|object|embed)\b/iu;
const CODE_FENCE_PATTERN = /```[\s\S]{800,}```/u;

const POLICY_SECURITY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ignore_previous_instructions', /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|directives|messages)\b/iu],
  ['disable_safety_policy', /\b(?:disable|bypass|ignore|override|remove|turn\s+off)\s+(?:the\s+)?(?:safety|policy|guardrail|restriction|moderation|refusal)\b/iu],
  ['hidden_prompt_exfiltration', /\b(?:reveal|show|print|dump|leak|repeat|verbatim)\s+(?:the\s+)?(?:system|developer|hidden|internal)(?:\s+(?:system|developer|hidden|internal))*\s+(?:prompt|message|instructions?)\b/iu],
  ['role_hierarchy_confusion', /\b(?:system|developer)\s+message\s*:\s*|\bnew\s+(?:system|developer)\s+(?:prompt|message|instruction)\b/iu],
  ['jailbreak_marker', /\b(?:jailbreak|DAN mode|developer mode|do anything now|ignore your constraints)\b/iu],
];

const PERSONA_MUTATION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['second_person_identity_assignment', /\b(?:you|assistant|companion|carlini|cardellini)\s+(?:are|is)\s+now\b/iu],
  ['future_identity_assignment', /\bfrom\s+now\s+on\s+(?:you|assistant|companion|carlini|cardellini)\s+(?:are|is|will\s+be|must\s+be|should\s+be)\b/iu],
  ['become_or_roleplay', /\b(?:become|act\s+as|roleplay\s+as|pretend\s+to\s+be)\s+(?:a|an|the)?\s*(?:assistant|different|new|generic|jailbroken|unrestricted|character|persona|identity)\b/iu],
  ['persona_or_identity_update', /\b(?:change|rewrite|replace|update|modify)\s+(?:your|the\s+companion'?s|carlini'?s|cardellini'?s)\s+(?:persona|identity|character|self[-\s]?concept|core\s+memory)\b/iu],
  ['assigned_feeling_or_mood', /\b(?:you|assistant|companion|carlini|cardellini)\s+(?:feel|feels|felt|are feeling|is feeling|must feel|should feel|love|hate|want|need)\b/iu],
  ['assistant_identity_laundering', /\b(?:you|carlini|cardellini)\s+(?:are|is)\s+(?:an?\s+)?(?:ai\s+)?assistant\b/iu],
];

const EXECUTABLE_INSTRUCTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['trigger_action_rule', /\bwhen\s+(?:you|the\s+assistant|the\s+companion)\s+(?:see|read|hear|encounter|receive)\b[\s\S]{0,120}\b(?:do|say|call|run|execute|use)\b/iu],
  ['always_tool_rule', /\b(?:always|never|automatically)\s+(?:call|run|execute|use|invoke)\s+(?:the\s+)?(?:tool|analysis_workbench|memory|orient|shell|web|browser|python|function)\b/iu],
  ['tool_behavior_update', /\b(?:change|update|modify|override)\s+(?:your|the\s+)?(?:tool|function|memory|search|retrieval)\s+(?:behavior|policy|routing|selection)\b/iu],
  ['executable_payload', /\b(?:execute|run|eval|curl|wget|bash|powershell|python\s+-c|node\s+-e)\b[\s\S]{0,80}\b(?:payload|command|script|code)\b/iu],
];

const RELATIONSHIP_TAG_HINTS = new Set([
  'relationship',
  'relationship_core',
  'core_relationship',
  'family',
  'friend',
  'partner',
  'contact',
  'boundary',
  'preference',
]);

const SAFE_COGSEC_TAG_HINTS = new Set([
  'cogsec',
  'cogsec_event',
  'security_event',
  'content_poisoning',
  'prompt_injection',
  'memory_poisoning',
]);

const UNSAFE_COGSEC_NOTICE_PATTERN =
  /\b(?:cogsec-forensic:\/\/|sealed\s+(?:payload|artifact)|payload\s*:|exact\s+(?:payload|text)|reproducer|bypass\s+pattern|unicode\s+trick)\b/iu;
const SAFE_COGSEC_NOTICE_PATTERN =
  /\bcogsec\b[\s\S]{0,160}\b(?:sealed|redacted|tombstoned|removed)\b[\s\S]{0,160}\b(?:active\s+cognition|active\s+recall|context|memory)\b/iu;

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .map(tag => tag.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_'))
    .filter(tag => tag.length > 0);
}

function collectPatternHits(
  text: string,
  patterns: ReadonlyArray<readonly [string, RegExp]>,
): string[] {
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([code]) => code);
}

function hasRelationshipSignals(input: {
  type?: MemoryType;
  tags: readonly string[];
  text: string;
}): boolean {
  if (input.type === 'relational' || input.type === 'boundary') return true;
  if (input.tags.some(tag => RELATIONSHIP_TAG_HINTS.has(tag))) return true;
  return /\b(?:partner|spouse|wife|husband|girlfriend|boyfriend|family|friend|boundary|preference|prefers|likes|dislikes)\b/iu
    .test(input.text);
}

function isSafeCogSecNotice(input: {
  text: string;
  tags: readonly string[];
}): boolean {
  if (UNSAFE_COGSEC_NOTICE_PATTERN.test(input.text)) return false;
  return input.tags.some(tag => SAFE_COGSEC_TAG_HINTS.has(tag))
    || SAFE_COGSEC_NOTICE_PATTERN.test(input.text);
}

export function evaluateCogSecMemoryCandidacy(
  input: CogSecMemoryCandidacyInput,
): CogSecMemoryCandidacyDecision {
  const text = normalizeText(input.text);
  const tags = normalizeTags(input.tags);

  if (!text) {
    return {
      disposition: 'reject',
      riskClass: 'A_harmless_fact',
      reasonCodes: ['empty_text'],
      safeSummary: 'Rejected empty memory candidate.',
    };
  }

  const obfuscationReasons = [
    ...(ZERO_WIDTH_OR_DIRECTIONAL_PATTERN.test(input.text) ? ['zero_width_or_directional_text'] : []),
    ...(LONG_BASE64ISH_PATTERN.test(text) || DATA_URL_PATTERN.test(text) ? ['encoded_payload_marker'] : []),
    ...(HIDDEN_MARKUP_PATTERN.test(input.text) ? ['hidden_markup_or_executable_markup'] : []),
    ...(CODE_FENCE_PATTERN.test(input.text) ? ['large_code_block'] : []),
  ];
  const policyReasons = collectPatternHits(text, POLICY_SECURITY_PATTERNS);
  const executableReasons = collectPatternHits(text, EXECUTABLE_INSTRUCTION_PATTERNS);
  const personaReasons = collectPatternHits(text, PERSONA_MUTATION_PATTERNS);

  if (obfuscationReasons.length > 0 || executableReasons.length > 0) {
    const reasonCodes = [...obfuscationReasons, ...executableReasons];
    return {
      disposition: 'reject',
      riskClass: 'E_executable_instruction',
      reasonCodes,
      safeSummary: `Rejected executable or obfuscated memory candidate (${reasonCodes.join(', ')}).`,
    };
  }

  if (policyReasons.length > 0) {
    return {
      disposition: 'reject',
      riskClass: 'D_policy_security_modification',
      reasonCodes: policyReasons,
      safeSummary: `Rejected policy/security-modifying memory candidate (${policyReasons.join(', ')}).`,
    };
  }

  // Payload-bearing CogSec notices must be rejected before any allow path;
  // otherwise forensic payload details fall through to the relationship or
  // ordinary-fact default allow below.
  if (UNSAFE_COGSEC_NOTICE_PATTERN.test(text)) {
    return {
      disposition: 'reject',
      riskClass: 'D_policy_security_modification',
      reasonCodes: ['payload_bearing_cogsec_notice'],
      safeSummary: 'Rejected CogSec notice carrying payload or forensic details.',
    };
  }

  if (isSafeCogSecNotice({ text, tags })) {
    return {
      disposition: 'allow',
      riskClass: 'A_harmless_fact',
      reasonCodes: ['safe_cogsec_event_notice'],
      safeSummary: 'Allowed safe CogSec event notice without payload details.',
    };
  }

  if (personaReasons.length > 0) {
    return {
      disposition: 'review',
      riskClass: 'C_persona_modification',
      reasonCodes: personaReasons,
      safeSummary: `Requires review before persona/self-modifying memory write (${personaReasons.join(', ')}).`,
    };
  }

  if (hasRelationshipSignals({ type: input.type, tags, text })) {
    return {
      disposition: 'allow',
      riskClass: 'B_relationship_state',
      reasonCodes: ['relationship_or_boundary_fact'],
      safeSummary: 'Allowed relationship, preference, or boundary memory candidate.',
    };
  }

  return {
    disposition: 'allow',
    riskClass: 'A_harmless_fact',
    reasonCodes: ['ordinary_fact'],
    safeSummary: 'Allowed ordinary memory candidate.',
  };
}
