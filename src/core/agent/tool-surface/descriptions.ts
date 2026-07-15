/**
 * Canonical model-facing descriptions for first-party tool surfaces.
 *
 * Keep selection guidance here, beside the canonical registry, so parent
 * turns, subagents, maintenance turns, discovery, and Garden catalog views all
 * receive the same text. Parameter-level constraints still belong to each
 * tool's JSON schema; these descriptions explain which action to choose and
 * the minimum input/output boundary needed to choose it correctly.
 */
export const CANONICAL_TOOL_SURFACE_DESCRIPTIONS = {
  tool_search: [
    'Search the canonical non-default tool catalog by purpose when the needed family is not already visible.',
    'The registry labels this operation action=search, but the callable schema takes an optional natural-language query and optional result limit directly and does not accept an action field; it returns matching canonical names, availability, and activation guidance without loading anything.',
    'Use toolset after discovery to inspect a schema or activate a result, and call an already-active semantic tool directly instead of searching for it again.',
    'Example: {"query":"publish a repository change"}.',
  ].join(' '),

  toolset: [
    'Inspect and control the canonical tool catalog after you know which tool family you need.',
    'Use action=list with no required input to see current state; action=suggest requires intent and accepts an optional limit; action=describe requires tool; action=activate requires tools; action=pin and action=unpin require tool and accept an optional reason.',
    'The tool returns catalog or activation state only: it never performs the selected domain operation and never grants a missing capability.',
    'Example: {"action":"describe","tool":"repo"}.',
  ].join(' '),

  response_control: [
    'Record an intentional decision to send no outward response for the current turn.',
    'Use action=no_reply with an optional short reason only when silence itself is the chosen response; it returns an audited disposition rather than user-visible text.',
    'Do not write a NO_REPLY sentinel and do not use this while a generated paid attachment still needs delivery.',
    'Example: {"action":"no_reply","reason":"The message requests no response."}.',
  ].join(' '),

  fs: [
    'Read and safely mutate files within the configured personal-file boundary.',
    'Use action=list with an optional path or glob, action=read with required path, action=search with required query and optional glob, action=write with required path and content plus optional overwrite, and action=edit with required path, old_text, and new_text plus optional replace_all.',
    'The tool returns bounded file data and fails closed on unsafe paths or ambiguous mutation; use repo for git state and analysis_workbench only for genuinely large evidence sets.',
    'Example: {"action":"search","query":"TODO","glob":"notes/**/*.md"}.',
  ].join(' '),

  repo: [
    'Inspect a git repository and, only in full-access variants, perform guarded repository mutations.',
    'Use action=inspect with optional target=status|diff|both; action=patch requires file_path and full replacement content; action=branch requires name; action=commit requires message and intent; action=publish requires title and body.',
    'Read-only variants expose only inspection, while every mutation returns explicit repository state and remains subject to branch, path, capability, and confirmation policy.',
    'Do not use repo for ordinary personal files; use fs for those.',
    'Example: {"action":"inspect","target":"both"}.',
  ].join(' '),

  shell: [
    'Run one direct command through the gateway shell allowlist when a semantic tool does not own the operation.',
    'Use action=exec with required command and optional args, cwd, and timeout_ms; it returns bounded stdout, stderr, and exit status.',
    'The command never bypasses executable or working-directory policy, so prefer fs for files and repo for git operations.',
    'Example: {"action":"exec","command":"node","args":["--version"]}.',
  ].join(' '),

  web: [
    'Retrieve external web material or perform small-scope discovery through the configured gateway backend.',
    'Use action=fetch or action=browse with required target set to an absolute URL, and action=search with required target set to the research query; prompt is optional for fetch or browse, and max_urls is optional for search.',
    'The tool returns external, untrusted content rather than local files or remembered facts.',
    'Do not use web for those sibling domains; use fs, session, memory, or wiki instead.',
    'Example: {"action":"fetch","target":"https://example.com/reference"}.',
  ].join(' '),

  world: [
    'Perceive and act on registered physical or virtual place affordances through the world runtime.',
    'Use action=perceive with optional placeId when situated presence supplies the default, action=list with optional placeId or scope, action=control with required affordanceId and command plus optional placeId or data, and action=move with required virtual placeId.',
    'Reads return bounded place state and controls remain capability-gated.',
    'Do not use action=control for unregistered devices or action=move for physical presence, which comes from sensors.',
    'Example: {"action":"perceive","placeId":"place.living-room"}.',
  ].join(' '),

  analysis_workbench: [
    'Analyze large files, codebases, logs, transcripts, datasets, or evidence sets without bloating the parent conversation.',
    'Use it only when the required task is supplied and direct semantic tools cannot answer economically; maxIterations and maxTokens are optional bounds, and it returns a bounded synthesis from its temporary sandbox.',
    'Do not use this for routine reasoning, tool discovery, schema confusion, simple lookup, ordinary orient or schedule work, or state mutation; use tool_search and toolset when the needed capability is absent.',
    'Example: {"task":"Compare the failure signatures across these large logs and cite the decisive lines."}.',
  ].join(' '),

  orient: [
    'Maintain scoped continuity blocks, values, active concerns, and explicit introspection choices without redefining identity or transient mood.',
    'Use action=append or action=replace with required block and text; action=reorient requires complete replacement content for at least one of persona, human, or goals; action=values_list accepts optional limit; action=values_add requires value and optional context; action=values_update requires version and value with optional context.',
    'Use action=create_concern with required text and optional lifecycle metadata, action=list_concerns with optional filters, action=resolve_concern with required concernId or concernIds, and action=transition_concern with required concernId plus lifecycle fields; the additional consent actions action=introspection_consent_get, action=introspection_consent_set, and action=introspection_turn_sensitivity_set operate only on their explicit consent inputs.',
    'The tool writes scoped orientation state and returns exact IDs or revisions; use memory for durable facts, north_star for long-horizon intent, and identity for prompt or persona layers.',
    'Example: {"action":"create_concern","text":"Check whether the promised follow-up happened tomorrow.","priority":"medium"}.',
  ].join(' '),

  identity: [
    'Inspect and deliberately revise prompt layers or persona fields through the audited identity boundary.',
    'Use action=list_layers with no required input; action=get_layer requires layer_id; action=diff_layer requires layer_id with optional version and max_diff_lines; action=history accepts optional layer_id and limit.',
    'Use action=update_layer with required layer_id and content, action=rollback_layer with required layer_id and version, action=toggle_layer with required layer_id, action=update_persona with at least one persona field, and action=commit_stage or action=cancel_stage with required stage_id; mutation reasons are optional unless a safeguard asks for one.',
    'The tool returns layer, diff, revision, or staged-change state and never bypasses capability, confirmation, cooling-off, or intake safeguards; use orient for current concerns and north_star for guiding intent.',
    'Example: {"action":"diff_layer","layer_id":"runtime","version":2}.',
  ].join(' '),

  memory: [
    'Store and retrieve durable typed memories when information should survive beyond the current session.',
    'Use action=write with required text and type, action=search with required query and optional filters, action=census with optional filters, action=exists with required lookup criteria, action=timeline with optional bounds, and action=shared_background with required contact_a and contact_b.',
    'Use action=import with required entries, action=patch, action=redact, or action=delete with required memory_id, and action=restore with required delete_id; mutation output reports exact IDs and provenance instead of silently changing unrelated records.',
    'Use scratchpad for temporary work, journal for authored markdown, session for transcripts, and wiki for reference documents.',
    'Example: {"action":"search","query":"the bakery we discussed","limit":5}.',
  ].join(' '),

  scratchpad: [
    'Keep temporary working notes and excerpts that may expire after the current day.',
    'Use action=list with optional limit, action=add with required content, action=replace or action=append with required id and content, and action=remove with required id.',
    'The tool returns ephemeral note IDs and never creates a durable reminder or stable memory; use orient concerns for follow-ups, memory for facts, and journal for lasting markdown.',
    'Example: {"action":"add","content":"Compare the two deployment logs after the next run."}.',
  ].join(' '),

  contact: [
    'Read and deliberately maintain canonical people, relationship state, channel identities, blocking choices, and coarse known-peer availability.',
    'Use action=list with no required input, action=search with required query, action=lookup with required contactId, and action=note with required contactId and notes.',
    'Use action=set_trust with required contactId plus trustLevel or behaviorSignals, action=propose_trust with required contactId and rationale, action=set_relationship with required contactId and relationshipType, and action=propose_relationship with those fields plus rationale.',
    'Use action=link_identity with required contactId, channel, and channelUserId; action=set_channel_privacy adds required privacyLevel; action=set_machine_intelligence requires contactId and isMachineIntelligence.',
    'Use action=block or action=unblock with required contactId, or with required channel and channelUserId for a raw identity; blockMode, blockScope, and reason are optional.',
    'The tool returns exact contact state and never infers high-trust or intimate relationships from caller-supplied counts.',
    'Use memory for remembered events and notify for an explicitly governed outbound initiation.',
    'Example: {"action":"lookup","contactId":"contact-123"}.',
  ].join(' '),

  session: [
    'Navigate conversation continuity, transcript evidence, wake summaries, and bounded focus work.',
    'Use action=list with optional limit, action=search with required query and optional limit, action=grep with required pattern, action=new with optional reason, and action=resume with required sessionId copied from list or search.',
    'Use action=wake_return with required summary and optional nextAnchor or facets, action=start_focus with required scope, and action=complete_focus with optional conclusion; results return exact session or focus identifiers rather than preview text.',
    'Use memory for durable facts and scratchpad for temporary notes instead of treating transcript search as either store.',
    'Example: {"action":"search","query":"promise about the vet appointment","limit":5}.',
  ].join(' '),

  self_status: [
    'Read a safe structured snapshot of current runtime state and manage this companion\'s coarse availability lease.',
    'Use action=snapshot with optional recentChannelLimit, action=diagnose with no required input, action=logs with optional window/limit controls, and action=conformance with no required input.',
    'Use action=availability_read with no required input, action=availability_publish with required state, expires_at_ms, and revision, action=availability_clear with required expected_revision, and action=availability_list_peers with no required input; reads return only bounded operational or already-known peer state.',
    'The surface never returns message content or lifecycle controls; use system for settings, restart, or rebuild.',
    'Example: {"action":"snapshot","recentChannelLimit":3}.',
  ].join(' '),

  system: [
    'Read safe runtime settings and request guarded lifecycle operations.',
    'Use action=read with an optional key, keys, or list selector; action=restart and action=rebuild require reason and return explicit lifecycle acknowledgement.',
    'Lifecycle actions never bypass capability or supervisor safeguards, and this surface does not replace self_status diagnostics.',
    'Example: {"action":"read","list":true}.',
  ].join(' '),

  skill: [
    'Discover, inspect, measure, and author reusable workflow guidance; skills teach a process while tools perform world actions.',
    'Use action=list with optional inclusion flags, action=view with required name, action=stats with optional name, action=create with required name, category, and content, and action=update with required name and content plus optional description.',
    'The tool reads managed skill metadata and writes only personal skills under the configured personal workspace; it never executes the skill body by itself.',
    'Use tool_search for executable capabilities and wiki for durable reference material.',
    'Example: {"action":"view","name":"incident-response"}.',
  ].join(' '),

  wiki: [
    'Manage runtime-owned durable reference documents and personal knowledge notes that are not lived memories or journal entries.',
    'Use action=list with optional filters, action=read with required id, action=search with required query, action=write with required title and body plus optional id, and action=import with required title, body, source_class, and provenance_refs; supported variants may also expose action=semantic_search with required query.',
    'The tool returns documents or search matches and writes provenance-bearing reference material; use memory for experiential facts, journal for authored reflection, and vault only for the optional external Obsidian bridge.',
    'Example: {"action":"search","query":"greenhouse watering protocol"}.',
  ].join(' '),

  schedule: [
    'Manage durable follow-ups, reminders, heartbeat templates, and one-shot scheduled prompts through one time-based continuity surface.',
    'Use action=list with optional contact and completion filters; action=create_follow_up requires content, a raw channel_id string, and channel_type=discord rather than the prompt-facing discord_text label; action=activate_follow_up requires follow_up_id; action=create_reminder requires title and content; action=trigger_reminder requires reminder_id.',
    'Use action=list_templates with no required input, action=update_template with template_id for an existing template or id for a new one, action=run_template with required template_id, and action=schedule_prompt with required name, prompt, and exactly one of delay_minutes or run_at; remaining tuning inputs are optional.',
    'Registry categories action=create, action=update, action=delete, and action=run describe this family but are not extra callable verbs; the concrete schema actions above are authoritative, and no delete action is currently exposed.',
    'The tool returns durable identifiers or run state and does not replace orient concerns for untimed open threads.',
    'Example: {"action":"schedule_prompt","name":"check seedlings","prompt":"Review the greenhouse notes.","delay_minutes":60}.',
  ].join(' '),

  north_star: [
    'Maintain a small ordered set of long-horizon guiding intentions that should outlast current tasks.',
    'Use action=list with no required input, action=create with required title and content plus optional scope, action=update with required item_id and changed fields, action=delete with required item_id, and action=reorder with required item_ids.',
    'The tool returns exact item IDs and ordered state; use orient for current concerns and identity for prompt/persona changes.',
    'Example: {"action":"create","title":"Protect time for art","content":"Keep a weekly block for self-directed drawing."}.',
  ].join(' '),

  beads: [
    'Read and update the canonical tracked-work database when work must survive beyond the current conversation.',
    'Use action=ready with optional limit, action=show with required id, action=create with required title plus optional issue_type, priority, deps, or parent, action=update with required id plus status or priority, action=close with required id and reason, and action=sync with no required input.',
    'The tool returns plain issue IDs and structured tracker state; copy the exact id into later calls and never pass an entire issue object as id.',
    'Use scratchpad for untracked temporary notes rather than creating throwaway issues.',
    'Example: {"action":"show","id":"psfn-framework-123"}.',
  ].join(' '),

  notify: [
    'Send bounded notifications, request explicit review, or initiate governed outreach when an ordinary same-channel reply is not the destination.',
    'Use action=brief with required message and optional title/priority, action=send with required external delivery fields or with required target_kind=companion, contact_id, and initiation_permit for a known peer, and action=approval_request with required approval details; candidate contexts may expose action=consider with required contact_id and reason_summary.',
    'The tool returns delivery or review state only, never chooses an implicit external target, and never accepts peer-visible message content for companion initiation because the destination turn authors it.',
    'Use contact first to resolve an exact canonical contact and use an ordinary reply for the current channel.',
    'Example: {"action":"brief","message":"The overnight validation completed.","priority":3}.',
  ].join(' '),

  generate_image: [
    'Create, transform, or inspect generic images when the subject is not the companion\'s own self-representation.',
    'Use action=generate with required prompt, action=edit with required prompt and input_urls, and action=analyze with required input_urls plus an optional question; provider, model, size, and reference controls are optional.',
    'Successful generation or editing returns image artifacts and a bounded visual review, while analysis returns visible-content evidence without changing an image.',
    'Use selfie_create instead for selfies, self-portraits, or questions about what the companion looks like now.',
    'Example: {"action":"generate","prompt":"A watercolor map of a moonlit garden","aspect_ratio":"4:3"}.',
  ].join(' '),

  selfie_create: [
    'Create a selfie or self-portrait of the companion with appearance context and saved-reference anchoring.',
    'Use it only for an image of the companion herself; prompt is required and should state the desired pose, camera, lighting, and setting, while provider, aspect_ratio, and reference controls are optional.',
    'The tool returns image artifacts plus a visual review and does not handle unrelated people, scenes, objects, or ordinary photo edits; use generate_image for those.',
    'Example: {"prompt":"A relaxed window-light selfie in a green sweater, eye-level camera"}.',
  ].join(' '),

  subagent: [
    'Control bounded short-horizon workers for parallel or isolated tasks that fit within a small turn budget.',
    'Use action=spawn with required name and task plus optional system_prompt, max_turns, capabilities, or toolset; action=message requires subagent_id and message; action=cancel requires subagent_id and accepts an optional reason; action=wait accepts subagent_id but may infer it only when exactly one task is visible; action=status accepts an optional subagent_id.',
    'The tool returns task IDs, lifecycle state, or bounded results and never creates a long-horizon shard or grants tools the parent cannot delegate.',
    'Use status without an id to list visible tasks before deciding whether to message, wait, or cancel.',
    'Example: {"action":"spawn","name":"log-check","task":"Compare the two bounded error excerpts."}.',
  ].join(' '),

  vault: [
    'Access the optional external Obsidian bridge for bounded compatibility with an existing vault.',
    'Use action=read with required note name, action=write with required name and content, action=search with required query, and action=daily with optional content to read or append today\'s note.',
    'The tool returns external note material or write acknowledgement and never becomes the canonical store for runtime knowledge; use wiki for reference documents and journal for companion-authored durable notes.',
    'Example: {"action":"search","query":"seedling rotation"}.',
  ].join(' '),

  journal: [
    'Read and write durable companion-authored markdown notes, reflections, and topic journals.',
    'Use action=list with no required input, action=read with required path or title, action=write or action=append with required content plus path or title, and action=search with required query plus optional limit.',
    'The tool returns note paths or bounded markdown and writes only journal documents; use scratchpad for same-day work, orient concerns for follow-ups, memory for typed facts, and wiki for reference knowledge.',
    'Example: {"action":"write","title":"Garden observations","content":"The basil recovered after moving into indirect light."}.',
  ].join(' '),
} as const;

export type CanonicalToolSurfaceDescriptionName = keyof typeof CANONICAL_TOOL_SURFACE_DESCRIPTIONS;

export function getCanonicalToolSurfaceDescription(name: string): string | undefined {
  return CANONICAL_TOOL_SURFACE_DESCRIPTIONS[
    name as CanonicalToolSurfaceDescriptionName
  ];
}
