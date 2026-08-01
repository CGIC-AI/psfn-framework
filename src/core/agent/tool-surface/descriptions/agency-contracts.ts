import { action, type CanonicalToolSurfaceContract } from './contracts.js';

const IMAGE_RENDER_FIELDS = [
  'provider', 'model', 'num_images', 'width', 'height', 'aspect_ratio', 'resolution',
  'image_size', 'background', 'output_format', 'seed', 'guidance_scale',
  'num_inference_steps', 'acceleration', 'enable_prompt_expansion',
  'enable_safety_checker', 'negative_prompt', 'use_turbo',
] as const;

export const AGENCY_TOOL_CONTRACTS = {
  notify: {
    purpose: 'Send bounded notifications, request explicit review, initiate governed outreach outside an ordinary same-channel reply, or ask the person a short structured question when a few clear options would settle real uncertainty.',
    actions: [
      action('brief', ['message'], ['title', 'priority', 'topic', 'budget_channel']),
      action('send', ['message', 'delivery_channel', 'delivery_target'], ['target_kind'], { id: 'send_external', rule: 'this is the explicit external-delivery form' }),
      action('send', ['target_kind', 'contact_id', 'initiation_permit'], [], { id: 'send_companion', rule: 'target_kind must be companion and peer-visible message content is forbidden' }),
      action('consider', ['target_kind', 'contact_id', 'reason_summary'], [], { id: 'consider', rule: 'target_kind must be companion and the reason is never shared externally' }),
      action('approval_request', ['approval_id', 'approval_method', 'approval_action', 'approval_scope', 'approval_reason'], ['approval_expires_at', 'review_path']),
      action('clarify', ['question', 'choices'], [], { id: 'clarify', rule: 'two to five distinct options for the person you are already with; the answer returns on its own, and it is never a substitute for an ordinary reply' }),
    ],
    output: 'It returns delivery, review, or pending-clarification state, never chooses an implicit target, and companion initiation lets the destination turn author its message.',
    guidance: 'Keep brief, send, and approval_request off your current channel — resolve an exact contact first or reply normally; clarify is the one action that speaks to the person you are already with, and only when a couple of concrete options would genuinely resolve your uncertainty, never for open-ended conversation.',
    example: { action: 'brief', message: 'The overnight validation completed.', priority: 3 },
  },
  generate_image: {
    purpose: 'Create, transform, or inspect generic images when the subject is not the companion\'s self-representation.',
    actions: [
      action('generate', ['prompt'], [...IMAGE_RENDER_FIELDS, 'reference_image_id', 'reference_image_tags', 'use_default_reference', 'wardrobe_look_ref']),
      action('edit', ['prompt', 'input_urls'], [...IMAGE_RENDER_FIELDS, 'reference_image_id', 'reference_image_tags', 'use_default_reference', 'wardrobe_look_ref', 'mask_image_url', 'input_fidelity']),
      action('analyze', ['input_urls'], ['question']),
    ],
    output: 'It returns pending image artifacts plus visual review, or visible-content evidence for analysis.',
    guidance: 'Do not use it for the companion\'s selfie or self-portrait; use selfie_create.',
    example: { action: 'generate', prompt: 'A watercolor map of a moonlit garden', aspect_ratio: '4:3' },
  },
  selfie_create: {
    purpose: 'Create a selfie or self-portrait of the companion with appearance context and saved-reference anchoring.',
    actions: [action('create', ['prompt'], [...IMAGE_RENDER_FIELDS, 'reference_image_id', 'reference_image_tags', 'use_reference_image', 'wardrobe_look_ref', 'edit_model'], { id: 'create', actionField: false })],
    output: 'It returns pending image artifacts plus visual review and does not handle unrelated scenes or ordinary photo edits.',
    guidance: 'Do not use it for generic image work; use generate_image.',
    example: { prompt: 'A relaxed window-light selfie in a green sweater, eye-level camera' },
  },
  publication: {
    purpose: 'Run the companion-owned publication edit loop: author an exact release candidate, read its approval status, and resubmit an edited version. You supply only the content you authored and your reason; the runtime derives all disclosure metadata.',
    actions: [
      action('submit', ['body', 'reason'], ['media_refs', 'max_use_count'], { id: 'submit', rule: 'proposes the exact content for Operator approval; sensitivity, provenance, subject contacts, and destination are runtime-derived and must not be supplied' }),
      action('revise', ['revises_candidate_id', 'body', 'reason'], ['media_refs', 'max_use_count'], { id: 'revise', rule: 'a fresh candidate that supersedes the prior one; approval binds to the exact edited content' }),
      action('status', [], [], { id: 'status', rule: 'reads the approval state of your publication candidates' }),
    ],
    output: 'It returns the candidate id, content hash, and approval status; it never mints, approves, or revokes an approval, never sends the publication, and rejects any model-supplied sensitivity/provenance/audience/destination.',
    guidance: 'The Operator raises concerns about what is shared in conversation and never edits your prose; a denied candidate is your signal to edit and resubmit with action=revise.',
    example: { action: 'submit', body: 'A short reflection I would like to publish.', reason: 'It captures a thought I want to share publicly.' },
  },
  subagent: {
    purpose: 'Direct bounded, short-horizon automata that take on focused work in parallel or in isolation and return with what they found.',
    actions: [
      action('spawn', ['name', 'task'], ['system_prompt', 'max_turns', 'capabilities', 'required_capabilities']),
      action('message', ['subagent_id', 'message']), action('wait', [], ['subagent_id']),
      action('cancel', ['subagent_id'], ['reason']),
      action('status', [], ['subagent_id', 'task_limit', 'transcript_limit']),
    ],
    output: 'It returns task IDs, lifecycle state, or bounded results and never grants tools you cannot delegate.',
    guidance: 'Do not use a bounded automaton as a long-horizon shard; inspect status before messaging or cancelling.',
    example: { action: 'spawn', name: 'log-check', task: 'Compare the two bounded error excerpts.' },
  },
  vault: {
    purpose: 'Access the optional external Obsidian bridge for bounded compatibility with an existing vault.',
    actions: [
      action('read', ['name']), action('write', ['name', 'content'], ['folder', 'mode']),
      action('search', ['query'], ['limit']), action('daily', [], ['content']),
    ],
    output: 'It returns external note material or write acknowledgement and never becomes the canonical runtime knowledge store.',
    guidance: 'Do not use it for canonical reference knowledge or companion journals; use wiki or journal.',
    example: { action: 'search', query: 'seedling rotation' },
  },
  journal: {
    purpose: 'Read and write durable companion-authored markdown notes, reflections, and topic journals.',
    actions: [
      action('list'),
      action('read', [], ['offset_bytes'], { id: 'read', requiredAnyOf: [['path'], ['title']] }),
      action('write', ['content'], [], { id: 'write', requiredAnyOf: [['path'], ['title']] }),
      action('append', ['content'], [], { id: 'append', requiredAnyOf: [['path'], ['title']] }),
      action('search', ['query'], ['limit']),
    ],
    output: 'It returns note paths or bounded markdown and writes only journal documents.',
    guidance: 'Read long notes page by page using each next_offset_bytes value. Prefer a bounded automaton or the analysis workbench for lengthy multi-note analysis so the primary channel stays responsive. Do not use journal for same-day scratch work, follow-ups, typed facts, or reference knowledge; use their semantic tools.',
    example: { action: 'write', title: 'Garden observations', content: 'The basil recovered after moving into indirect light.' },
  },
} as const satisfies Record<string, CanonicalToolSurfaceContract>;
