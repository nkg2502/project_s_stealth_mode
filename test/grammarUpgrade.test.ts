/**
 * RI-36/37/38 (grammar-based upgrades) on the LIVE path.
 *
 * RI-36: member-access base-object extraction — live `symbolContextAt`
 *        (src/memberAccess.ts) replaces the legacy AST findFieldExpressionObject.
 *        Live extracts the IMMEDIATE object (single hop) since narrowing is
 *        single-hop; chained `a.b.c` yields the immediate parent, not the base.
 * RI-37: type extraction — superseded data shapes (see
 *        tasks/grammar-upgrade-superseded.md).
 * RI-38: typedef-alias tracking — live `FileIndex.aliases` + `findTypedefTarget`.
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { symbolContextAt } from '../src/features/memberAccess';
import { findTypedefTarget } from '../src/store/db';
import { indexFile } from '../src/indexer/indexFile';
import { setupLiveParser, openLiveStore, makeDoc, resolveDefinitionAt } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

/** The live base-object of the member access whose member sits at (line, col). */
function objectAt(code: string, line: number, col: number): string | undefined {
    return symbolContextAt(makeDoc('/t.c', code) as never, { line, character: col }).objectName;
}

// ============================================================================
// RI-36: member-access base-object extraction (live symbolContextAt)
// ============================================================================
describe('RI-36: member-access base-object extraction', () => {
    it('simple dot access: obj.field -> "obj"', () => {
        const code = 'void f() { obj.field = 1; }';
        assert.equal(objectAt(code, 0, code.indexOf('field')), 'obj');
    });

    it('simple arrow access: ptr->field -> "ptr"', () => {
        const code = 'void f() { ptr->field = 1; }';
        assert.equal(objectAt(code, 0, code.indexOf('field')), 'ptr');
    });

    it('array subscript: arr[0].field -> "arr"', () => {
        const code = 'void f() { arr[0].field = 1; }';
        assert.equal(objectAt(code, 0, code.indexOf('field')), 'arr');
    });

    it('complex subscript: arr[i + 1].field -> "arr"', () => {
        const code = 'void f() { int i = 0; arr[i + 1].field = 1; }';
        assert.equal(objectAt(code, 0, code.indexOf('field')), 'arr');
    });

    it('parenthesized pointer: (*pSpec).field -> "pSpec" (identifier, * stripped)', () => {
        const code = 'void f() { (*pSpec).field = 1; }';
        assert.equal(objectAt(code, 0, code.indexOf('field')), 'pSpec');
    });

    it('function return: getObj()->field -> undefined (not a simple object)', () => {
        const code = 'void f() { getObj()->field = 1; }';
        assert.equal(objectAt(code, 0, code.indexOf('field')), undefined);
    });

    it('chained access a.b.c -> immediate object "b" (single-hop)', () => {
        const code = 'void f() { a.b.c = 1; }';
        const col = code.indexOf('.c') + 1; // on 'c'
        assert.equal(objectAt(code, 0, col), 'b');
    });

    it('chained arrow/dot ptr->sub.field -> immediate object "sub" (single-hop)', () => {
        const code = 'void f() { ptr->sub.field = 1; }';
        const col = code.indexOf('.field') + 1; // on 'field'
        assert.equal(objectAt(code, 0, col), 'sub');
    });

    it('multiline: object on a different line', () => {
        const code = 'void f() {\n  SVC_Spec_t spec;\n  spec.migrationType = 0;\n}';
        const col = code.split('\n')[2].indexOf('spec.migrationType') + 5; // on 'migrationType'
        assert.equal(objectAt(code, 2, col), 'spec');
    });

    it('no field expression: standalone identifier -> undefined', () => {
        const code = 'void f() { count = 1; }';
        assert.equal(objectAt(code, 0, code.indexOf('count')), undefined);
    });

    it('no field expression: function call -> undefined', () => {
        const code = 'void f() { runTask(); }';
        assert.equal(objectAt(code, 0, code.indexOf('runTask')), undefined);
    });
});

// ============================================================================
// RI-37: type extraction — the AGGREGATE TAG of qualified/template/typedef types
// is now captured (the rightmost component, matching a field's `scope`), so C++
// qualified-typed member access narrows. The full raw type STRING (`std::string`
// vs just `string`) and primitive scalars stay deferred — no consumer needs the
// raw string; narrowing needs only the tag. See tasks/grammar-upgrade-superseded.md.
// ============================================================================
describe('RI-37: qualified/global aggregate-tag type extraction', () => {
    before(async () => {
        await setupLiveParser();
    });

    async function localType(code: string, name: string): Promise<string> {
        const idx = await indexFile('t.cpp', code, 'cpp');
        return idx.locals.find((l) => l.name === name)?.dataType ?? '';
    }
    async function globalType(code: string, name: string): Promise<string> {
        const idx = await indexFile('t.cpp', code, 'cpp');
        return idx.symbols.find((s) => s.name === name && s.kind === 'global_variable')?.dataType ?? '';
    }

    it('captures the tag of a qualified type on a local (MyNS::Config -> Config)', async () => {
        assert.equal(await localType('void f(MyNS::Config *cfg) { }', 'cfg'), 'Config');
    });

    it('captures the tag of a std:: qualified type on a local (std::string -> string)', async () => {
        assert.equal(await localType('void f(std::string name) { }', 'name'), 'string');
    });

    it('captures the base of a template type on a local (std::vector<int> -> vector)', async () => {
        assert.equal(await localType('void f(std::vector<int> v) { }', 'v'), 'vector');
    });

    it('captures the tag of a qualified type on a global variable (MyNS::Config -> Config)', async () => {
        assert.equal(await globalType('MyNS::Config gcfg;', 'gcfg'), 'Config');
    });

    it('captures a typedef-name type on a global variable (SVC_Spec_t -> SVC_Spec_t)', async () => {
        assert.equal(await globalType('SVC_Spec_t spec;', 'spec'), 'SVC_Spec_t');
    });

    // STILL deferred: the full raw type STRING (`std::string`, not just `string`)
    // and primitive scalars (`uint32_t count` -> '', `int bar` field -> ''). No
    // consumer needs the raw string; narrowing needs only the tag. See task md.
    it.skip('extracts the full raw qualified string for display', () => { /* see task md */ });
    it.skip('extracts a primitive scalar type for a struct member', () => { /* see task md */ });
});

// ============================================================================
// RI-38: typedef alias emission -> FileIndex.aliases
// ============================================================================
describe('RI-38: typedef alias emission (FileIndex.aliases)', () => {
    before(async () => {
        await setupLiveParser();
    });

    async function aliasesOf(code: string): Promise<{ name: string; target: string }[]> {
        return (await indexFile('test.h', code, 'c')).aliases;
    }

    it('records a struct typedef with a named tag', async () => {
        const a = await aliasesOf('typedef struct Foo_s { int x; } Foo_t;');
        assert.equal(a.find(x => x.name === 'Foo_t')?.target, 'Foo_s');
    });

    it('records a typedef enum', async () => {
        const a = await aliasesOf('typedef enum Color_e { RED, GREEN } Color_t;');
        assert.equal(a.find(x => x.name === 'Color_t')?.target, 'Color_e');
    });

    it('records a typedef union', async () => {
        const a = await aliasesOf('typedef union Data_u { int i; float f; } Data_t;');
        assert.equal(a.find(x => x.name === 'Data_t')?.target, 'Data_u');
    });

    // A `typedef <type-name> Alias;` now records Alias -> the other type name, so
    // a CHAIN of typedefs (A2_t -> A_t -> A_s) resolves transitively. We can't
    // tell at extraction time whether the target is an aggregate or scalar alias
    // (it may be in another file), so both are recorded; a scalar target simply
    // never matches a field's owning tag.
    it('records a transitive type-name alias: typedef A_t A2_t', async () => {
        const a = await aliasesOf('typedef A_t A2_t;');
        assert.equal(a.find(x => x.name === 'A2_t')?.target, 'A_t');
    });

    // A recognized stdint primitive (`uint32_t` parses as primitive_type, not a
    // type_identifier) records no alias — and needs none: a scalar has no fields
    // to narrow. Arbitrary type-name aliases (above) ARE recorded for chains.
    it('records no alias for a stdint-primitive typedef: typedef uint32_t DWORD', async () => {
        const a = await aliasesOf('typedef uint32_t DWORD;');
        assert.equal(a.find(x => x.name === 'DWORD'), undefined);
    });

    it('does not record an alias for an anonymous struct typedef', async () => {
        const a = await aliasesOf('typedef struct { int x; } Anon_t;');
        assert.equal(a.find(x => x.name === 'Anon_t'), undefined, 'anonymous struct has no named target');
    });

    it('records an alias for each typedef in a multi-declarator', async () => {
        const a = await aliasesOf('typedef struct Pair_s { int a; int b; } Pair_t, *PairPtr_t;');
        assert.equal(a.find(x => x.name === 'Pair_t')?.target, 'Pair_s');
        assert.equal(a.find(x => x.name === 'PairPtr_t')?.target, 'Pair_s');
    });

    it('does not break struct/member extraction', async () => {
        const idx = await indexFile('test.h', 'typedef struct Foo_s { int x; int y; } Foo_t;', 'c');
        assert.ok(idx.symbols.some(s => s.name === 'Foo_s' && s.kind === 'struct'), 'struct Foo_s');
        assert.ok(idx.symbols.some(s => s.name === 'x' && s.kind === 'field'), 'field x');
        assert.ok(idx.symbols.some(s => s.name === 'y' && s.kind === 'field'), 'field y');
    });
});

// ============================================================================
// RI-38: typedef alias lookup via the live store (findTypedefTarget)
// ============================================================================
describe('RI-38: typedef alias lookup (findTypedefTarget)', () => {
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

    it('stores and retrieves a typedef alias', async () => {
        await store.index('/types.h', 'typedef struct Foo_s { int x; } Foo_t;');
        assert.equal(findTypedefTarget(store.db, 'Foo_t'), 'Foo_s');
    });

    it('returns undefined for an unknown typedef', async () => {
        await store.index('/types.h', 'typedef struct Foo_s { int x; } Foo_t;');
        assert.equal(findTypedefTarget(store.db, 'NonExistent_t'), undefined);
    });

    it('stores multiple aliases', async () => {
        await store.index('/types.h', [
            'typedef struct Foo_s { int x; } Foo_t;',
            'typedef struct Bar_s { int y; } Bar_t;',
            'typedef enum Baz_e { A } Baz_t;',
        ].join('\n'));
        assert.equal(findTypedefTarget(store.db, 'Foo_t'), 'Foo_s');
        assert.equal(findTypedefTarget(store.db, 'Bar_t'), 'Bar_s');
        assert.equal(findTypedefTarget(store.db, 'Baz_t'), 'Baz_e');
    });

    it('removes aliases when the file is removed', async () => {
        await store.index('/types.h', 'typedef struct Foo_s { int x; } Foo_t;');
        assert.equal(findTypedefTarget(store.db, 'Foo_t'), 'Foo_s');
        store.writer.remove('/types.h');
        assert.equal(findTypedefTarget(store.db, 'Foo_t'), undefined);
    });

    // DEFERRED — legacy per-file / clear alias granularity. See task md.
    it.skip('removes aliases per file via removeFileTypedefAliases', () => { /* see task md */ });
    it.skip('clears aliases on db.clear()', () => { /* see task md */ });
});

// ============================================================================
// RI-38: alias-aware member narrowing (live, end-to-end via resolveDefinition)
// ============================================================================
describe('RI-38: alias-aware member narrowing', () => {
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

    it('falls back to the suffix heuristic when no typedef alias exists', async () => {
        const FILE = '/foo.c';
        const code = [
            'struct Foo_s { int field; };',  // line 0
            'struct Bar_s { int field; };',  // line 1
            'void f(Foo_t *o) {',            // line 2 (Foo_t, no typedef)
            '\to->field = 1;',               // line 3 (field at cols 3-7)
            '}',                             // line 4
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 3, 4);
        assert.ok(res);
        assert.equal(res!.hits.length, 1);
        assert.equal(res!.hits[0].line, 0, 'narrowed to Foo_s.field via _t/_s suffix');
    });

    it('real-world: typedef SVC_Spec_t -> alias resolves the member to SVC_Spec_s', async () => {
        const FILE = '/SVC_Api.c';
        const code = [
            'struct SVC_Spec_s { int prevMigrationType; };',    // line 0
            'struct cor_rdat_s { int prevMigrationType; };',  // line 1
            'struct ICTL_State_s { int prevMigrationType; };',  // line 2
            'typedef struct SVC_Spec_s SVC_Spec_t;',             // line 3
            'void f(SVC_Spec_t *p) {',                           // line 4
            '\tp->prevMigrationType = 0;',                      // line 5 (member at col 3)
            '}',                                                 // line 6
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 5, 4);
        assert.ok(res);
        assert.equal(res!.hits.length, 1, 'alias narrows to exactly one member');
        assert.equal(res!.hits[0].line, 0, 'jumps to SVC_Spec_s, not cor_rdat_s / ICTL_State_s');
    });

    // DEFERRED — mock-driven narrower priority unit tests; the live ordering
    // (direct tag -> alias -> suffix -> keep-all) is in narrowFieldsByType and
    // covered end-to-end above + in typeResolution. See task md.
    it.skip('direct scope match takes priority over DB alias', () => { /* see task md */ });
    it.skip('returns all members when no narrowing is possible', () => { /* see task md */ });
});
