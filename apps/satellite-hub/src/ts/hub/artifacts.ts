import fs from "node:fs";
import path from "node:path";

import { wrapPcmAsWav } from "../shared/audio.js";

export interface ArtifactTurn {
  sessionId: string;
  turnId: string;
  directory: string;
  pcmPath: string;
  wavPath: string;
  transcriptPath: string;
  replyPath: string;
  eventsPath: string;
  startedAt: Date;
  bytesReceived: number;
  chunks: number;
}

export function createArtifactTurn(root: string, sessionId: string): ArtifactTurn {
  const startedAt = new Date();
  const dateKey = startedAt.toISOString().slice(0, 10).replaceAll("-", "");
  const timeKey = startedAt.toISOString().slice(11, 19).replaceAll(":", "");
  const safeSession = sessionId.replaceAll(/[/:]/g, "_");
  const turnId = `turn-${Math.random().toString(16).slice(2, 10)}`;
  const directory = path.join(root, dateKey, `${timeKey}_${safeSession}_${turnId}`);
  fs.mkdirSync(directory, { recursive: true });
  const pcmPath = path.join(directory, "audio.pcm");
  fs.writeFileSync(pcmPath, "");
  return {
    sessionId,
    turnId,
    directory,
    pcmPath,
    wavPath: path.join(directory, "audio.wav"),
    transcriptPath: path.join(directory, "transcript.json"),
    replyPath: path.join(directory, "reply.json"),
    eventsPath: path.join(directory, "events.jsonl"),
    startedAt,
    bytesReceived: 0,
    chunks: 0,
  };
}

export function appendPcm(turn: ArtifactTurn, chunk: Buffer): void {
  fs.appendFileSync(turn.pcmPath, chunk);
  turn.bytesReceived += chunk.length;
  turn.chunks += 1;
}

export function finalizeWav(turn: ArtifactTurn): void {
  const pcm = fs.readFileSync(turn.pcmPath);
  fs.writeFileSync(
    turn.wavPath,
    wrapPcmAsWav(pcm, {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    }),
  );
}

export function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendEvent(turn: ArtifactTurn, type: string, payload: unknown): void {
  fs.appendFileSync(
    turn.eventsPath,
    `${JSON.stringify({ type, payload, timestamp: new Date().toISOString() })}\n`,
  );
}
