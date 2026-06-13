/**
 * Code Insight "Symbol" category resolver (features/symbolInfo.ts) on the LIVE
 * path. Given the symbol under the cursor it returns a rich summary — humanized
 * kind, declared type / function signature, storage class, and jump-able
 * definition/declaration locations — all as SQLite point queries (vscode-free).
 *
 * The motivating repro: `parity_2data_op` is a function-pointer global whose
 * Code Insight header used to show only `parity_2data_op (global_variable)`.
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveSymbolInfo } from '../src/features/symbolInfo';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('Symbol info resolver (resolveSymbolInfo)', () => {
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

    it('summarizes a function-pointer global variable (the parity_2data_op repro)', async () => {
        const FILE = '/parity.c';
        const code = [
            'void (*parity_2data_op)(int, size_t, int, int, void **);', // line 0 (definition)
            'void caller(void) { parity_2data_op(1, 2, 3, 4, 0); }',     // line 1 (a use)
        ].join('\n');
        await store.index(FILE, code);
        const useCol = code.split('\n')[1].indexOf('parity_2data_op');
        const info = resolveSymbolInfo(store.db, { name: 'parity_2data_op', file: FILE, line: 1, col: useCol });

        assert.ok(info.found, 'resolves to an indexed symbol');
        assert.equal(info.name, 'parity_2data_op');
        assert.equal(info.kindLabel, 'global variable', 'kind is humanized');

        const kind = info.rows.find((r) => r.label === 'Kind');
        assert.equal(kind?.value, 'global variable');

        // The declared type now lives in the dedicated "Type" category (resolver
        // covered by typeInfo.test.ts), not the Symbol summary — so to avoid a
        // duplicate row the summary no longer carries a Type row.
        assert.ok(!info.rows.some((r) => r.label === 'Type'), 'type moved to the Type category');

        const def = info.rows.find((r) => r.label === 'Defined in');
        assert.ok(def, 'has a definition jump row');
        assert.equal(def!.line, 0, 'points at the definition line');
        assert.equal(def!.file, FILE);
    });

    it('summarizes a function: humanized kind + full signature + definition location', async () => {
        const FILE = '/fn.c';
        const code = [
            'static int foo(int a, char *b) { return a; }', // line 0
            'void g(void) { foo(1, "x"); }',                // line 1 (a call)
        ].join('\n');
        await store.index(FILE, code);
        const callCol = code.split('\n')[1].indexOf('foo');
        const info = resolveSymbolInfo(store.db, { name: 'foo', file: FILE, line: 1, col: callCol, callArity: 2 });

        assert.ok(info.found);
        assert.equal(info.kindLabel, 'function');
        const sig = info.rows.find((r) => r.label === 'Signature');
        assert.ok(sig, 'has a Signature row');
        assert.equal(sig!.value, 'static int foo(int a, char *b)', 'storage + return type + declarator');
        // A function has no "Type" row (that is for typed variables/fields).
        assert.ok(!info.rows.some((r) => r.label === 'Type'));
        const def = info.rows.find((r) => r.label === 'Defined in');
        assert.equal(def?.line, 0);
    });

    it('summarizes a parameter from the locals table, scoped to its function', async () => {
        const FILE = '/p.c';
        const code = [
            'struct mgr_state { int x; };',    // line 0
            'void f(struct mgr_state *rsp) {', // line 1 (rsp param)
            '\trsp->x;',                       // line 2 (rsp use at col 1)
            '}',                               // line 3
        ].join('\n');
        await store.index(FILE, code);
        const info = resolveSymbolInfo(store.db, { name: 'rsp', file: FILE, line: 2, col: 1 });

        assert.ok(info.found);
        assert.equal(info.kindLabel, 'parameter');
        assert.equal(info.rows.find((r) => r.label === 'Kind')?.value, 'parameter');
        // The declared type is shown by the dedicated "Type" category (which resolves
        // locals too), not the Symbol summary — no duplicate Type row here.
        assert.ok(!info.rows.some((r) => r.label === 'Type'));
        const decl = info.rows.find((r) => r.label === 'Declared in');
        assert.equal(decl?.line, 1, 'declared on the parameter line');
        // A local/parameter never lists a separate "Defined in" / "Declared in" global row.
        assert.ok(!info.rows.some((r) => r.label === 'Defined in'));
    });

    it('reports not-found for a word that resolves to no indexed symbol', async () => {
        const FILE = '/n.c';
        await store.index(FILE, 'int realSymbol;');
        const info = resolveSymbolInfo(store.db, { name: 'noSuchThing', file: FILE, line: 0, col: 0 });
        assert.equal(info.found, false);
        assert.equal(info.kindLabel, 'not found');
    });
});
