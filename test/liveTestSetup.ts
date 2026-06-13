// Shared setup for headless (`node --test`) unit tests that exercise the LIVE
// indexing path (indexer/ -> store/ -> features/). NOT a test file itself (no
// `.test.ts` suffix), so the `out/test/**/*.test.js` runner skips it.
//
// It points web-tree-sitter at the node_modules wasm (the same assets test/run.ts
// uses) and opens throwaway on-disk SQLite stores for the live store/db.ts layer.

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { configureAssets, initParser } from '../src/indexer/parser';
import { openDb, createWriter, resolveParentIds } from '../src/store/db';
import type { Writer } from '../src/store/db';
import { indexFile } from '../src/indexer/indexFile';
import type { FileIndex, Lang } from '../src/core/types';

export const ROOT = path.join(__dirname, '..', '..');

type DB = ReturnType<typeof openDb>;

let parserConfigured = false;

/**
 * Configure the web-tree-sitter wasm assets and initialise the parser.
 * Idempotent — safe to call from every suite's `before()`.
 */
export async function setupLiveParser(): Promise<void> {
  if (!parserConfigured) {
    configureAssets({
      runtimeWasmPath: path.join(ROOT, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
      grammarPaths: {
        c: path.join(ROOT, 'node_modules', 'tree-sitter-c', 'tree-sitter-c.wasm'),
        cpp: path.join(ROOT, 'node_modules', 'tree-sitter-cpp', 'tree-sitter-cpp.wasm'),
      },
    });
    parserConfigured = true;
  }
  await initParser();
}

export interface LiveStore {
  db: DB;
  writer: Writer;
  /** Index `text` (tree-sitter, grep fallback) and persist it under `file`. */
  index(file: string, text: string, lang?: Lang): Promise<FileIndex>;
  close(): void;
}

/**
 * Open a fresh throwaway on-disk SQLite store (schema created by `openDb`) wired
 * to a live writer, plus an `index()` helper that runs the live `indexFile` and
 * applies the result. Each call creates a unique temp DB; `close()` disposes and
 * deletes it.
 */
export function openLiveStore(): LiveStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sintra-livetest-'));
  const dbPath = path.join(dir, 'index.db');
  const db = openDb(dbPath);
  const writer = createWriter(db);

  return {
    db,
    writer,
    async index(file: string, text: string, lang: Lang = 'c'): Promise<FileIndex> {
      const idx = await indexFile(file, text, lang);
      writer.applyBatch([{ fi: idx, mtime: 1 }]);
      // Mirror the live incremental path: resolve cross-file parent_id for this file
      // (the bulk path does it post-rebuild; here the indexes already exist).
      resolveParentIds(db, file);
      return idx;
    },
    close(): void {
      try { db.close(); } catch { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ---- live Go-to-Definition driver (features/resolve.ts) ----
//
// resolve.ts does `import * as vscode from 'vscode'`, which doesn't exist under
// `node --test`. We stub the bare module while requiring resolve.ts so its
// vscode-free path (resolveDefinition) is reachable; resolveDefinition itself
// never touches the vscode API (only resolveReferences does).

export type PositionLike = { line: number; character: number };

/** Run `fn` with the bare `'vscode'` module stubbed to `{}`. */
export function withVscodeStub<T>(fn: () => T): T {
  const moduleApi = require('module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = moduleApi._load;
  moduleApi._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
      return {};
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    moduleApi._load = original;
  }
}

/** A minimal vscode.TextDocument-like double over a multi-line source string. */
export function makeDoc(filePath: string, source: string) {
  const lines = source.split('\n');
  return {
    uri: { fsPath: filePath },
    lineAt: (n: number) => ({ text: lines[n] ?? '' }),
    getWordRangeAtPosition: (pos: PositionLike, regex: RegExp) => {
      const lineText = lines[pos.line] ?? '';
      const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = g.exec(lineText)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (pos.character >= start && pos.character < end) {
          return { start: { line: pos.line, character: start }, end: { line: pos.line, character: end } };
        }
      }
      return undefined;
    },
    getText: (range?: { start: PositionLike; end: PositionLike }): string => {
      if (!range) {
        return source;
      }
      if (range.start.line === range.end.line) {
        return (lines[range.start.line] ?? '').slice(range.start.character, range.end.character);
      }
      return source;
    },
  };
}

export interface ResolvedLike {
  word: string;
  hits: { file: string; line: number; col: number; kind: string; name: string }[];
  blocked?: boolean;
}

/**
 * Drive the live `resolveDefinition` (F12) over `db` for the cursor at
 * (`line`,`character`) in `source` saved as `filePath`. Returns the live
 * `Resolved` shape (or undefined when the cursor is on a keyword/no word).
 */
export function resolveDefinitionAt(
  db: ReturnType<typeof openDb>,
  filePath: string,
  source: string,
  line: number,
  character: number,
): ResolvedLike | undefined {
  return withVscodeStub(() => {
    const { resolveDefinition } = require('../src/features/resolve') as {
      resolveDefinition: (db: unknown, doc: unknown, pos: PositionLike) => ResolvedLike | undefined;
    };
    return resolveDefinition(db, makeDoc(filePath, source), { line, character });
  });
}
