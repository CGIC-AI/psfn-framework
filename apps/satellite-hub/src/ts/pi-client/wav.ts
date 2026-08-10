const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;

interface WavFormatChunk {
  audioFormat: number;
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
}

export function decodeSpeechUploadToPcm16(
  audio: Buffer,
  mimeType: string | undefined,
): Buffer {
  if (!looksLikeWav(audio)) {
    throw new Error(`Unsupported speech upload format: ${mimeType || "unknown"}`);
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let formatChunk: WavFormatChunk | null = null;
  let dataOffset = -1;
  let dataSize = -1;

  let offset = 12;
  while ((offset + 8) <= audio.byteLength) {
    const chunkId = audio.toString("ascii", offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > audio.byteLength) {
      throw new Error("Invalid WAV file: chunk extends past end of file");
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new Error("Invalid WAV file: fmt chunk is too short");
      }
      formatChunk = {
        audioFormat: view.getUint16(chunkStart, true),
        channelCount: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      };
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!formatChunk) {
    throw new Error("Invalid WAV file: missing fmt chunk");
  }
  if (dataOffset < 0 || dataSize < 0) {
    throw new Error("Invalid WAV file: missing data chunk");
  }
  if (formatChunk.channelCount !== 1) {
    throw new Error(`Unsupported WAV channel count: ${String(formatChunk.channelCount)}`);
  }
  if (formatChunk.sampleRate !== 16000) {
    throw new Error(`Unsupported WAV sample rate: ${String(formatChunk.sampleRate)}`);
  }

  const data = audio.subarray(dataOffset, dataOffset + dataSize);
  if (formatChunk.audioFormat === WAVE_FORMAT_PCM && formatChunk.bitsPerSample === 16) {
    return Buffer.from(data);
  }
  if (
    formatChunk.audioFormat === WAVE_FORMAT_IEEE_FLOAT
    && formatChunk.bitsPerSample === 32
  ) {
    return float32ToPcm16(data);
  }

  throw new Error(
    `Unsupported WAV encoding: format=${String(formatChunk.audioFormat)} bits=${String(formatChunk.bitsPerSample)}`,
  );
}

function looksLikeWav(audio: Buffer): boolean {
  return (
    audio.byteLength >= 12
    && audio.toString("ascii", 0, 4) === "RIFF"
    && audio.toString("ascii", 8, 12) === "WAVE"
  );
}

function float32ToPcm16(data: Buffer): Buffer {
  if (data.byteLength % 4 !== 0) {
    throw new Error("Invalid WAV file: float32 data size is misaligned");
  }

  const sampleCount = data.byteLength / 4;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getFloat32(index * 4, true);
    const clamped = Math.max(-1, Math.min(1, sample));
    const scaled = clamped < 0
      ? Math.round(clamped * 0x8000)
      : Math.round(clamped * 0x7fff);
    pcm.writeInt16LE(scaled, index * 2);
  }
  return pcm;
}
