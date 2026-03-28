export interface FilesystemReadOperations {
  read(path: string): Promise<string>;
  list(glob?: string, maxEntries?: number): Promise<string[]>;
}
