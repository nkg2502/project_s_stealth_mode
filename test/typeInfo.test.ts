/**
 * Code Insight "Type" row resolver (features/typeInfo.ts) on the LIVE path.
 * Verifies the declared-type display text + jump-to-type definitions for the
 * symbol under the cursor, all as SQLite point queries (vscode-free).
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveTypeInfo } from '../src/features/typeInfo';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('Type row resolver (resolveTypeInfo)', () => {
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

    it('resolves a parameter typed by an elaborated struct, with a jump target', async () => {
        const FILE = '/t.c';
        const code = [
            'struct mgr_state { int x; };',     // line 0
            'void f(struct mgr_state *rsp) {',  // line 1 (rsp param)
            '\trsp->x;',                        // line 2 (rsp use at col 1)
            '}',                                // line 3
        ].join('\n');
        await store.index(FILE, code);
        const info = resolveTypeInfo(store.db, { name: 'rsp', file: FILE, line: 2, col: 1 });
        assert.ok(info, 'has type info');
        assert.equal(info!.text, 'struct mgr_state');
        assert.equal(info!.tag, 'mgr_state');
        assert.equal(info!.defs.length, 1, 'one jump target');
        assert.equal(info!.defs[0].line, 0);
        assert.equal(info!.defs[0].kind, 'struct');
    });

    it('follows a typedef alias to the underlying struct (not the typedef)', async () => {
        const FILE = '/g.c';
        const code = [
            'struct Spec_s { int n; };',  // line 0 (the actual struct)
            'typedef struct Spec_s Spec_t;', // line 1 (Spec_t -> Spec_s)
            'Spec_t g_spec;',             // line 2 (global)
            'void f(void) { g_spec.n; }', // line 3 (g_spec use)
        ].join('\n');
        await store.index(FILE, code);
        const useCol = code.split('\n')[3].indexOf('g_spec');
        const info = resolveTypeInfo(store.db, { name: 'g_spec', file: FILE, line: 3, col: useCol });
        assert.ok(info, 'has type info');
        assert.equal(info!.text, 'Spec_t');
        assert.equal(info!.tag, 'Spec_t');
        assert.ok(info!.defs.some((d) => d.kind === 'struct' && d.name === 'Spec_s'), 'jumps to struct Spec_s');
        assert.ok(!info!.defs.some((d) => d.kind === 'typedef'), 'prefers the struct over the typedef');
        assert.equal(info!.defs[0].line, 0, 'lands on the struct definition');
    });

    it('follows a transitive typedef chain to the underlying struct', async () => {
        const FILE = '/tc.c';
        const code = [
            'struct A_s { int n; };',   // line 0
            'typedef struct A_s A_t;',  // line 1 (A_t -> A_s)
            'typedef A_t A2_t;',        // line 2 (A2_t -> A_t)
            'A2_t g;',                  // line 3 (global typed A2_t)
            'void f(void) { g.n; }',    // line 4 (g use)
        ].join('\n');
        await store.index(FILE, code);
        const useCol = code.split('\n')[4].indexOf('g.n');
        const info = resolveTypeInfo(store.db, { name: 'g', file: FILE, line: 4, col: useCol });
        assert.ok(info, 'has type info');
        assert.equal(info!.tag, 'A2_t');
        assert.ok(info!.defs.some((d) => d.kind === 'struct' && d.name === 'A_s'), 'A2_t -> A_t -> A_s');
    });

    it('resolves a scalar-typed local: text only, no jump target', async () => {
        const FILE = '/s.c';
        const code = 'void f(void) {\n\tuint32_t count;\n\tcount = 1;\n}';
        await store.index(FILE, code);
        const info = resolveTypeInfo(store.db, { name: 'count', file: FILE, line: 2, col: 1 });
        assert.ok(info, 'has type info');
        assert.equal(info!.text, 'uint32_t');
        assert.equal(info!.tag, '', 'primitive has no aggregate tag');
        assert.equal(info!.defs.length, 0, 'no jump target for a primitive');
    });

    it('reads a function-pointer field type from the field UNDER the cursor, not a same-named field elsewhere', async () => {
        // The screenshot bug: an unrelated `le16 data2` field is indexed first; the
        // cursor sits on the function-pointer `data2` field in another struct/file.
        // The Type row must resolve like F12 (the field under the cursor), not grab
        // the first same-named field in the DB.
        await store.index('/pkt.h', 'struct pkt { le16 data2; };');
        const FILE = '/pq.h';
        const code = [
            'struct parity_calc_table {',
            '  void (*data2)(int, size_t, int, int, void **);',
            '};',
        ].join('\n');
        await store.index(FILE, code);
        const col = code.split('\n')[1].indexOf('data2');
        const info = resolveTypeInfo(store.db, { name: 'data2', file: FILE, line: 1, col });
        assert.ok(info, 'has type info');
        assert.notEqual(info!.text, 'le16', 'must not adopt an unrelated same-named field type');
        assert.equal(info!.text, 'void (*)(int, size_t, int, int, void **)');
        assert.equal(info!.tag, '', 'a function pointer has no aggregate jump target');
        assert.equal(info!.defs.length, 0, 'so no jump target');
    });

    it('returns undefined for a symbol with no declared type (a function)', async () => {
        const FILE = '/fn.c';
        const code = 'void runTask(void) { }\nvoid g(void) { runTask(); }';
        await store.index(FILE, code);
        const callCol = code.split('\n')[1].indexOf('runTask');
        const info = resolveTypeInfo(store.db, { name: 'runTask', file: FILE, line: 1, col: callCol });
        assert.equal(info, undefined);
    });
});
