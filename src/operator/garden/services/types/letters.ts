import type { LetterRecord, LetterState } from '../../../../core/letters/contracts.js';

export interface AdminLetterService {
  compose(input: {
    author: 'partner';
    recipient: 'companion';
    subject: string;
    body: string;
    draft?: boolean;
  }): Promise<LetterRecord>;
  list(input: {
    party: 'partner';
    direction?: 'inbox' | 'outbox';
    states?: readonly LetterState[];
    limit?: number;
  }): Promise<LetterRecord[]>;
  read(id: string, reader: 'partner'): Promise<LetterRecord>;
  place(id: string, actor: 'partner'): Promise<LetterRecord>;
  archive(id: string, actor: 'partner'): Promise<LetterRecord>;
  countWaiting(recipient: 'partner'): Promise<number>;
}
