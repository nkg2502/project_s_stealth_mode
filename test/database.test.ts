/**
 * Storage-layer tests on the LIVE store (`src/store/db.ts`).
 *
 * These were the legacy `SymbolDatabase` tests; re-pointed to the on-disk
 * `node:sqlite` store. The store is fed synthetic `FileIndex` rows through a
 * `createWriter(db)` (the same path the parser workers use) and read back with
 * the live query functions — so this stays a pure storage test, independent of
 * tree-sitter parsing.
 *
 * Cases that exercised the legacy in-memory snapshot mechanics the live store
 * deliberately dropped (save/saveAsync, vacuum/fragmentation, maxDbSizeMB
 * size-guard, needsRebuild, manual begin/rollback) are `it.skip`-ped inline with
 * a one-line reason — they are obsolete by design, not deferred.
 *
 * Run: npm run test:unit
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    openDb,
    createWriter,
    findDefinitions,
    findReferences,
    findCallers,
    findCallees,
    getFileMeta,
    countSymbols,
    searchSymbolNames,
    resolveParentIds,
} from '../src/store/db';
import type { Writer } from '../src/store/db';
import { fuzzyFilterSymbols } from '../src/store/fuzzyMatch';
import type { FileIndex, SymbolRow, CallRow, RefRow, SymbolKind } from '../src/core/types';

// --- synthetic FileIndex builders (no parsing — pure storage rows) ---

function sym(name: string, kind: SymbolKind = 'function', line = 1): SymbolRow {
    return { name, kind, file: '', line, col: 0, endLine: line, endCol: 0, isDefinition: true, source: 'ts' };
}

function callRow(caller: string, callee: string, line = 1): CallRow {
    return { caller, callee, file: '', line, col: 4, source: 'ts' };
}

function refRow(name: string, line = 1): RefRow {
    return { name, file: '', line, col: 0, enclosingFunc: null, isLocal: false, role: 'value', source: 'ts' };
}

function fileIndex(
    file: string,
    opts: { hash?: string; symbols?: SymbolRow[]; calls?: CallRow[]; refs?: RefRow[] } = {},
): FileIndex {
    return {
        file,
        hash: opts.hash ?? '',
        parsedBy: 'ts',
        symbols: opts.symbols ?? [],
        refs: opts.refs ?? [],
        calls: opts.calls ?? [],
        locals: [],
        aliases: [],
    };
}

let TEST_DIR: string;
let dbPath: string;
let db: ReturnType<typeof openDb>;
let writer: Writer;

before(() => {
    TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sintra-dbtest-'));
});

after(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('store/db - basic CRUD', () => {
    beforeEach(() => {
        dbPath = path.join(TEST_DIR, `db-${Math.random().toString(36).slice(2)}.db`);
        db = openDb(dbPath);
        writer = createWriter(db);
    });
    afterEach(() => {
        try { db.close(); } catch { /* ignore */ }
    });

    it('should start with 0 files and 0 symbols', () => {
        assert.equal(getFileMeta(db).size, 0);
        assert.equal(countSymbols(db), 0);
    });

    it('should register a file', () => {
        // The legacy store handed back a numeric file id; the live writer keys
        // files by path (file_id is internal), so we assert the file registered.
        writer.apply(fileIndex('/test/foo.c', { hash: 'h' }), 1000);
        const meta = getFileMeta(db);
        assert.equal(meta.size, 1);
        assert.ok(meta.has('/test/foo.c'));
    });

    it('should store and retrieve mtime', () => {
        writer.apply(fileIndex('/test/foo.c'), 12345.678);
        assert.equal(getFileMeta(db).get('/test/foo.c')?.mtime, 12345.678);
    });

    it('should add symbols and count them', () => {
        writer.apply(fileIndex('/test/foo.c', {
            symbols: [
                sym('funcA', 'function', 10),
                sym('funcB', 'function', 20),
                sym('MyStruct', 'struct', 30),
            ],
        }), 1000);
        assert.equal(countSymbols(db), 3);
    });

    it('persists a function signature / return type / storage and reads them back', () => {
        const fn: SymbolRow = {
            ...sym('foo', 'function', 1),
            signature: 'foo(int a, char *b)',
            returnType: 'int',
            storage: 'static',
        };
        writer.apply(fileIndex('/test/foo.c', { symbols: [fn] }), 1000);
        const hit = findDefinitions(db, 'foo')[0];
        assert.ok(hit, 'foo found');
        assert.equal(hit.signature, 'foo(int a, char *b)');
        assert.equal(hit.returnType, 'int');
        assert.equal(hit.storage, 'static');
        assert.ok(hit.id > 0, 'symbol id is exposed');
    });

    it('resolveParentIds links a field to its owning struct symbol (cross-file)', () => {
        // struct in one file, the field tagged with its owner in another.
        const st: SymbolRow = sym('Rec', 'struct', 1);
        const fld: SymbolRow = { ...sym('val', 'field', 2), scope: 'Rec' };
        writer.apply(fileIndex('/test/types.h', { symbols: [st] }), 1000);
        writer.apply(fileIndex('/test/use.c', { symbols: [fld] }), 1000);
        resolveParentIds(db);
        const struct = findDefinitions(db, 'Rec')[0];
        const field = findDefinitions(db, 'val')[0];
        assert.ok(struct.id > 0);
        assert.equal(field.parentId, struct.id, 'field.parent_id points at the owning struct, across files');
    });

    it('resolveParentIds prefers a struct definition over a same-named typedef', () => {
        const st: SymbolRow = sym('Rec', 'struct', 1);
        const td: SymbolRow = sym('Rec', 'typedef', 5);
        const fld: SymbolRow = { ...sym('val', 'field', 2), scope: 'Rec' };
        writer.apply(fileIndex('/test/t.h', { symbols: [st, td, fld] }), 1000);
        resolveParentIds(db);
        const struct = findDefinitions(db, 'Rec').find((s) => s.kind === 'struct')!;
        const field = findDefinitions(db, 'val')[0];
        assert.equal(field.parentId, struct.id, 'parent is the struct, not the typedef');
    });

    it('should find definitions by name', () => {
        writer.apply(fileIndex('/test/foo.c', {
            symbols: [sym('myFunc', 'function', 10), sym('otherFunc', 'function', 20)],
        }), 1000);
        const results = findDefinitions(db, 'myFunc');
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'myFunc');
        assert.equal(results[0].line, 10);
    });

    it('should remove file and cascade delete symbols and calls', () => {
        writer.apply(fileIndex('/test/foo.c', {
            symbols: [sym('funcA')],
            calls: [callRow('funcA', 'funcB')],
        }), 1000);
        assert.equal(countSymbols(db), 1);

        writer.remove('/test/foo.c');
        assert.equal(getFileMeta(db).size, 0);
        assert.equal(countSymbols(db), 0);
        assert.equal(findCallees(db, 'funcA').length, 0);
    });

    it('should clear all data', () => {
        // Live equivalent of clear() is removing every indexed file.
        writer.apply(fileIndex('/test/a.c', { symbols: [sym('funcA')] }), 1000);
        writer.apply(fileIndex('/test/b.c', { symbols: [sym('funcB')] }), 1000);
        for (const p of getFileMeta(db).keys()) {
            writer.remove(p);
        }
        assert.equal(getFileMeta(db).size, 0);
        assert.equal(countSymbols(db), 0);
    });

    // --- Content hash ---

    it('should store and retrieve content hash', () => {
        writer.apply(fileIndex('/test/foo.c', { hash: 'abc123' }), 1000);
        assert.equal(getFileMeta(db).get('/test/foo.c')?.hash, 'abc123');
    });

    it('should treat a file with no hash as an empty-string hash', () => {
        // The live model always stores a hash string (never null); "no hash" = ''.
        writer.apply(fileIndex('/test/foo.c', { hash: '' }), 1000);
        assert.equal(getFileMeta(db).get('/test/foo.c')?.hash, '');
    });

    it('should update content hash on re-index', () => {
        writer.apply(fileIndex('/test/foo.c', { hash: 'hash1' }), 1000);
        writer.apply(fileIndex('/test/foo.c', { hash: 'hash2' }), 2000);
        const meta = getFileMeta(db).get('/test/foo.c');
        assert.equal(meta?.hash, 'hash2');
        assert.equal(meta?.mtime, 2000);
        // Should still be 1 file
        assert.equal(getFileMeta(db).size, 1);
    });

    // --- Transactions ---

    it('should apply a batch of files in one transaction', () => {
        writer.applyBatch([
            { fi: fileIndex('/test/a.c', { symbols: [sym('funcA')] }), mtime: 1000 },
            { fi: fileIndex('/test/b.c', { symbols: [sym('funcB')] }), mtime: 1000 },
        ]);
        assert.equal(getFileMeta(db).size, 2);
        assert.equal(countSymbols(db), 2);
    });

    it.skip('should rollback a transaction', () => {
        // obsolete: the live writer wraps every apply/applyBatch/remove in one
        // BEGIN/COMMIT (ROLLBACK on throw); there is no user-facing begin/rollback.
    });
});

describe('store/db - calls and references', () => {
    beforeEach(() => {
        dbPath = path.join(TEST_DIR, `db-${Math.random().toString(36).slice(2)}.db`);
        db = openDb(dbPath);
        writer = createWriter(db);
    });
    afterEach(() => {
        try { db.close(); } catch { /* ignore */ }
    });

    it('should store and find callees', () => {
        writer.apply(fileIndex('/test/foo.c', {
            calls: [callRow('main', 'funcA', 10), callRow('main', 'funcB', 20)],
        }), 1000);
        const callees = findCallees(db, 'main');
        assert.equal(callees.length, 2);
        const names = callees.map(c => c.callee).sort();
        assert.deepEqual(names, ['funcA', 'funcB']);
    });

    it('should store and find callers', () => {
        writer.apply(fileIndex('/test/foo.c', {
            calls: [callRow('funcA', 'helper', 10), callRow('funcB', 'helper', 20)],
        }), 1000);
        const callers = findCallers(db, 'helper');
        assert.equal(callers.length, 2);
    });

    // --- Save / SaveAsync (obsolete: live store is always on-disk) ---

    it.skip('should save to disk synchronously', () => {
        // obsolete: the live store is on-disk node:sqlite with no in-memory
        // snapshot, so there is no save() flush step (see persist/reload below).
    });

    it.skip('should save to disk asynchronously', () => {
        // obsolete: no saveAsync()/.tmp-rename snapshot model on the live store.
    });

    it('should persist and reload data across connections', () => {
        const p = path.join(TEST_DIR, 'persist.db');
        const dbA = openDb(p);
        const writerA = createWriter(dbA);
        writerA.apply(fileIndex('/test/foo.c', {
            hash: 'hash1',
            symbols: [sym('myFunc', 'function', 42)],
        }), 1000);
        dbA.close();

        // Reopen the same on-disk file in a fresh connection.
        const dbB = openDb(p);
        assert.equal(getFileMeta(dbB).size, 1);
        assert.equal(countSymbols(dbB), 1);
        assert.equal(getFileMeta(dbB).get('/test/foo.c')?.hash, 'hash1');
        const defs = findDefinitions(dbB, 'myFunc');
        assert.equal(defs.length, 1);
        assert.equal(defs[0].line, 42);
        dbB.close();
    });

    // --- Workspace symbols / references ---

    it('should find workspace symbols by partial name', () => {
        // F10 search: SQLite candidate fetch (searchSymbolNames, subsequence LIKE)
        // + JS fzf rank (fuzzyFilterSymbols). No in-memory name index.
        writer.apply(fileIndex('/test/foo.c', {
            symbols: [
                sym('processData', 'function', 10),
                sym('processImage', 'function', 20),
                sym('handleEvent', 'function', 30),
            ],
        }), 1000);
        const results = fuzzyFilterSymbols(searchSymbolNames(db, 'process'), 'process', 100);
        assert.equal(results.length, 2);
        assert.ok(results.every((r) => r.item.name.startsWith('process')));
    });

    it('searchSymbolNames matches a subsequence, filters by kind, escapes LIKE metachars, and excludes empty names', () => {
        writer.apply(fileIndex('/test/bar.c', {
            symbols: [
                sym('fooBar', 'function', 1),
                sym('food', 'function', 2),
                sym('FB_MACRO', 'macro', 3),
                sym('a_b', 'global_variable', 4),
                sym('axb', 'global_variable', 5),
                sym('', 'function', 6),
            ],
        }), 1000);
        // subsequence: "fb" hits fooBar and FB_MACRO (case-insensitive), not food.
        const fb = searchSymbolNames(db, 'fb').map((r) => r.name).sort();
        assert.deepEqual(fb, ['FB_MACRO', 'fooBar']);
        // kind filter restricts to the requested kinds.
        const fbFns = searchSymbolNames(db, 'fb', { kinds: ['function'] }).map((r) => r.name);
        assert.deepEqual(fbFns, ['fooBar']);
        // '_' is a LIKE wildcard but must be treated literally: "a_b" matches a_b only.
        const underscore = searchSymbolNames(db, 'a_b').map((r) => r.name);
        assert.deepEqual(underscore, ['a_b']);
        // empty-name rows are never returned; empty term yields no candidates.
        assert.ok(searchSymbolNames(db, 'foo').every((r) => r.name !== ''));
        assert.equal(searchSymbolNames(db, '').length, 0);
    });

    it('should find references (recorded usage occurrences)', () => {
        // The live store separates references (usage occurrences in the `refs`
        // table) from definitions and call edges; findReferences returns the
        // recorded reference occurrences for a global symbol.
        writer.apply(fileIndex('/test/foo.c', {
            refs: [refRow('helper', 10), refRow('helper', 12)],
        }), 1000);
        const refs = findReferences(db, 'helper');
        assert.equal(refs.length, 2);
    });

    // --- getAllFiles ---

    it('should list all files', () => {
        writer.apply(fileIndex('/test/a.c'), 100);
        writer.apply(fileIndex('/test/b.c'), 200);
        writer.apply(fileIndex('/test/c.c'), 300);
        assert.equal(getFileMeta(db).size, 3);
    });

    // --- Schema rebuild detection ---

    it.skip('should detect needsRebuild on fresh DB', () => {
        // obsolete: rebuild is schema-version driven (PRAGMA user_version via
        // ensureSchema), not a per-instance needsRebuild flag.
    });

    // --- Batch transaction performance ---

    it('should handle large batch inserts within a transaction', () => {
        const COUNT = 200;
        const batch: { fi: FileIndex; mtime: number }[] = [];
        for (let i = 0; i < COUNT; i++) {
            batch.push({
                fi: fileIndex(`/test/file_${i}.c`, {
                    hash: `hash_${i}`,
                    symbols: [
                        sym(`func_${i}_a`, 'function', i * 10),
                        sym(`func_${i}_b`, 'function', i * 10 + 5),
                    ],
                }),
                mtime: 1000 + i,
            });
        }
        writer.applyBatch(batch);

        assert.equal(getFileMeta(db).size, COUNT);
        assert.equal(countSymbols(db), COUNT * 2);
    });
});

// The legacy size-guard and vacuum/fragmentation mechanics are obsolete by
// design: the live store is a recreatable on-disk cache, rebuilt on schema-version
// mismatch (not byte size), with no vacuum/fragmentation API and synchronous=OFF
// for bulk-insert speed. The cases are preserved (skipped) below.

describe('store/db - size guard (obsolete)', () => {
    it.skip('should delete and rebuild when DB exceeds maxDbSizeMB', () => {
        // obsolete: no maxDbSizeMB guard — a stale cache is dropped/rebuilt by
        // schema version, not by file size.
    });
    it.skip('should keep DB when file is within maxDbSizeMB limit', () => {
        // obsolete: no maxDbSizeMB guard.
    });
    it.skip('should use default 1024 MiB limit when not specified', () => {
        // obsolete: no maxDbSizeMB guard / default limit.
    });
});

describe('store/db - vacuum (obsolete)', () => {
    it.skip('should run vacuum without error on a valid DB', () => {
        // obsolete: the live store exposes no vacuum() API.
    });
    it.skip('should reduce file size after bulk delete + vacuum', () => {
        // obsolete: no vacuum() API.
    });
    it.skip('should not throw on vacuum of empty DB', () => {
        // obsolete: no vacuum() API.
    });
    it.skip('should return 0 fragmentation ratio on fresh DB', () => {
        // obsolete: no getFragmentationRatio() API.
    });
    it.skip('should report high fragmentation after bulk delete', () => {
        // obsolete: no getFragmentationRatio() API.
    });
});
