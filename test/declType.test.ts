/**
 * Declared type-text capture for the Code Insight "Type" row (RI type pillar).
 *
 * `dataType` is the bare aggregate TAG (for member narrowing); `declType` is the
 * full declared type TEXT for display (keeps primitives + the namespace + the
 * `struct`/`union`/`enum` keyword; declarator `*` is not part of the specifier).
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { indexFile } from '../src/indexer/indexFile';
import { findDefinitions, findLocal } from '../src/store/db';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('declType capture (Type row)', () => {
    before(async () => {
        await setupLiveParser();
    });

    async function localDeclType(code: string, name: string, lang: 'c' | 'cpp' = 'c'): Promise<string> {
        const idx = await indexFile('t.' + (lang === 'cpp' ? 'cpp' : 'c'), code, lang);
        return idx.locals.find((l) => l.name === name)?.declType ?? '';
    }
    async function globalDeclType(code: string, name: string, lang: 'c' | 'cpp' = 'c'): Promise<string> {
        const idx = await indexFile('t.' + (lang === 'cpp' ? 'cpp' : 'c'), code, lang);
        return idx.symbols.find((s) => s.name === name && s.kind === 'global_variable')?.declType ?? '';
    }
    async function fieldDeclType(code: string, name: string): Promise<string> {
        const idx = await indexFile('t.c', code, 'c');
        return idx.symbols.find((s) => s.name === name && s.kind === 'field')?.declType ?? '';
    }

    it('captures a primitive scalar type on a local (uint32_t count)', async () => {
        assert.equal(await localDeclType('void f(void) { uint32_t count; }', 'count'), 'uint32_t');
    });

    it('captures an elaborated aggregate type on a param (struct mgr_state *rsp)', async () => {
        assert.equal(await localDeclType('void f(struct mgr_state *rsp) { }', 'rsp'), 'struct mgr_state');
    });

    it('captures a typedef type on a global (SVC_Spec_t spec)', async () => {
        assert.equal(await globalDeclType('SVC_Spec_t spec;', 'spec'), 'SVC_Spec_t');
    });

    it('captures a primitive type on a struct field (int bar)', async () => {
        assert.equal(await fieldDeclType('struct S { int bar; };', 'bar'), 'int');
    });

    it('composes a function-pointer field type (the bare specifier is only the return type)', async () => {
        // `void (*data2)(int, size_t)` — `void` is the *return* type, not the field's
        // type. The displayed type must be the pointer-to-function `void (*)(int, size_t)`.
        assert.equal(
            await fieldDeclType('struct S { void (*data2)(int, size_t, int, int, void **); };', 'data2'),
            'void (*)(int, size_t, int, int, void **)',
        );
    });

    it('composes a function-pointer parameter type (int (*cb)(int))', async () => {
        assert.equal(await localDeclType('void f(int (*cb)(int)) { }', 'cb'), 'int (*)(int)');
    });

    it('composes a function-pointer global type with initializer (int (*fp)(int) = 0)', async () => {
        assert.equal(await globalDeclType('int (*fp)(int) = 0;', 'fp'), 'int (*)(int)');
    });

    it('captures a C++ qualified type on a param (MyNS::Config *cfg)', async () => {
        assert.equal(await localDeclType('void f(MyNS::Config *cfg) { }', 'cfg', 'cpp'), 'MyNS::Config');
    });

    it('is empty when there is no type specifier (auto-less / unknown)', async () => {
        // A bare label/identifier expression has no declaration → no declType.
        assert.equal(await localDeclType('void f(void) { count = 1; }', 'count'), '');
    });
});

describe('declType round-trips through SQLite', () => {
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

    it('stores and reads a global variable declType (findDefinitions)', async () => {
        await store.index('/g.c', 'struct mgr_state g_state;');
        const hit = findDefinitions(store.db, 'g_state', ['global_variable'])[0];
        assert.ok(hit, 'global found');
        assert.equal(hit.declType, 'struct mgr_state');
    });

    it('stores and reads a local declType (findLocal)', async () => {
        await store.index('/l.c', 'void f(void) { uint32_t count; }');
        const hit = findLocal(store.db, 'count', '/l.c', 'f')[0];
        assert.ok(hit, 'local found');
        assert.equal(hit.declType, 'uint32_t');
    });
});
