import { MessageChannel } from 'node:worker_threads';
import { IndexWorker, WriterClient } from './workerClient';
import type { Progress, WorkerAssets } from './workerClient';
import type { IndexOptions } from './indexFile';

// A pool of indexing workers using a Producer-Consumer pattern.
// Parsing (tree-sitter) is the CPU-bound cost, scaled across 'size' Parser Workers.
// The DB write is handled by a single dedicated Writer Worker to avoid SQLite
// WAL lock contention. Parsers send their results directly to the Writer via
// MessagePorts.

function shardRoundRobin<T>(items: T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  for (let i = 0; i < items.length; i++) {
    out[i % buckets].push(items[i]);
  }
  return out;
}

export class WorkerPool {
  private readonly workers: IndexWorker[] = [];
  private readonly writer: WriterClient;
  private totalFiles = 0;
  private writtenFiles = 0;
  private rr = 0;

  /** Aggregate progress (summed across active workers). Set by the caller. */
  onProgress?: (p: Progress) => void;

  /**
   * Coarse phase label for the post-parse finalize step (flush + index rebuild),
   * which has no per-file progress but can take a while on a large workspace. Set
   * by the caller so the UI can explain the wait instead of looking frozen.
   */
  onPhase?: (label: string) => void;

  constructor(
    private readonly workerPath: string,
    private readonly dbPath: string,
    private readonly assets: WorkerAssets,
    private readonly options: Partial<IndexOptions> | undefined,
    private readonly size: number,
  ) {
    this.writer = new WriterClient(this.workerPath, this.dbPath, (p) => {
      this.writtenFiles += p.done;
      if (this.onProgress && this.totalFiles > 0) {
        this.onProgress({ done: this.writtenFiles, total: this.totalFiles });
      }
    });
  }

  private spawn(): void {
    const worker = new IndexWorker(this.workerPath, this.assets, this.options, this.dbPath);

    // Wire up direct communication from parser to writer
    const { port1, port2 } = new MessageChannel();
    worker.connect(port1);
    this.writer.connect(port2);

    this.workers.push(worker);
  }

  private ensure(n: number): IndexWorker[] {
    const want = Math.min(Math.max(n, 1), this.size);
    while (this.workers.length < want) {
      this.spawn();
    }
    return this.workers;
  }

  private emit(): void {
    if (!this.onProgress || this.totalFiles === 0) {
      return;
    }
    this.onProgress({ done: this.writtenFiles, total: this.totalFiles });
  }

  /**
   * Ask every parser to stop its in-flight bulk index at the next file boundary.
   * Used to supersede a running `indexAll` when include/exclude changes or a
   * rescan is requested, so the old run stops instead of running concurrently.
   */
  cancel(): void {
    for (const w of this.workers) {
      w.cancel();
    }
  }

  /** Round-robin a single-file op to a live worker (spawning one if needed). */
  private pick(): IndexWorker {
    const ws = this.ensure(1);
    return ws[this.rr++ % ws.length];
  }

  /**
   * Bulk index: shard across the pool and parse in parallel.
   *
   * `rebuildIndexes` (default true) selects the index strategy. The drop/recreate
   * dance only pays off for a from-scratch build (first index / full Rescan): drop
   * the name indexes, bulk-insert, then rebuild once. For a *small* incremental run
   * (e.g. an include/exclude tweak on a warm DB) pass `false` — the existing index
   * is reused: the name indexes stay LIVE (inserting a handful of files maintains
   * them cheaply), so we skip the multi-million-row rebuild that would otherwise
   * make a tiny change feel like a full rescan. The whole-table parent resolution
   * `createIndexes` does is then replaced by a scoped re-point of just these files.
   */
  async indexAll(files: string[], opts?: { rebuildIndexes?: boolean }): Promise<void> {
    if (!files.length) {
      return;
    }
    const rebuildIndexes = opts?.rebuildIndexes ?? true;
    this.totalFiles = files.length;
    this.writtenFiles = 0;

    const ws = this.ensure(files.length);
    const shards = shardRoundRobin(files, ws.length);
    this.emit();

    const startParse = performance.now();
    if (rebuildIndexes) {
      try {
        await this.writer.dropIndexes();
        console.log('Indexes dropped successfully');
      } catch (e) {
        console.error('Failed to drop indexes:', e);
      }
    }

    await Promise.all(
      ws.map(async (w, i) => {
        if (shards[i].length) {
          await w.indexAll(shards[i]);
        }
      })
    );
    console.log(`Parsing took ${(performance.now() - startParse).toFixed(2)}ms`);

    const startMerge = performance.now();
    if (rebuildIndexes) {
      // Parsing is done; the remaining work (flush the last batch + build the
      // dropped name indexes) has no per-file progress and can take a while.
      this.onPhase?.('building search index…');
      await this.writer.flush();
      try {
        await this.writer.createIndexes();
        console.log('Indexes created successfully');
      } catch (e) {
        console.error('Failed to create indexes:', e);
      }
    } else {
      // Live-index path: indexes stayed in place (inserts maintained them); just
      // flush the last batch and re-point only the touched files' members to their
      // owners (createIndexes does this table-wide; here we scope it).
      await this.writer.flush();
      await this.writer.resolveParentsFor(files);
    }
    console.log(`Writing took ${(performance.now() - startMerge).toFixed(2)}ms`);
  }

  async reindex(file: string): Promise<unknown> {
    await this.pick().reindex(file);
    await this.writer.flush();
    return this.writer.resolveParents(file);
  }

  async reindexContent(file: string, text: string, mtime?: number): Promise<unknown> {
    await this.pick().reindexContent(file, text, mtime);
    await this.writer.flush();
    return this.writer.resolveParents(file);
  }

  remove(file: string): Promise<unknown> {
    // Remove goes directly to the writer; no parsing needed.
    return this.writer.remove(file);
  }

  async dispose(): Promise<void> {
    await Promise.all([
      ...this.workers.map((w) => w.dispose()),
      this.writer.dispose()
    ]);
    this.workers.length = 0;
  }
}
