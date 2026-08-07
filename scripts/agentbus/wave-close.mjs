#!/usr/bin/env node
// wave-close: validate a wave's agentbus run before the train publishes.
// A wave run that does not lint clean is not closed; fix by appending
// corrections, never by editing the file.
//
// Beyond lint, a WAVE run also gates on participation: every lane declared
// in the opening "Wave <name> opened with lanes: ..." orchestrator note must
// have authored at least one finding. A silent lane means the brief block
// never reached that lane or the lane did not do the work; either way the
// wave does not close until it appends a finding. Non-wave runs (no opening
// note) are linted only — participation is a wave concept. Extra agents that
// were not declared as lanes (e.g. review-* lanes added later) do not count
// against the gate.
//
// Usage:
//   node scripts/agentbus/wave-close.mjs [<run-file>]
//   node scripts/agentbus/wave-close.mjs --self-test
// With no argument, lints every run file under $AGENTBUS_DIR or ./bus/runs,
// skipping the *.vec.jsonl vector sidecars.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LANE_RE = /^[a-z0-9][a-z0-9-]*$/;
const OPENED_RE = /opened with lanes:\s*([^.]+)\./;

function agentName(msg) {
  const a = msg.agent;
  return typeof a === 'string' ? a : a && typeof a === 'object' ? a.name : '';
}

function readRun(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* bus-lint is the validator */ }
  }
  return out;
}

// Lanes declared in the opening orchestrator note, or null if not a wave run.
function declaredLanes(messages) {
  for (const m of messages) {
    if (m.type !== 'note') continue;
    const text = m.body && m.body.text;
    if (typeof text !== 'string') continue;
    const hit = text.match(OPENED_RE);
    if (hit) return hit[1].split(',').map((s) => s.trim()).filter((s) => LANE_RE.test(s));
  }
  return null;
}

// Substantive inter-lane message types. A lane participates if it authored at
// least one of these; note and cost are bookkeeping and do not count, so a lane
// that only opened/closed with a note and a cost is still silent. A coordinator
// lane that ranks another lane's finding has participated; that is the point.
const SUBSTANTIVE = new Set(['finding', 'rank', 'question', 'answer', 'handoff', 'correction']);

// Declared lanes that authored zero substantive messages, [] when all present, null for non-wave runs.
function silentLanes(messages) {
  const lanes = declaredLanes(messages);
  if (!lanes || lanes.length === 0) return null;
  const spoke = new Set(
    messages.filter((m) => SUBSTANTIVE.has(m.type)).map(agentName).filter(Boolean),
  );
  return lanes.filter((l) => !spoke.has(l));
}

function closeOne(target) {
  try {
    execFileSync('bus-lint', [target], { stdio: 'inherit' });
  } catch {
    return false;
  }
  const silent = silentLanes(readRun(target));
  if (silent && silent.length) {
    console.error(`participation: ${silent.length} declared lane(s) sent no message (finding/rank/handoff/question/answer/correction): ${silent.join(', ')}`);
    console.error(`  a note or cost alone is bookkeeping, not participation; append something for each, or close is refused.`);
    return false;
  }
  return true;
}

function selfTest() {
  const note = (text) => ({ type: 'note', agent: 'orchestrator', body: { text } });
  const finding = (agent) => ({ type: 'finding', agent, body: { claim: 'x', provenance: 'testimony', source: 's' } });
  const rank = (agent) => ({ type: 'rank', agent, body: { dimension: 'd', value: 'v', basis: 'b' } });
  const norm = (v) => (v === null || (Array.isArray(v) && v.length === 0) ? 'pass' : v.join(','));
  const cases = [
    ['non-wave run skipped', [], 'pass'],
    ['all lanes present', [note('Wave w opened with lanes: a-lane, b-lane.'), finding('a-lane'), finding('b-lane')], 'pass'],
    ['b-lane silent', [note('Wave w opened with lanes: a-lane, b-lane.'), finding('a-lane')], 'b-lane'],
    ['no findings at all', [note('Wave w opened with lanes: a-lane, b-lane.')], 'a-lane,b-lane'],
    ['undeclared reviewer not required', [note('Wave w opened with lanes: a-lane.'), finding('a-lane'), finding('review-x')], 'pass'],
    ['agent as {name} object', [note('Wave w opened with lanes: a-lane.'), { type: 'finding', agent: { name: 'a-lane' } }], 'pass'],
    ['coordinator ranks, no finding -> passes', [note('Wave w opened with lanes: coordinator, impl.'), finding('impl'), rank('coordinator')], 'pass'],
    ['only note+cost is still silent', [note('Wave w opened with lanes: coordinator, impl.'), finding('impl'), { type: 'note', agent: 'coordinator', body: { text: 'go' } }, { type: 'cost', agent: 'coordinator', body: {} }], 'coordinator'],
  ];
  let bad = 0;
  for (const [name, msgs, expect] of cases) {
    const got = silentLanes(msgs);
    const g = norm(got);
    const ok = g === expect;
    if (!ok) bad++;
    console.error(`${ok ? 'ok  ' : 'FAIL'}  ${name}  (got: ${g}, want: ${expect})`);
  }
  return bad === 0;
}

const [, , arg] = process.argv;

if (arg === '--self-test' || arg === 'self-test') {
  process.exit(selfTest() ? 0 : 1);
}

let targets;
if (arg) {
  targets = [arg];
} else {
  const dir = process.env.AGENTBUS_DIR ?? join(process.cwd(), 'bus', 'runs');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    console.error(`no runs directory at ${dir}`);
    process.exit(2);
  }
  targets = names
    .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.vec.jsonl'))
    .map((f) => join(dir, f));
  if (targets.length === 0) {
    console.error(`no run files under ${dir}`);
    process.exit(2);
  }
}

let failed = false;
for (const target of targets) {
  if (!closeOne(target)) failed = true;
}
process.exit(failed ? 1 : 0);
