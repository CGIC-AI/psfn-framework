import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual Hub console and custom transports retain operational fields but never arbitrary content or errors", () => {
  const module = new URL("./private-log.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import {hubConsole,privateHubLogger} from ${JSON.stringify(module)};
    const sentinel='PRIVATE_SENTINEL\\r\\nINJECTED_LOG_RECORD\\x1b[31m';
    const error=new Error(sentinel); error.stack=sentinel;
    hubConsole.error('Voxta TTS artifact generation failed:',error,{sessionId:sentinel,detail:sentinel,reason:sentinel,input:sentinel,bytes:16,outcome:'failed'});
    hubConsole.info('hub.realtime.transcript',{turnId:sentinel,chars:17,transcript:sentinel,attachmentName:sentinel,token:sentinel});
    hubConsole.warn(sentinel,error);
    privateHubLogger({warn:message=>process.stderr.write(message+'\\n'),info:message=>process.stdout.write(message+'\\n')}).warn(sentinel,error);
    privateHubLogger(hubConsole).info('hub.realtime.reply',{chars:19,outcome:'success'});
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const output = child.stdout + child.stderr;
  assert.doesNotMatch(output, /PRIVATE_SENTINEL|INJECTED_LOG_RECORD|\r|\x1b/);
  const records = output.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.ok(records.some(record => record.event === "hub.realtime.reply" && record.chars === 19));
  assert.ok(records.some(record => record.event === "hub.realtime.transcript" && record.chars === 17 && typeof record.turnIdTag === "string"));
  assert.ok(records.some(record => record.errorName === "Error" && record.bytes === 16));
});
