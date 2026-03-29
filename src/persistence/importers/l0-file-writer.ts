import {
  createFilesystemSessionArchivePort,
  type RawL0MessageInput,
  type WriteL0SessionFileOptions,
  type WrittenL0SessionFile,
} from '../journals/journal/port.js';

export type {
  RawL0MessageInput,
  WriteL0SessionFileOptions,
  WrittenL0SessionFile,
};

export function writeL0SessionFile(
  options: WriteL0SessionFileOptions,
): WrittenL0SessionFile {
  return createFilesystemSessionArchivePort().writeImportedSession(options);
}
