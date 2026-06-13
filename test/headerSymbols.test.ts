/**
 * Code Insight HEADER symbol resolution (features/symbolResolve.ts:resolvedSymbolsAt).
 * The header shows the kind list + function signature of the symbol under the cursor.
 * It must resolve like F12 (role + member narrowing + self-guard), NOT a bare
 * whole-codebase name match — which conflated unrelated same-named symbols (the
 * `data2 (field, global_variable)` header bug behind the `le16` Type screenshot).
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolvedSymbolsAt } from '../src/features/symbolResolve';
import { findSymbols } from '../src/store/db';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('Code Insight header symbols (resolvedSymbolsAt)', () => {
    let store: LiveStore;
    before(async () => {
        await setupLiveParser();
    });
    beforeEach(() => {
        store = openLiveStore();
    });
    afterEach(() => {
        store.close();
    });

    it('a function-pointer field resolves to ONLY its field, not a same-named global or a different struct', async () => {
        await store.index('/g.c', 'le16 data2;'); // unrelated global_variable named data2
        await store.index('/other.h', 'struct other { int data2; };'); // unrelated field data2
        const FILE = '/pq.h';
        const code = [
            'struct parity_calc_table {',
            '  void (*data2)(int, size_t);',
            '};',
        ].join('\n');
        await store.index(FILE, code);
        const col = code.split('\n')[1].indexOf('data2');

        // Old, name-only path (what the header used to do) conflated everything:
        const oldKinds = [...new Set(findSymbols(store.db, 'data2').map((h) => h.kind))].sort();
        assert.deepEqual(oldKinds, ['field', 'global_variable'], 'name-only match conflated both kinds (the bug)');

        // F12-consistent resolution: a `field` token at the cursor → only the field
        // of THIS struct, never the same-named global or another struct's field.
        const hits = resolvedSymbolsAt(store.db, 'data2', 'field', FILE, 1, { enclosingFunc: null }, false);
        const kinds = [...new Set(hits.map((h) => h.kind))].sort();
        assert.deepEqual(kinds, ['field'], 'header lists only field');
        assert.ok(hits.every((h) => h.file === FILE && h.line === 1), 'and only the field under the cursor');
        assert.equal(col, 9); // sanity: data2 starts at col 9 on line 1
    });

    it('a call site resolves to the function defined elsewhere (def + prototype kinds)', async () => {
        const FILE = '/c.c';
        const code = [
            'int runTask(int a);',          // line 0 prototype
            'int runTask(int a) { return a; }', // line 1 definition
            'void g(void) { runTask(1); }', // line 2 call site
        ].join('\n');
        await store.index(FILE, code);
        const callCol = code.split('\n')[2].indexOf('runTask');
        const hits = resolvedSymbolsAt(store.db, 'runTask', 'value', FILE, 2, { enclosingFunc: 'g' }, false, 1);
        const kinds = [...new Set(hits.map((h) => h.kind))].sort();
        assert.deepEqual(kinds, ['function', 'prototype'], 'call site denotes the function + its prototype');
        assert.ok(callCol > 0);
    });
});
