import * as vscode from 'vscode';
import { openDb } from '../store/db';
import { IndexGate } from './indexGate';
import type { WorkerPool } from '../indexer/workerPool';

// Shared host-side state: a lazily-opened read-only DB connection (WAL lets it
// see the worker's commits). All symbol data lives in SQLite — F10 queries it
// directly (no parallel in-memory name list).

export class Host {
  // Lets navigation queries briefly wait out an in-flight reindex (see indexGate).
  readonly indexing = new IndexGate();
  // True while a full/bulk workspace scan is running. During a bulk scan the name
  // indexes are dropped (drop/create bulk strategy) and the writer holds the DB,
  // so ANY host-side read would degrade to a multi-million-row full scan that
  // blocks the synchronous host thread. We therefore serve no host reads during a
  // bulk scan (getDb returns undefined) — F12/F10/Definition/Reference all abstain
  // and resume automatically when the scan finishes. Set from extension.ts.
  bulkIndexing = false;
  worker: WorkerPool | undefined;
  private db: ReturnType<typeof openDb> | undefined;

  constructor(
    readonly dbPath: string,
    readonly output: vscode.OutputChannel,
  ) {}

  /**
   * Read-only connection; undefined until the worker has created the DB, and
   * also undefined while a bulk scan runs (see `bulkIndexing`) so the host does
   * zero DB reads during a full scan — every navigation path abstains rather than
   * full-scanning the unindexed, write-locked tables and freezing the host thread.
   */
  getDb(): ReturnType<typeof openDb> | undefined {
    if (this.bulkIndexing) {
      return undefined;
    }
    if (!this.db) {
      try {
        this.db = openDb(this.dbPath, { readonly: true });
      } catch {
        return undefined;
      }
    }
    return this.db;
  }

  closeDb(): void {
    this.db?.close();
    this.db = undefined;
  }
}
