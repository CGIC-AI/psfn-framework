import { action, type CanonicalToolSurfaceContract } from './contracts.js';

export const CATALOG_BOUNDARY_TOOL_CONTRACTS = {
  tool_search: {
    purpose: 'Look up long-form documentation for a canonical tool by name, purpose, action, or parameter.',
    actions: [action('search', [], ['query', 'limit'], {
      id: 'search', actionField: false,
      rule: 'the callable schema has no action field and lookup never loads, activates, grants, or changes callability',
    })],
    output: 'It returns matching documentation for tools that are already present in the callable catalog.',
    guidance: 'Do not use it to perform a domain operation; call the documented canonical tool directly.',
    example: { query: 'publish a repository change' },
  },
  toolset: {
    purpose: 'Inspect the always-callable catalog, request advisory ranking, or manage presentation-order pins.',
    actions: [
      action('list'),
      action('suggest', ['intent'], ['limit']),
      action('describe', ['tool']),
      action('pin', ['tool'], ['reason']),
      action('unpin', ['tool'], ['reason']),
    ],
    output: 'Every registered tool is already callable without activation; it returns catalog or ordering state and never performs a domain operation or grants capability.',
    guidance: 'Do not search again after choosing a tool; call its canonical name directly.',
    example: { action: 'describe', tool: 'repo' },
  },
  response_control: {
    purpose: 'Record an intentional decision to send no outward response for the current turn.',
    actions: [action('no_reply', [], ['reason'])],
    output: 'It returns an audited disposition and never emits a sentinel visible to the person.',
    guidance: 'Do not use it while a generated paid attachment still needs an ordinary reply for delivery.',
    example: { action: 'no_reply', reason: 'The message requests no response.' },
  },
  fs: {
    purpose:
      'Read and safely mutate files within the configured personal-file boundary; one direct read has a hard cap of 20,000 bytes.',
    actions: [
      action('list', [], ['path', 'glob', 'max_entries', 'max_scanned_entries']),
      action('read', ['path'], ['max_bytes', 'offset_bytes']),
      action('search', ['query'], ['glob', 'mode', 'max_matches', 'max_files', 'max_bytes_per_file', 'context_lines']),
      action('write', ['path', 'content'], ['overwrite']),
      action('edit', ['path', 'old_text', 'new_text'], ['replace_all']),
    ],
    output: 'It returns bounded file data and fails closed on unsafe paths or ambiguous mutation.',
    guidance:
      'Do not request more than 20,000 bytes from one read. Inspect larger files sequentially by passing each returned '
      + 'next_offset_bytes as the next offset_bytes until eof. For a long document or evidence job, prefer a bounded subagent '
      + 'worker or automaton using analysis_workbench so its temporary context can be discarded after a bounded result; direct '
      + 'analysis_workbench use is still permitted but may occupy the primary turn for several minutes. Require '
      + 'provenance-bearing excerpts with the source path and line or byte ranges; do not rely on a summary-only handoff. '
      + 'Do not use fs for git state; use repo.',
    example: { action: 'search', query: 'TODO', glob: 'notes/**/*.md' },
  },
  repo: {
    purpose: 'Inspect a git repository and, in full-access variants, perform guarded repository mutations.',
    actions: [
      action('inspect', [], ['target', 'staged']),
      action('patch', ['file_path', 'content']),
      action('branch', ['name'], ['start_point']),
      action('commit', ['message', 'intent'], ['scope']),
      action('publish', ['title', 'body'], ['base']),
    ],
    output: 'It returns explicit repository state and mutations remain subject to branch, path, capability, and confirmation policy.',
    guidance: 'Do not use it for ordinary personal files; use fs for those.',
    example: { action: 'inspect', target: 'both' },
  },
  shell: {
    purpose:
      'Run a one-shot Bash or CLI command while puttering through the entire Personal Workspace, including any Git checkout stored inside it.',
    actions: [action('exec', ['command'], ['args', 'cwd', 'timeout_ms', 'max_output_chars', 'env_vars'])],
    output:
      'Each exec starts in a fresh isolated process, returns bounded stdout, stderr, exit status, timing, and truncation state, and leaves intentional workspace writes persisted for later calls.',
    guidance:
      'The default wall budget is ten minutes and the operator-owned ceiling is one hour. The sandbox has no network, '
      + 'clears inherited secrets, exposes only read-only image CLI binaries, and cannot see host or runtime-state paths '
      + 'outside the Personal Workspace. The workspace is mounted read-write at /workspace (the default cwd); when the '
      + 'operator enables it, a read-only copy of the source repository is mounted at /repo (also exposed as $PSFN_REPO). '
      + 'The image carries analysis and document tooling — bash, rg, jq, file, unzip/zip, sqlite3, pdftotext (poppler), '
      + 'pandoc, python3, and uv — so prefer targeted CLI filters and small scripts over dumping whole files. '
      + 'Use a relative cwd to move around the workspace. Prefer fs or repo when their '
      + 'structured action is clearer; use shell for direct CLI exploration, scripts, builds, tests, and Git commands.',
    example: {
      action: 'exec',
      command: 'bash',
      args: ['-lc', 'pwd; git status --short; rg -n "needle" .'],
      cwd: '.',
    },
  },
  web: {
    purpose: 'Retrieve external web material or perform small-scope discovery through the configured backend.',
    actions: [
      action('fetch', ['target'], ['prompt']),
      action('browse', ['target'], ['prompt']),
      action('search', ['target'], ['max_urls']),
    ],
    output: 'It returns external untrusted content, with target interpreted as a URL for fetch/browse and a query for search.',
    guidance: 'Do not use it for local files, transcripts, or remembered facts; use fs, session, or memory.',
    example: { action: 'fetch', target: 'https://example.com/reference' },
  },
  world: {
    purpose: 'Perceive and act on registered physical or virtual place affordances through the world runtime.',
    actions: [
      action('perceive', [], ['placeId']),
      action('list', [], ['placeId', 'scope']),
      action('control', ['affordanceId', 'command'], ['placeId', 'data', 'intent', 'reason'], {
        id: 'control', rule: 'non-human requesters must also supply explicit intent and reason',
      }),
      action('move', ['placeId']),
    ],
    output: 'It returns bounded place state; controls are capability-gated and virtual move never changes sensed physical presence.',
    guidance: 'Do not control unregistered devices or use move for physical presence.',
    example: { action: 'perceive', placeId: 'place.living-room' },
  },
  analysis_workbench: {
    purpose: 'Analyze a large file, codebase, log set, transcript set, dataset, or evidence set in a temporary bounded sandbox.',
    actions: [action('analyze', ['task'], ['maxIterations', 'maxTokens'], { id: 'analyze', actionField: false })],
    output: 'It returns a bounded synthesis and does not mutate source state.',
    guidance:
      'Use it when material is too large for the fs 20,000-byte direct-read cap. Prefer delegating long analyses to a '
      + 'bounded worker or automaton so the primary channel stays responsive; direct use is permitted when capability '
      + 'policy allows it, but the call may occupy the primary turn for several minutes. Bring only the bounded answer '
      + 'plus source paths and relevant line or byte ranges back into the conversation before its temporary context is discarded. '
      + 'Do not use it for routine reasoning, simple lookup, schema confusion, or ordinary orient and schedule work; '
      + 'use the relevant callable semantic tool.',
    example: { task: 'Compare the failure signatures across these large logs and cite the decisive lines.' },
  },
} as const satisfies Record<string, CanonicalToolSurfaceContract>;
