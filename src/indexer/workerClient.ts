import { Worker, MessagePort } from 'node:worker_threads';
import type { Lang } from '../core/types';
import type { IndexOptions } from './indexFile';

// Host-side handle to the indexing worker: promise-based request/response plus
// a progress callback. The host never writes to the DB itself.

export interface WorkerAssets {
  runtimeWasmPath: string;
  grammarPaths: Partial<Record<Lang, string>>;
}

// The slice of the `worker_threads.Worker` surface this client actually drives.
// Narrowing the field to this interface lets tests inject a fake worker (to
// exercise the crash-handling guarantee headlessly) without spawning a real
// thread; production still passes a real `Worker`.
export interface WorkerLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown, transferList?: readonly unknown[]): void;
  terminate(): Promise<number> | number;
}

export interface Progress {
  done: number;
  total: number;
}

interface Pending {
  resolve: (v: ResultMsg) => void;
  reject: (e: Error) => void;
}

interface ResultMsg {
  id: number;
  type: 'result';
  ok: boolean;
  error?: string;
  indexed?: number;
}

abstract class WorkerClientBase {
  protected readonly worker: WorkerLike;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    workerPath: string,
    workerData: any,
    onProgress?: (p: Progress) => void,
    workerOverride?: WorkerLike,
  ) {
    this.worker = workerOverride ?? new Worker(workerPath, { workerData });
    this.worker.on('message', (msg: { type: string; id?: number } & Record<string, unknown>) => {
      if (msg.type === 'progress') {
        onProgress?.({ done: msg.done as number, total: msg.total as number });
        return;
      }
      if (msg.type === 'result' && typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok) {
            p.resolve(msg as unknown as ResultMsg);
          } else {
            p.reject(new Error((msg.error as string) ?? 'worker error'));
          }
        }
      }
    });
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) {
        p.reject(e);
      }
      this.pending.clear();
    });
    this.worker.on('exit', (code) => {
      if (code === 0) return;
      const err = new Error(`worker exited with code ${code}`);
      for (const p of this.pending.values()) {
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  protected req(payload: Record<string, unknown>): Promise<ResultMsg> {
    const id = ++this.seq;
    return new Promise<ResultMsg>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...payload, id });
    });
  }

  connect(port: MessagePort): void {
    this.worker.postMessage({ type: 'connect', port }, [port]);
  }

  async dispose(): Promise<void> {
    try {
      await this.req({ type: 'close' });
    } catch {
      // ignore
    }
    await this.worker.terminate();
  }
}

export class IndexWorker extends WorkerClientBase {
  constructor(
    workerPath: string,
    assets: WorkerAssets,
    options: Partial<IndexOptions> | undefined,
    dbPath: string,
    onProgress?: (p: Progress) => void,
    workerOverride?: WorkerLike,
  ) {
    super(workerPath, { role: 'parser', assets, options, dbPath }, onProgress, workerOverride);
  }

  indexAll(files: string[]): Promise<ResultMsg> {
    return this.req({ type: 'indexAll', files });
  }

  /** Fire-and-forget: ask the worker to stop its in-flight bulk index promptly. */
  cancel(): void {
    this.worker.postMessage({ type: 'cancel' });
  }

  reindex(file: string): Promise<ResultMsg> {
    return this.req({ type: 'reindex', file });
  }

  reindexContent(file: string, text: string, mtime?: number): Promise<ResultMsg> {
    return this.req({ type: 'reindexContent', file, text, mtime });
  }
}

export class WriterClient extends WorkerClientBase {
  constructor(workerPath: string, dbPath: string, onProgress?: (p: Progress) => void) {
    super(workerPath, { role: 'writer', dbPath }, onProgress);
  }

  async flush(): Promise<ResultMsg> {
    return this.req({ type: 'flush' });
  }

  async dropIndexes(): Promise<ResultMsg> {
    return this.req({ type: 'dropIndexes' });
  }

  async createIndexes(): Promise<ResultMsg> {
    return this.req({ type: 'createIndexes' });
  }

  /** Resolve cross-file parent_id for a single re-indexed file's members. */
  async resolveParents(file: string): Promise<ResultMsg> {
    return this.req({ type: 'resolveParents', file });
  }

  /**
   * Resolve cross-file parent_id for several files' members in one round-trip.
   * Used by the incremental (live-index) bulk path, where the name indexes are
   * NOT dropped/recreated, so `createIndexes` (which also resolves parents for the
   * whole table) never runs — we re-point only the files we just changed.
   */
  async resolveParentsFor(files: string[]): Promise<ResultMsg> {
    return this.req({ type: 'resolveParentsMany', files });
  }

  remove(file: string): Promise<ResultMsg> {
    return this.req({ type: 'remove', file });
  }
}
