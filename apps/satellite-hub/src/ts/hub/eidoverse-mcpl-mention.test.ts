import assert from "node:assert/strict";
import test from "node:test";

import { createEidoverseMcplWakeRuntime, mentionsAnyName, speakerOf } from "./eidoverse-mcpl-runtime.js";
import type { McplIncomingChannelMessage } from "./eidoverse-mcpl-wire.js";

function message(input: {
  id: string;
  author: string;
  text: string;
  tags: string[];
}): McplIncomingChannelMessage {
  return {
    channelId: "world:commons",
    messageId: input.id,
    author: { id: input.author, name: input.author },
    timestamp: "2026-09-09T18:00:00.000Z",
    content: [{ type: "text", text: input.text }],
    tags: input.tags,
  };
}

class RecordingTarget {
  readonly turns: string[] = [];
  readonly speakers: Array<{ id: string; kind: string } | undefined> = [];
  readonly observed: Array<[string, string]> = [];

  async handleEidoverseAddressedUtterance(input: {
    userText: string;
    speaker?: { id: string; name: string; kind: "human" | "ai" };
  }): Promise<string | null> {
    this.turns.push(input.userText);
    this.speakers.push(input.speaker ? { id: input.speaker.id, kind: input.speaker.kind } : undefined);
    return null;
  }

  observeEidoverseParticipant(id: string, kind: "human" | "ai"): void {
    this.observed.push([id, kind]);
  }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("name matching is case-insensitive, @-optional and punctuation-tolerant", () => {
  const names = ["Artie", "artie-kube"];
  assert.equal(mentionsAnyName("visitor: @Artie come over here", names), true);
  assert.equal(mentionsAnyName("visitor: hey artie, over here!", names), true);
  assert.equal(mentionsAnyName("visitor: ARTIE: are you there?", names), true);
  assert.equal(mentionsAnyName("visitor: @artie-kube hello", names), true);
  assert.equal(mentionsAnyName("visitor: the artiest of them all", names), false);
  assert.equal(mentionsAnyName("visitor: partier", names), false);
  assert.equal(mentionsAnyName("visitor: nothing for anyone", names), false);
  assert.equal(mentionsAnyName("visitor: hello", []), false);
});

test("ambient chat naming the companion wakes it; its own echo and untagged acts do not", async () => {
  const target = new RecordingTarget();
  const info: string[] = [];
  const wake = createEidoverseMcplWakeRuntime(target, {
    ambientSayDebounceMs: 10,
    catchupWake: false,
    wakeQueueLimit: 8,
    agentNames: ["Artie"],
  }, { logger: { warn: () => undefined, info: (line) => info.push(line) } });

  wake.deliver([
    message({ id: "m1", author: "visitor", text: "visitor: Artie, come over here", tags: ["chat:ambient"] }),
    message({ id: "m2", author: "artie", text: "artie: I am Artie and I am here", tags: ["chat:ambient", "chat:from-agent"] }),
    message({ id: "m3", author: "artie", text: "artie: Artie talking to himself", tags: ["chat:ambient"] }),
    message({ id: "m4", author: "world", text: "* visitor waves at Artie", tags: ["chat:ambient", "eidoverse:act"] }),
    message({ id: "m5", author: "visitor", text: "visitor: @artie by tag", tags: ["chat:mention", "chat:addressed"] }),
    message({ id: "m6", author: "visitor", text: "visitor: nobody in particular", tags: ["chat:ambient"] }),
  ]);
  await settle();
  await wake.close();

  assert.deepEqual(target.turns, ["visitor: Artie, come over here", "visitor: @artie by tag"]);
  assert.equal(info.length, 2, info.join("\n"));
  assert.match(info[0]!, /^Eidoverse wake: message m1 from visitor \(human\) kind=mention reason=name-match text="visitor: Artie, come over here"/u);
  assert.match(info[1]!, /^Eidoverse wake: message m5 from visitor \(human\) kind=mention reason=tag:chat:mention,chat:addressed/u);
});

test("the world's own human/ai classification rides every wake and is learned for every chat line", async () => {
  const target = new RecordingTarget();
  const wake = createEidoverseMcplWakeRuntime(target, {
    ambientSayDebounceMs: 10,
    catchupWake: false,
    wakeQueueLimit: 8,
    agentNames: ["Artie"],
  }, { logger: { warn: () => undefined } });

  wake.deliver([
    message({ id: "h1", author: "visitor", text: "visitor: @artie hello", tags: ["chat:mention", "chat:addressed"] }),
    message({ id: "a1", author: "artie-kube", text: "artie-kube: @artie hello from kube", tags: ["chat:mention", "chat:addressed", "chat:from-agent"] }),
    message({ id: "w1", author: "world", text: "* visitor waves", tags: ["chat:ambient", "eidoverse:act"] }),
    message({ id: "h2", author: "visitor", text: "visitor: just chatting", tags: ["chat:ambient"] }),
  ]);
  await settle();
  await wake.close();

  assert.deepEqual(target.speakers, [{ id: "visitor", kind: "human" }, { id: "artie-kube", kind: "ai" }]);
  assert.deepEqual(target.observed, [["visitor", "human"], ["artie-kube", "ai"], ["visitor", "human"]]);
  assert.equal(speakerOf(message({ id: "x", author: "world", text: "* rain", tags: ["chat:ambient", "eidoverse:weather"] })), null);
});
