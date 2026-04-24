import type { PostgresContactStore } from './store.js';

export type PostgresContactOperationMap = ThisType<PostgresContactStore> & Record<string, (...args: any[]) => unknown>;

