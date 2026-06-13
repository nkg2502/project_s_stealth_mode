import { parentPort, workerData, MessagePort } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Lang, FileIndex } from '../core/types';
import { configureAssets, disposeParsers, initParser, langForExt } from './parser';
import { DEFAULT_INDEX_OPTIONS, indexFile } from './indexFile';
import type { IndexOptions } from './indexFile';
import { createWriter, openDb, DROP_INDEXES, CREATE_INDEXES, resolveParentIds } from '../store/db';
import type { DatabaseSync } from 'node:sqlite';

interface WorkerInit {
  role: 'writer' | 'parser';
  dbPath?: string;
  assets?: { runtimeWasmPath: string; grammarPaths: Partial<Record<Lang, string>> };
  options?: Partial<IndexOptions>;
}

const init = workerData as WorkerInit;
const port = parentPort;
if (!port) {
  throw new Error('worker.ts must run as a worker thread');
}

if (init.role === 'writer') {
  const db: DatabaseSync = openDb(init.dbPath!);
  const writer = createWriter(db);

  let batch: { fi: FileIndex; mtime: number; port?: MessagePort }[] = [];
  let batchTimeout: NodeJS.Timeout | null = null;

  function flushBatch() {
    if (batch.length === 0) return;
    const copy = batch;
    batch = [];
    writer.applyBatch(copy);
    const count = copy.length;
    for (const b of copy) {
      if (b.port) b.port.postMessage({ type: 'ack' });
    }
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchTimeout = null;
    }
    port!.postMessage({ type: 'progress', done: count });
  }

  port.on('message', (msg: any) => {
    try {
      if (msg.type === 'connect' && msg.port) {
        const p = msg.port as MessagePort;
        p.on('message', (pmsg: any) => {
          if (pmsg.type === 'apply') {
            batch.push({ fi: pmsg.fi, mtime: pmsg.mtime, port: p });
            if (batch.length >= 50) flushBatch();
            else if (!batchTimeout) batchTimeout = setTimeout(flushBatch, 50);
          }
        });
      } else if (msg.type === 'remove') {
        flushBatch();
        if (msg.file) writer.remove(msg.file);
        port.postMessage({ id: msg.id, type: 'result', ok: true });
      } else if (msg.type === 'flush') {
        flushBatch();
        port.postMessage({ id: msg.id, type: 'result', ok: true });
      } else if (msg.type === 'dropIndexes') {
        try {
          db.exec(DROP_INDEXES);
          port!.postMessage({ id: msg.id, type: 'result', ok: true });
        } catch (e) {
          port!.postMessage({ id: msg.id, type: 'result', ok: false, error: (e as Error).message });
        }
      } else if (msg.type === 'createIndexes') {
        try {
          db.exec(CREATE_INDEXES);
          // Resolve cross-file parent_id now that the name index exists and every
          // symbol is inserted (the bulk insert dropped the name index, so this must
          // run here, not per-file during the scan).
          resolveParentIds(db);
          port!.postMessage({ id: msg.id, type: 'result', ok: true });
        } catch (e) {
          port!.postMessage({ id: msg.id, type: 'result', ok: false, error: (e as Error).message });
        }
      } else if (msg.type === 'resolveParents') {
        // Incremental: re-point a single re-indexed file's members to their owners.
        try {
          flushBatch();
          resolveParentIds(db, msg.file);
          port!.postMessage({ id: msg.id, type: 'result', ok: true });
        } catch (e) {
          port!.postMessage({ id: msg.id, type: 'result', ok: false, error: (e as Error).message });
        }
      } else if (msg.type === 'resolveParentsMany') {
        // Incremental bulk (live-index path): re-point several files' members.
        try {
          flushBatch();
          for (const f of (msg.files ?? []) as string[]) {
            resolveParentIds(db, f);
          }
          port!.postMessage({ id: msg.id, type: 'result', ok: true });
        } catch (e) {
          port!.postMessage({ id: msg.id, type: 'result', ok: false, error: (e as Error).message });
        }
      } else if (msg.type === 'close') {
        flushBatch();
        db.close();
        port.postMessage({ id: msg.id, type: 'result', ok: true });
      }
    } catch (e) {
      port.postMessage({ id: msg.id, type: 'result', ok: false, error: (e as Error).message });
    }
  });
} else {
  // Parser mode
  const opts: IndexOptions = { ...DEFAULT_INDEX_OPTIONS, ...(init.options ?? {}) };
  let writerPort: MessagePort | null = null;
  let inFlight = 0;
  let waitResolve: (() => void) | null = null;
  // Set by a 'cancel' message; checked at each file boundary so a superseded bulk
  // index (e.g. after an include/exclude change) stops promptly. Reset when a new
  // indexAll begins.
  let canceled = false;

  const ready = (async () => {
    configureAssets({
      runtimeWasmPath: init.assets!.runtimeWasmPath,
      grammarPaths: init.assets!.grammarPaths,
    });
    await initParser();
  })();

  async function indexOne(file: string): Promise<void> {
    let text: string;
    let mtime: number;
    try {
      text = fs.readFileSync(file, 'utf8');
      mtime = Math.floor(fs.statSync(file).mtimeMs);
    } catch {
      return; // unreadable / deleted between enumeration and indexing
    }
    const lang = langForExt(path.extname(file));
    const fi = await indexFile(file, text, lang, opts);
    if (writerPort) {
      writerPort.postMessage({ type: 'apply', fi, mtime });
      inFlight++;
      if (inFlight >= 50) {
        await new Promise<void>((resolve) => {
          waitResolve = resolve;
        });
      }
    }
  }

  port.on('message', async (msg: any) => {
    if (msg.type === 'connect' && msg.port) {
      writerPort = msg.port as MessagePort;
      writerPort.on('message', (pmsg: any) => {
        if (pmsg.type === 'ack') {
          inFlight--;
          if (inFlight < 50 && waitResolve) {
            waitResolve();
            waitResolve = null;
          }
        }
      });
      return;
    }

    // Cancel is fire-and-forget (no id): flag it so the in-flight indexAll loop
    // breaks at the next file boundary.
    if (msg.type === 'cancel') {
      canceled = true;
      return;
    }

    await ready;
    try {
      switch (msg.type) {
        case 'indexAll': {
          const files = msg.files ?? [];
          canceled = false; // fresh run — clear any stale cancel from a prior one
          for (const f of files) {
            if (canceled) break;
            await indexOne(f);
          }
          port.postMessage({ id: msg.id, type: 'result', ok: true, indexed: files.length });
          break;
        }
        case 'reindex': {
          if (msg.file) {
            await indexOne(msg.file);
          }
          port.postMessage({ id: msg.id, type: 'result', ok: true });
          break;
        }
        case 'reindexContent': {
          if (msg.file && typeof msg.text === 'string') {
            const lang = langForExt(path.extname(msg.file));
            const fi = await indexFile(msg.file, msg.text, lang, opts);
            if (writerPort) {
              writerPort.postMessage({ type: 'apply', fi, mtime: msg.mtime ?? Date.now() });
            }
          }
          port.postMessage({ id: msg.id, type: 'result', ok: true });
          break;
        }
        case 'close': {
          disposeParsers();
          if (writerPort) {
            writerPort.close();
          }
          port.postMessage({ id: msg.id, type: 'result', ok: true });
          break;
        }
      }
    } catch (e) {
      port.postMessage({ id: msg.id, type: 'result', ok: false, error: (e as Error).message });
    }
  });
}
