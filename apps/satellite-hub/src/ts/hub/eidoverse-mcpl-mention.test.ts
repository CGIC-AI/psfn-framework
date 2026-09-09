import assert from "node:assert/strict";
import test from "node:test";

import { createEidoverseMcplWakeRuntime, mentionsAnyName } from "./eidoverse-mcpl-runtime.js";
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

  async handleEidoverseAddressedUtterance(input: { userText: string }): Promise<string | null> {
    this.turns.push(input.userText);
    return null;
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
  assert.match(info[0]!, /^Eidoverse wake: message m1 from visitor kind=mention reason=name-match text="visitor: Artie, come over here"/u);
  assert.match(info[1]!, /^Eidoverse wake: message m5 from visitor kind=mention reason=tag:chat:mention,chat:addressed/u);
});
