import assert from "node:assert/strict";
import test from "node:test";

import { approachPosition, findEidoversePerson, parseEidoverseLook } from "./eidoverse-look-parse.js";

const LOOK = [
  'You are "nova" in world "commons" at (0.0, 0.0), ground height 0.00m, facing S.',
  'World: {"sky":{"currentHour":14.5}}',
  "",
  "People (3):",
  "  - visitor: 3.2m NE at (2.0, 2.5), standing",
  "  - nova-kube: 0.0m N at (0.0, 0.0), sitting on a chair, holding a pose (3 bones)",
  "  - newcomer (just arrived, position unknown)",
  "",
  "Things (2):",
  "  - [ab12] wooden bench: 4.1m E at (4.0, 0.0, 1.0) — sit/mount: seat · 🔒 locked (immovable until comp {id, type: \"lock\", data: null})",
  "  - [cd34] lantern: position rides ferry — the ferry is mid-hop",
  "  (interact via world_verb: use {id, action} · sit/ride via mount {id: \"nova\", to, slot} — both open to everyone; dismount {id: \"nova\"} to get off)",
  "",
  "Since you last looked:",
  "  visitor: @Nova come over here",
  "  * newcomer arrived",
].join("\n");

test("look parser lifts self, people, things and recent lines out of the door's prose", () => {
  const perception = parseEidoverseLook(LOOK);
  assert.deepEqual(perception.self, {
    id: "nova",
    world: "commons",
    positionKnown: true,
    x: 0,
    z: 0,
    groundHeightM: 0,
    facing: "S",
  });
  assert.equal(perception.people.length, 3);
  assert.deepEqual(perception.people[0], {
    id: "visitor",
    positionKnown: true,
    distanceM: 3.2,
    bearing: "NE",
    x: 2,
    z: 2.5,
    doing: "standing",
  });
  assert.equal(perception.people[1]?.doing, "sitting on a chair, holding a pose (3 bones)");
  assert.deepEqual(perception.people[2], { id: "newcomer", positionKnown: false, doing: "just arrived, position unknown" });
  assert.equal(perception.things.length, 2);
  assert.equal(perception.things[0]?.id, "ab12");
  assert.equal(perception.things[0]?.label, "wooden bench");
  assert.deepEqual([perception.things[0]?.x, perception.things[0]?.y, perception.things[0]?.z], [4, 0, 1]);
  assert.equal(perception.things[0]?.distanceM, 4.1);
  assert.match(perception.things[0]?.detail ?? "", /^sit\/mount: seat/u);
  assert.equal(perception.things[1]?.positionKnown, false);
  assert.deepEqual(perception.recent, ["visitor: @Nova come over here", "* newcomer arrived"]);
  assert.equal(perception.raw, LOOK);
});

test("look parser reports an unknown own position honestly and tolerates an empty world", () => {
  const perception = parseEidoverseLook([
    'You are "nova" in world "commons", position unknown (seat unresolved), facing N.',
    "Nobody else is here right now.",
    "No placed things yet.",
  ].join("\n"));
  assert.deepEqual(perception.self, { id: "nova", world: "commons", positionKnown: false, facing: "N" });
  assert.deepEqual(perception.people, []);
  assert.deepEqual(perception.things, []);
  assert.deepEqual(perception.recent, []);
});

test("participants resolve case-insensitively with an optional @ and approach stops short", () => {
  const perception = parseEidoverseLook(LOOK);
  assert.equal(findEidoversePerson(perception, "@Visitor")?.id, "visitor");
  assert.equal(findEidoversePerson(perception, "VISITOR")?.id, "visitor");
  assert.equal(findEidoversePerson(perception, "nobody"), undefined);
  assert.deepEqual(approachPosition({ x: 0, z: 0 }, { x: 3, z: 4 }), { x: 2.1, z: 2.8 });
  assert.equal(approachPosition({ x: 0, z: 0 }, { x: 1, z: 0.5 }), null, "already within the standoff");
});
