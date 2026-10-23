import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { wrapPcmAsWav } from "../shared/audio.js";
import { privateDirectory, readPrivateArtifact, writePrivateArtifact } from "../shared/private-artifacts.js";

export interface ArtifactTurn {
  root: string;
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
  const safeSession = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const turnId = `turn-${randomUUID()}`;
  const directory = path.join(root, dateKey, `${timeKey}_${safeSession}_${turnId}`);
  privateDirectory(root, directory);
  const pcmPath = path.join(directory, "audio.pcm");
  writePrivateArtifact(root, pcmPath, "");
  return {
    root,
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
  writePrivateArtifact(turn.root, turn.pcmPath, chunk, true);
  turn.bytesReceived += chunk.length;
  turn.chunks += 1;
}

export function finalizeWav(turn: ArtifactTurn): void {
  const pcm = readPrivateArtifact(turn.root, turn.pcmPath);
  writePrivateArtifact(turn.root,
    turn.wavPath,
    wrapPcmAsWav(pcm, {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    }),
  );
}

export function writeJson(turn: ArtifactTurn, filePath: string, value: unknown): void {
  writePrivateArtifact(turn.root, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendEvent(turn: ArtifactTurn, type: string, payload: unknown): void {
  writePrivateArtifact(turn.root,
    turn.eventsPath,
    `${JSON.stringify({ type, payload, timestamp: new Date().toISOString() })}\n`, true,
  );
}
