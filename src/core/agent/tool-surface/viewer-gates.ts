import type { SensitivityLevel } from '../../../system/trust/types.js';

/**
 * Viewer-gate decision for every canonical tool action (psfn-framework-o5wf5
 * sweep). Tools return companion-wide state formed in many conversations; each
 * action states how a lower-trust room is kept from reading another room's
 * material:
 *
 * - `sensitivity`: the records carry no source conversation, so the action is
 *   available only where the viewer's trust and room admit material of this
 *   sensitivity (viewerAdmitsSensitivity). Enforced centrally by the tool
 *   runtime facade before the tool runs.
 * - `in_tool`: the tool filters by per-record provenance itself (the reason
 *   names the gate).
 * - `not_applicable`: the action returns no companion-wide conversation
 *   content (writes, catalog/config reads, per-conversation or content-free
 *   results, identity by design).
 *
 * The enumeration test fails when a canonical tool action has no decision.
 */
export type ToolViewerGateDecision =
  | { kind: 'sensitivity'; level: SensitivityLevel }
  | { kind: 'in_tool'; reason: string }
  | { kind: 'not_applicable'; reason: string };

/** Key for tools that expose no action parameter. */
export const TOOL_WITHOUT_ACTIONS = '*';

const PERSONAL: ToolViewerGateDecision = { kind: 'sensitivity', level: 'personal' };
const CONFIDENTIAL: ToolViewerGateDecision = { kind: 'sensitivity', level: 'confidential' };
const write = (what: string): ToolViewerGateDecision => ({
  kind: 'not_applicable',
  reason: `write (${what}); returns no other-conversation content`,
});
const na = (reason: string): ToolViewerGateDecision => ({ kind: 'not_applicable', reason });
const inTool = (reason: string): ToolViewerGateDecision => ({ kind: 'in_tool', reason });

const CATALOG = na('tool catalog and pin state; no conversation content');

export const TOOL_VIEWER_GATE_DECISIONS: Readonly<Record<string, Readonly<Record<string, ToolViewerGateDecision>>>> = {
  tool_search: { [TOOL_WITHOUT_ACTIONS]: CATALOG },
  toolset: { list: CATALOG, suggest: CATALOG, describe: CATALOG, pin: CATALOG, unpin: CATALOG },
  response_control: { no_reply: na('turn control') },
  fs: {
    // The Personal Workspace holds material saved from many conversations.
    read: PERSONAL,
    list: PERSONAL,
    search: PERSONAL,
    write: write('workspace file'),
    edit: write('workspace file'),
  },
  repo: {
    inspect: na('source repository, governed by capability tier'),
    patch: write('repository'),
    commit: write('repository'),
    branch: write('repository'),
    publish: write('repository'),
  },
  shell: { exec: na('host execution, governed by capability tier') },
  web: { fetch: na('external web content'), search: na('external web content') },
  mcp: {
    catalog: na('connector catalog'),
    search: na('connector catalog'),
    inspect: na('connector catalog'),
    call: na('external connector call, governed by capability tier'),
    release: na('connector lifecycle'),
  },
  world: {
    perceive: na('shared world plane state'),
    list: na('shared world plane state'),
    control: write('world plane'),
    move: write('world plane'),
    act: write('world plane'),
  },
  analysis_workbench: {
    [TOOL_WITHOUT_ACTIONS]: inTool('sandbox session helpers use the request-context viewer gate (k0sr0); read_file refuses the journal; memory helpers use memory visibility'),
  },
  orient: {
    append: write('core memory block of this conversation'),
    replace: write('core memory block of this conversation'),
    reorient: write('core memory block of this conversation'),
    values_list: PERSONAL,
    values_add: write('values journal'),
    values_update: write('values journal'),
    create_concern: write('concern'),
    list_concerns: inTool('filterConcernsForViewer (trust x room sensitivity, contact scope)'),
    resolve_concern: write('concern'),
    transition_concern: write('concern'),
    introspection_consent_get: PERSONAL,
    introspection_consent_set: write('introspection consent'),
    introspection_turn_sensitivity_set: write('introspection turn sensitivity'),
  },
  identity: {
    list_layers: na('companion prompt configuration (identity by design)'),
    get_layer: na('companion prompt configuration (identity by design)'),
    diff_layer: na('companion prompt configuration (identity by design)'),
    history: na('companion prompt configuration (identity by design)'),
    update_layer: write('prompt layer'),
    rollback_layer: write('prompt layer'),
    toggle_layer: write('prompt layer'),
    update_persona: write('persona'),
    commit_stage: write('persona'),
    cancel_stage: write('persona'),
  },
  memory: {
    write: write('memory'),
    search: inTool('partitionVisibleMemories (retrieval access decision) with withheld note'),
    episode_search: inTool('isEpisodeVisibleForTurn with withheld count'),
    get: inTool('episode visibility and session reader gate'),
    shared_background: inTool('shared background visibility policy'),
    census: inTool('partitionVisibleMemories; counts only'),
    exists: inTool('partitionVisibleMemories; no text'),
    timeline: inTool('isEpisodeVisibleForTurn with withheld count'),
    import: write('memory'),
    patch: write('memory'),
    redact: write('memory'),
    delete: write('memory'),
    restore: write('memory'),
  },
  automata_bus: {
    brief: na('bound to one worker run'),
    search: na('bound to one worker run'),
    append: na('bound to one worker run'),
    correct: na('bound to one worker run'),
    handoff: na('bound to one worker run'),
    runs: na('bound to one worker run'),
    inspect: na('bound to one worker run'),
  },
  scratchpad: {
    list: inTool('scratchpad provenance (conversation / companion_global / unknown primary-only)'),
    add: inTool('records the writing conversation'),
    replace: inTool('only notes visible to this conversation'),
    append: inTool('only notes visible to this conversation'),
    remove: inTool('only notes visible to this conversation'),
  },
  contact: {
    // Contact records hold notes, trust and identities about people met in
    // other conversations; fleet siblings are the companion's own peers.
    list: inTool('human contacts only where personal material is admitted; fleet sibling companions (name, ids, ICP availability) always (contact-viewer-access)'),
    search: inTool('human contacts only where personal material is admitted; fleet sibling companions (name, ids, ICP availability) always (contact-viewer-access)'),
    lookup: inTool('human contacts only where personal material is admitted; fleet sibling companions (name, ids, ICP availability) always (contact-viewer-access)'),
    note: write('contact'),
    set_trust: write('contact'),
    propose_trust: write('contact'),
    set_relationship: write('contact'),
    propose_relationship: write('contact'),
    link_identity: write('contact'),
    set_channel_privacy: write('contact'),
    set_machine_intelligence: write('contact'),
    block: write('contact'),
    unblock: write('contact'),
  },
  session: {
    list: inTool('gateSessionSummariesForViewer'),
    new: na('starts a new session'),
    resume: inTool('canViewerReadSessionChannel'),
    search: inTool('canViewerAccessSessionHit with gatedOutCount'),
    grep: inTool('canViewerAccessSessionHit with gatedOutCount'),
    wake_return: inTool('canViewerReadSessionChannel before writing'),
    start_focus: inTool('canViewerReadSessionChannel for an explicit channel'),
    complete_focus: inTool('canViewerReadSessionChannel for an explicit channel'),
  },
  letter: {
    compose: write('letter'),
    // Letters between the companion and its partner are private correspondence.
    list: CONFIDENTIAL,
    read: CONFIDENTIAL,
    place: write('letter'),
    archive: write('letter'),
    disposition_list: PERSONAL,
    disposition_read: PERSONAL,
  },
  self_status: {
    capabilities: na('capability grant'),
    snapshot: inTool('gateSessionSummariesForViewer for recent sessions'),
    diagnose: na('redacted runtime diagnostics'),
    logs: na('redacted runtime diagnostics'),
    conformance: na('tool conformance report'),
    availability_read: na('availability state'),
    availability_publish: write('availability'),
    availability_clear: write('availability'),
    availability_list_peers: na('sibling availability, no content'),
  },
  system: { read: na('system status'), restart: write('system'), rebuild: write('system') },
  skill: {
    list: na('companion-authored procedures (content-safety admitted)'),
    view: na('companion-authored procedures (content-safety admitted)'),
    stats: na('usage counts'),
    create: write('skill'),
    update: write('skill'),
    history: na('companion-authored procedures (content-safety admitted)'),
    rollback: write('skill'),
  },
  wiki: {
    // The personal wiki, wishes, projects, wardrobe and world notes are
    // companion-wide and carry material from many conversations.
    list: PERSONAL,
    read: PERSONAL,
    search: PERSONAL,
    semantic_search: PERSONAL,
    write: write('wiki'),
    import: write('wiki'),
    propose_shared_world: write('shared world proposal'),
    wish_list: PERSONAL,
    wish_read: PERSONAL,
    wish_create: write('wish'),
    project_list: PERSONAL,
    project_read: PERSONAL,
    project_create: write('project'),
    project_update: write('project'),
    project_add_artifact: write('project'),
    project_share: write('project'),
    wardrobe_list: PERSONAL,
    wardrobe_read: PERSONAL,
    wardrobe_save: write('wardrobe'),
    wardrobe_revise: write('wardrobe'),
    world_notes_read: PERSONAL,
    world_note: write('world note'),
  },
  schedule: {
    list: inTool('follow-ups and reminders gated by their conversation (schedule-visibility)'),
    create_follow_up: inTool('refuses a target conversation the viewer cannot read'),
    activate_follow_up: inTool('only follow-ups visible to this conversation'),
    create_reminder: inTool('refuses a target conversation the viewer cannot read'),
    trigger_reminder: inTool('only reminders visible to this conversation'),
    list_templates: na('reflection template configuration'),
    update_template: write('reflection template'),
    run_template: write('reflection run'),
    schedule_prompt: write('scheduled prompt'),
  },
  north_star: {
    list: na('companion goals (identity; also in every turn\'s static prefix by design)'),
    create: write('north star'),
    update: write('north star'),
    delete: write('north star'),
    reorder: write('north star'),
  },
  beads: {
    ready: na('operator work tracker'),
    show: na('operator work tracker'),
    create: write('issue'),
    update: write('issue'),
    close: write('issue'),
    sync: write('issue tracker'),
  },
  notify: {
    brief: write('notification'),
    send: write('notification'),
    consider: write('notification'),
    approval_request: write('approval request'),
    clarify: write('clarification'),
    outreach_send: write('outreach'),
    outreach_later: write('outreach'),
  },
  generate_image: { generate: write('image'), edit: write('image'), analyze: na('analyzes a provided image') },
  selfie_create: { [TOOL_WITHOUT_ACTIONS]: write('image') },
  publication: {
    submit: write('publication'),
    revise: write('publication'),
    status: na('publication status of this companion'),
  },
  subagent: {
    spawn: inTool('the worker runs at no more than the spawning viewer (viewer-ceiling)'),
    message: inTool('the spawning conversation always sees its own workers; other conversations\' workers only where their transcript is readable (task-visibility)'),
    wait: inTool('the spawning conversation always sees its own workers; other conversations\' workers only where their transcript is readable (task-visibility)'),
    cancel: inTool('the spawning conversation always sees its own workers; other conversations\' workers only where their transcript is readable (task-visibility)'),
    status: inTool('the spawning conversation always sees its own workers; other conversations\' workers only where their transcript is readable (task-visibility)'),
    discover: inTool('the spawning conversation always sees its own workers; other conversations\' workers only where their transcript is readable (task-visibility)'),
    inspect: inTool('the spawning conversation always sees its own workers; other conversations\' workers only where their transcript is readable (task-visibility)'),
  },
  vault: { write: write('vault note'), read: PERSONAL, search: PERSONAL, daily: write('vault daily note') },
  journal: {
    list: inTool('journal note provenance'),
    read: inTool('journal note provenance'),
    write: inTool('stamps provenance; refuses notes the viewer cannot read'),
    append: inTool('stamps provenance; refuses notes the viewer cannot read'),
    search: inTool('journal note provenance'),
  },
};

/** The decision for one call, or undefined when the tool/action has none. */
export function resolveToolViewerGateDecision(
  toolName: string,
  action: string | undefined,
): ToolViewerGateDecision | undefined {
  const decisions = TOOL_VIEWER_GATE_DECISIONS[toolName];
  if (!decisions) return undefined;
  if (Object.prototype.hasOwnProperty.call(decisions, TOOL_WITHOUT_ACTIONS)) {
    return decisions[TOOL_WITHOUT_ACTIONS];
  }
  if (action === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(decisions, action) ? decisions[action] : undefined;
}
