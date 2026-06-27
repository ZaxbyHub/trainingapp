import Dexie, { type Table } from 'dexie';
import type { Conversation } from './conversations';

export class DocQADatabase extends Dexie {
  conversations!: Table<Conversation, string>;

  constructor() {
    super('docqa_conversations');
    this.version(1).stores({
      conversations: 'id, updatedAt, createdAt, title'
    });
  }
}

export const db = new DocQADatabase();