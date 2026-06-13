/**
 * Type-based resolution on the LIVE path.
 *
 * The legacy SymbolDatabase did a two-pass *precompute* (buildTypeResolution +
 * resolveTypeToTag/resolveMemberAccess). The live design has no precompute: type
 * resolution is inline in features/resolve.ts (single-hop narrowFieldsByType from
 * an object's local/param dataType; findTypedefTarget alias + the _t/_s suffix
 * heuristic). These cases verify that live behaviour through its public surface:
 * `findTypedefTarget` for name->tag, and `resolveDefinition` (F12) for obj->field
 * narrowing. Multi-hop chains (a->b.c) were a superseded precompute feature —
 * deferred (see tasks/type-resolution-chain.md).
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { findTypedefTarget } from '../src/store/db';
import { indexFile } from '../src/indexer/indexFile';
import { countCallArgs } from '../src/features/memberAccess';
import { setupLiveParser, openLiveStore, resolveDefinitionAt, withVscodeStub } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

interface MemberLike { objectName?: string; memberChain?: string[]; enclosingFunc: string | null; }
/** Drive the vscode-free resolve.ts:definitionsAt (used by Code Insight's Definition row). */
function defsAt(db: unknown, name: string, role: string, file: string, member: MemberLike, isMemberAccess: boolean, callArity?: number) {
  return withVscodeStub(() => {
    const { definitionsAt } = require('../src/features/resolve') as {
      definitionsAt: (db: unknown, name: string, role: string, file: string, member: MemberLike, isMemberAccess: boolean, callArity?: number) => { kind: string; line: number; scope: string; file: string }[];
    };
    return definitionsAt(db, name, role, file, member, isMemberAccess, callArity);
  });
}

describe('type-based resolution (live)', () => {
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

    it('findTypedefTarget resolves a typedef name to its struct tag', async () => {
        await store.index('a.h', 'typedef struct SVC_Spec_s { int x; } SVC_Spec_t;');
        assert.equal(findTypedefTarget(store.db, 'SVC_Spec_t'), 'SVC_Spec_s');
        // A tag with no alias of its own simply has no typedef target.
        assert.equal(findTypedefTarget(store.db, 'SVC_Spec_s'), undefined);
    });

    it('findTypedefTarget resolves a forward typedef defined in another file', async () => {
        await store.index('b.h', 'struct Widget_s { int w; };');
        await store.index('a.h', 'typedef struct Widget_s Widget_t;');
        assert.equal(findTypedefTarget(store.db, 'Widget_t'), 'Widget_s');
    });

    it('narrows obj->field to the field of the struct named by a typedef alias', async () => {
        const FILE = '/t.c';
        const code = [
            'struct A_s { int field; };',       // line 0
            'struct B_s { int field; };',       // line 1
            'typedef struct A_s A_t;',          // line 2
            'void f(A_t *a) {',                 // line 3
            '\ta->field;',                      // line 4  (field at cols 4-8)
            '}',                                // line 5
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 4, 5);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed to exactly one field');
        assert.equal(res!.hits[0].name, 'field');
        assert.equal(res!.hits[0].line, 0, 'jumps to A_s.field (alias A_t -> A_s), not B_s.field');
    });

    it('falls back to the _t/_s suffix heuristic when no typedef alias exists', async () => {
        const FILE = '/t.c';
        const code = [
            'struct Foo_s { int field; };',     // line 0
            'struct Bar_s { int field; };',     // line 1
            'void f(Foo_t *p) {',               // line 2  (Foo_t used, but no typedef)
            '\tp->field;',                      // line 3  (field at cols 4-8)
            '}',                                // line 4
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 3, 5);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed to exactly one field');
        assert.equal(res!.hits[0].line, 0, 'jumps to Foo_s.field via the _t/_s heuristic');
    });

    // Multi-hop member chain: `outer->rtf.migrationType` walks outer's type to
    // its `rtf` field's type, then narrows `migrationType` to that struct — so a
    // same-named field on an unrelated struct (Decoy_s) is not a candidate.
    it('resolves a multi-hop member chain a->b.c across structs', async () => {
        const FILE = '/t.c';
        const code = [
            'struct Inner_s { int migrationType; };',  // line 0
            'struct Decoy_s { int migrationType; };',  // line 1
            'struct Outer_s { struct Inner_s rtf; };',  // line 2
            'void f(struct Outer_s *outer) {',          // line 3
            '\touter->rtf.migrationType;',             // line 4 (migrationType at col 12+)
            '}',                                        // line 5
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 4, 14);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed to exactly one field via the chain');
        assert.equal(res!.hits[0].name, 'migrationType');
        assert.equal(res!.hits[0].line, 0, 'jumps to Inner_s.migrationType, not Decoy_s');
    });

    // A GLOBAL aggregate variable is a valid chain root: its declared type
    // (stored as the global symbol's dataType) narrows `gObj.field` to the
    // field of that struct — not every same-named field. Globals live in the
    // `symbols` table (not `locals`), so the root lookup must consult both.
    it('narrows a member access through a global aggregate variable', async () => {
        const FILE = '/t.c';
        const code = [
            'struct A_s { int field; };',  // line 0
            'struct B_s { int field; };',  // line 1
            'struct A_s gObj;',            // line 2 (global var typed A_s)
            'void f(void) {',              // line 3
            '\tgObj.field = 1;',           // line 4 (field at cols 6-10)
            '}',                           // line 5
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 4, 7);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed to exactly one field via the global type');
        assert.equal(res!.hits[0].name, 'field');
        assert.equal(res!.hits[0].line, 0, 'jumps to A_s.field, not B_s.field');
    });

    // A typedef CHAIN narrows: `typedef A_t A2_t;` where A_t is itself
    // `typedef struct A_s A_t;`. Resolution must follow A2_t -> A_t -> A_s
    // transitively (one-hop alias lookup is not enough).
    it('narrows a member access through a transitive typedef chain', async () => {
        const FILE = '/t.c';
        const code = [
            'struct A_s { int field; };',  // line 0
            'struct B_s { int field; };',  // line 1
            'typedef struct A_s A_t;',     // line 2 (A_t -> A_s)
            'typedef A_t A2_t;',           // line 3 (A2_t -> A_t)
            'void f(A2_t *p) {',           // line 4
            '\tp->field;',                 // line 5 (field at cols 5-9)
            '}',                           // line 6
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 5, 6);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed via the transitive alias chain');
        assert.equal(res!.hits[0].line, 0, 'jumps to A_s.field (A2_t -> A_t -> A_s), not B_s.field');
    });

    // C++ qualified (namespaced) type: `cfg` is `MyNS::Config *`. The captured
    // tag is the rightmost component `Config`, which matches the struct's field
    // scope, so `cfg->field` narrows to Config.field — not Other.field.
    it('narrows a C++ member access through a qualified (namespaced) type', async () => {
        const FILE = '/t.cpp';
        const code = [
            'namespace MyNS { struct Config { int field; }; }',  // line 0
            'struct Other { int field; };',                      // line 1
            'void f(MyNS::Config *cfg) {',                        // line 2
            '\tcfg->field;',                                      // line 3 (field at cols 6-10)
            '}',                                                  // line 4
        ].join('\n');
        await store.index(FILE, code, 'cpp');
        const res = resolveDefinitionAt(store.db, FILE, code, 3, 7);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed via the qualified type tag');
        assert.equal(res!.hits[0].line, 0, 'jumps to MyNS::Config.field, not Other.field');
    });

    // A typedef-aliased global narrows too: the global's dataType is the typedef
    // name, which resolves to the struct tag via the alias table.
    it('narrows a member access through a typedef-aliased global variable', async () => {
        const FILE = '/t.c';
        const code = [
            'struct A_s { int field; };',  // line 0
            'struct B_s { int field; };',  // line 1
            'typedef struct A_s A_t;',     // line 2
            'A_t gObj;',                   // line 3 (global var typed A_t -> A_s)
            'void f(void) {',              // line 4
            '\tgObj.field = 1;',           // line 5 (field at cols 6-10)
            '}',                           // line 6
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 5, 7);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed to exactly one field via the alias');
        assert.equal(res!.hits[0].line, 0, 'jumps to A_s.field (A_t -> A_s), not B_s.field');
    });

    // The btree.c bug, reduced: `node->head.overflow` where the head struct's tag is
    // hidden behind a `PACKED` attribute-macro in its typedef. Two same-named fields
    // in different macro'd typedef structs must still be told apart by the chain — the
    // macro must not collapse both owner tags to `PACKED`.
    it('narrows a member chain whose owner tag is hidden behind a macro (PACKED)', async () => {
        const FILE = '/t.c';
        const code = [
            'typedef struct { long overflow; } PACKED host_head_t;',  // line 0 (target)
            'typedef struct { long overflow; } PACKED disk_head_t;',  // line 1 (decoy)
            'struct outer { host_head_t head; };',                    // line 2
            'void f(struct outer *node) {',                           // line 3
            '\tif (node->head.overflow == 0) return;',                // line 4 (overflow at col 16)
            '}',                                                      // line 5
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 4, 16);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed to exactly one field via the chain');
        assert.equal(res!.hits[0].name, 'overflow');
        assert.equal(res!.hits[0].line, 0, 'jumps to host_head_t.overflow, not disk_head_t');
    });

    // A member-access occurrence (`obj->x` / `obj.x`) denotes a struct member — never
    // a goto label, a function, or a tag. On the grep fallback (no AST role) the older
    // name-based path must still refuse to jump to an unrelated `overflow:` label.
    it('never resolves a member access to a goto label (grep fallback)', async () => {
        const FILE = '/u.c';
        const code = ['void f(struct X *p) {', '\tp->overflow;', '}'].join('\n');
        // Force the cursor file through grep (role lost) via a zero size budget.
        const fi = await indexFile(FILE, code, 'c', { maxFileSizeBytes: 0, errorRatioThreshold: 0.25, parseTimeoutMicros: 0 });
        assert.equal(fi.parsedBy, 'grep', 'cursor file is grep-parsed (no role)');
        store.writer.applyBatch([{ fi, mtime: 1 }]);
        // Another file defines a goto label named `overflow`; no struct field exists.
        await store.index('/labels.c', 'void g(void) { goto overflow; overflow: return; }');
        const res = resolveDefinitionAt(store.db, FILE, code, 1, 4);
        assert.ok(res, 'should resolve');
        assert.ok(!res!.hits.some(h => h.kind === 'label'), 'a member access must not jump to a goto label');
        assert.equal(res!.hits.length, 0, 'no member named overflow exists, so nothing to jump to');
    });

    // The Code Insight "Definition" row must resolve like F12, not by bare name.
    // Reported: `node->head.overflow` still listed a goto `label` in Definition, and
    // `node->head` listed every struct that has a `head` field.
    it('definitionsAt: a field member access excludes labels and narrows by owner type', async () => {
        const FILE = '/t.c';
        const code = [
            'typedef struct { long overflow; } PACKED host_head_t;',  // 0 (target)
            'typedef struct { long overflow; } PACKED disk_head_t;',  // 1 (decoy)
            'struct outer { host_head_t head; };',                    // 2
            'void f(struct outer *node) {',                           // 3
            '\tif (node->head.overflow) return;',                     // 4
            '}',                                                      // 5
        ].join('\n');
        await store.index(FILE, code);
        await store.index('/lbl.c', 'void g(void){ goto overflow; overflow: return; }');
        const member = { objectName: 'head', memberChain: ['node', 'head'], enclosingFunc: 'f' };
        const defs = defsAt(store.db, 'overflow', 'field', FILE, member, true);
        assert.ok(!defs.some(d => d.kind === 'label'), 'Definition must not include a goto label');
        assert.equal(defs.length, 1, 'narrowed to exactly one field via the chain');
        assert.equal(defs[0].line, 0, 'host_head_t.overflow, not disk_head_t');
    });

    it('definitionsAt: head narrows to the object struct, not every same-named field', async () => {
        const FILE = '/t.c';
        const code = [
            'struct inner1 { int a; };',              // 0
            'struct inner2 { int b; };',              // 1
            'struct outer { struct inner1 head; };',  // 2 (outer.head)
            'struct decoy { struct inner2 head; };',  // 3 (decoy.head, same field name)
            'void f(struct outer *node) {',           // 4
            '\tnode->head;',                          // 5
            '}',                                      // 6
        ].join('\n');
        await store.index(FILE, code);
        const member = { objectName: 'node', memberChain: ['node'], enclosingFunc: 'f' };
        const defs = defsAt(store.db, 'head', 'field', FILE, member, true);
        assert.equal(defs.length, 1, 'narrowed to the field owned by node\'s struct');
        assert.equal(defs[0].line, 2, 'outer.head, not decoy.head');
        assert.equal(defs[0].scope, 'outer');
    });

    // Phase C: same-named functions disambiguated by the call site's argument count.
    it('narrows same-named functions by call-site arity', async () => {
        await store.index('/a.c', 'int doit(int a) { return a; }');          // arity 1
        await store.index('/b.c', 'int doit(int a, int b) { return a + b; }'); // arity 2
        const member = { enclosingFunc: null };
        const two = defsAt(store.db, 'doit', 'value', '/c.c', member, false, 2);
        assert.equal(two.length, 1, 'call with 2 args resolves to the 2-arg function');
        assert.equal(two[0].file, '/b.c');
        const one = defsAt(store.db, 'doit', 'value', '/c.c', member, false, 1);
        assert.equal(one.length, 1, 'call with 1 arg resolves to the 1-arg function');
        assert.equal(one[0].file, '/a.c');
        // No arity hint → both candidates remain (best-effort, never hides).
        const both = defsAt(store.db, 'doit', 'value', '/c.c', member, false);
        assert.equal(both.length, 2, 'without a call, arity does not filter');
    });
});

describe('field references narrowed by owning struct', () => {
    let store: LiveStore;
    before(async () => { await setupLiveParser(); });
    beforeEach(() => { store = openLiveStore(); });
    afterEach(() => { store.close(); });

    function refsAt(db: unknown, name: string, role: string, file: string, member: MemberLike) {
        return withVscodeStub(() => {
            const { referencesAt } = require('../src/features/resolve') as {
                referencesAt: (db: unknown, name: string, role: string, file: string, member: MemberLike, isLocal: boolean, func: string | null) => { file: string; line: number }[];
            };
            return referencesAt(db, name, role, file, member, false, member.enclosingFunc);
        });
    }

    it('shows only references to the field of the object\'s struct, not same-named fields', async () => {
        const FILE = '/t.c';
        const code = [
            'struct A { int head; };',            // 0  A.head decl
            'struct B { int head; };',            // 1  B.head decl
            'void f(struct A *a) { a->head; }',   // 2  A.head use
            'void g(struct B *b) { b->head; }',   // 3  B.head use
        ].join('\n');
        await store.index(FILE, code);
        // Cursor on `a->head` (line 2): references = A.head's only (lines 0 and 2),
        // never B.head (lines 1, 3).
        const member = { objectName: 'a', memberChain: ['a'], enclosingFunc: 'f' };
        const refs = refsAt(store.db, 'head', 'field', FILE, member);
        const lines = refs.map(r => r.line).sort((x, y) => x - y);
        assert.deepEqual(lines, [0, 2], 'only A.head decl + use; B.head excluded');
    });
});

describe('call-site argument counting (countCallArgs)', () => {
    it('counts top-level call arguments, ignoring nesting and strings', () => {
        assert.equal(countCallArgs('()'), 0);
        assert.equal(countCallArgs('(a)'), 1);
        assert.equal(countCallArgs('(a, b)'), 2);
        assert.equal(countCallArgs('  (a, b, c)'), 3);
        assert.equal(countCallArgs('(f(x, y), z)'), 2, 'nested call commas not counted');
        assert.equal(countCallArgs('(a, "x, y", c)'), 3, 'string commas not counted');
        assert.equal(countCallArgs('notacall'), undefined, 'not a call');
        assert.equal(countCallArgs('(a, b'), undefined, 'unbalanced (multi-line) → give up');
    });
});
