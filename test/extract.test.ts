import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { getParser } from '../src/indexer/parser';
import { extractFromTree } from '../src/indexer/extract';
import { setupLiveParser } from './liveTestSetup';

describe('extractFromTree - field extraction', () => {
    before(async () => {
        await setupLiveParser();
    });

    it('captures function signature, return type, and storage modifier', async () => {
        const code = 'static fs16 *bar(char *s, int n)\n{ return 0; }';
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { symbols } = extractFromTree(tree, 'test.c', 'c');
            const bar = symbols.find(s => s.name === 'bar' && s.kind === 'function');
            assert.ok(bar, 'function bar should be extracted');
            assert.equal(bar!.returnType, 'fs16', 'return type is the type specifier');
            assert.equal(bar!.storage, 'static', 'storage modifier captured');
            assert.equal(bar!.signature, 'bar(char *s, int n)', 'signature is name + param list');
        } finally {
            tree.delete();
        }
    });

    it('tags a field reference with its owning aggregate (declaration + use)', async () => {
        const code = [
            'struct A { int head; };',           // 0  decl head, owner A
            'struct B { int head; };',           // 1  decl head, owner B
            'void f(struct A *a) { a->head; }',  // 2  use a->head, owner A
            'void g(struct B *b) { b->head; }',  // 3  use b->head, owner B
        ].join('\n');
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { refs } = extractFromTree(tree, 'test.c', 'c');
            const head = (line: number) => refs.find(r => r.name === 'head' && r.role === 'field' && r.line === line);
            assert.equal(head(0)?.owner, 'A', 'A.head declaration owned by A');
            assert.equal(head(1)?.owner, 'B', 'B.head declaration owned by B');
            assert.equal(head(2)?.owner, 'A', 'a->head use owned by A (a is struct A *)');
            assert.equal(head(3)?.owner, 'B', 'b->head use owned by B');
        } finally {
            tree.delete();
        }
    });

    it('recovers a member name behind a `__packed` attribute macro and promotes an anonymous union', async () => {
        // A real-world packed-struct shape: a `__packed` attribute between `}` and the
        // member name defeats tree-sitter (it takes the macro as the member name).
        // Recovery must (a) name the sub-struct member `dma_block`, owned by the
        // enclosing struct because the union is anonymous (its `} __packed;` promotes
        // members per C), and (b) NOT drop a normal field whose name merely looks
        // attribute-ish (`__reserved`, `PACKED`).
        const code = [
            'struct cmd_buf {',
            '\tunion {',
            '\t\tunsigned int raw;',
            '\t\tstruct {',
            '\t\t\tunsigned char cmd;',
            '\t\t\tunsigned char data2;',
            '\t\t} __packed dma_block;',
            '\t} __packed;',
            '\tunsigned long __reserved;',
            '\tint PACKED;',
            '};',
        ].join('\n');
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { symbols } = extractFromTree(tree, 'test.c', 'c');
            const field = (name: string) => symbols.find(s => s.kind === 'field' && s.name === name);
            // The real name is recovered (the spurious `__packed` member is not).
            assert.ok(field('dma_block'), 'dma_block recovered as a field');
            assert.ok(!field('__packed'), '`__packed` is not emitted as a field');
            // Anonymous union → its members promote into the enclosing struct.
            assert.equal(field('dma_block')!.scope, 'cmd_buf', 'dma_block promoted to cmd_buf');
            assert.equal(field('raw')!.scope, 'cmd_buf', 'raw promoted to cmd_buf');
            // dma_block's type is the inner anonymous struct; its members are owned by it.
            const inner = field('dma_block')!.dataType;
            assert.ok(inner && inner.startsWith('@anon:'), 'dma_block typed by the inner anon struct');
            assert.equal(field('data2')!.scope, inner, 'data2 owned by dma_block’s struct, not cmd_buf');
            // Normal fields whose names look attribute-ish are NOT dropped.
            assert.equal(field('__reserved')!.scope, 'cmd_buf', '__reserved kept (its type is not an aggregate body)');
            assert.equal(field('PACKED')!.scope, 'cmd_buf', 'PACKED kept');
        } finally {
            tree.delete();
        }
    });

    it('resolves a cast-base field use owner directly from the cast type', async () => {
        // `((struct X *)p)->data2` — the owning struct is stated syntactically by
        // the cast, so the owner resolves at index time without any type lookup.
        const code = [
            'struct other { void (*data2)(int); };',                // 0
            'struct parity_calc_table { void (*data2)(int); };',    // 1
            'void f(void *p) {',                                    // 2
            '  ((struct other *)p)->data2;',                       // 3
            '  ((struct parity_calc_table *)p)->data2;',           // 4
            '}',                                                    // 5
        ].join('\n');
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { refs } = extractFromTree(tree, 'test.c', 'c');
            const use = (line: number) => refs.find(r => r.name === 'data2' && r.role === 'field' && r.line === line);
            assert.equal(use(3)?.owner, 'other', '((struct other*)p)->data2 owned by other');
            assert.equal(use(4)?.owner, 'parity_calc_table', '((struct parity_calc_table*)p)->data2 owned by parity_calc_table');
        } finally {
            tree.delete();
        }
    });

    it('records a call-base field use object chain as a @call marker (and resolves a same-file callee)', async () => {
        // `get_calc()->data2` — the base is a call; store the callee as a `@call:`
        // chain root so References can resolve the owner from its return type, and
        // resolve a same-file callee's return type directly at index time.
        const code = [
            'struct parity_calc_table { void (*data2)(int); };',    // 0
            'struct parity_calc_table *get_calc(void);',           // 1
            'void f(void) {',                                       // 2
            '  get_calc()->data2;',                                // 3
            '}',                                                    // 4
        ].join('\n');
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { refs } = extractFromTree(tree, 'test.c', 'c');
            const use = refs.find(r => r.name === 'data2' && r.role === 'field' && r.line === 3);
            assert.equal(use?.objChain, '@call:get_calc', 'call-base chain root is the @call marker');
            assert.equal(use?.owner, 'parity_calc_table', 'same-file get_calc return type resolves the owner at index time');
        } finally {
            tree.delete();
        }
    });

    it('resolves a this->field (and (*this).field) use owner to the enclosing class', async () => {
        // `this` is typed by the enclosing aggregate, known structurally at index time
        // (no name to look up), so it becomes the chain root marker `@type:Widget`.
        const code = [
            'struct Widget {',                          // 0
            '  int width;',                             // 1  decl, owner Widget
            '  int w() { return this->width; }',        // 2  this->width, owner Widget
            '  int w2() { return (*this).width; }',     // 3  (*this).width, owner Widget
            '};',                                       // 4
        ].join('\n');
        const parser = await getParser('cpp');
        const tree = parser.parse(code)!;
        try {
            const { refs } = extractFromTree(tree, 'test.cpp', 'cpp');
            const use = (line: number) => refs.find(r => r.name === 'width' && r.role === 'field' && r.line === line);
            assert.equal(use(2)?.owner, 'Widget', 'this->width owned by Widget');
            assert.equal(use(3)?.owner, 'Widget', '(*this).width owned by Widget');
        } finally {
            tree.delete();
        }
    });

    it('resolves field-use owners through subscript / pointer base mixes (recursion)', async () => {
        // Deep mixes already reduce via astObjectChain recursion: subscripting an
        // array/pointer of X yields an X, and a mid-chain subscript is transparent.
        const code = [
            'struct X { int field; struct X *kids; };',          // 0
            'struct Y { struct X xs[4]; struct X *xp; };',       // 1
            'void f(struct X arr[4], struct X *p, struct Y *y) {',// 2
            '  arr[0]->field;',                                  // 3  arr[i]->field  → X
            '  p[1].field;',                                     // 4  p[i].field     → X
            '  y->xs[2].field;',                                 // 5  mid-chain []   → X
            '  (*p).field;',                                     // 6  (*p).field     → X
            '}',
        ].join('\n');
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { refs } = extractFromTree(tree, 'test.c', 'c');
            const use = (line: number) => refs.find(r => r.name === 'field' && r.role === 'field' && r.line === line);
            assert.equal(use(3)?.owner, 'X', 'arr[0]->field → X (array element)');
            assert.equal(use(4)?.owner, 'X', 'p[1].field → X (pointer index)');
            assert.equal(use(5)?.owner, 'X', 'y->xs[2].field → X (mid-chain subscript)');
            assert.equal(use(6)?.owner, 'X', '(*p).field → X (deref)');
        } finally {
            tree.delete();
        }
    });

    it('tags a field declaration ref with its owner even when the name is nested in a declarator', async () => {
        // The field name sits under pointer/array/function declarators, not directly
        // under field_declaration — its ref owner must still be the enclosing struct.
        const code = [
            'struct S {',
            '  void (*data2)(int, size_t);', // 1  function-pointer field
            '  int *ptr;',                   // 2  pointer field
            '  char buf[8];',                // 3  array field
            '};',
        ].join('\n');
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { refs } = extractFromTree(tree, 'test.c', 'c');
            const own = (name: string) => refs.find(r => r.name === name && r.role === 'field')?.owner;
            assert.equal(own('data2'), 'S', 'function-pointer field owned by S');
            assert.equal(own('ptr'), 'S', 'pointer field owned by S');
            assert.equal(own('buf'), 'S', 'array field owned by S');
        } finally {
            tree.delete();
        }
    });

    it('captures function arity and parameter types', async () => {
        const code = 'int foo(int a, char *b) { return 0; }\nvoid bar(void) {}\nint vp(const char *f, ...) { return 0; }\nint kr() { return 0; }';
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { symbols } = extractFromTree(tree, 'test.c', 'c');
            const foo = symbols.find(s => s.name === 'foo' && s.kind === 'function')!;
            assert.equal(foo.arity, 2, 'two parameters');
            assert.equal(foo.paramTypes, 'int,char', 'parameter type list');
            const bar = symbols.find(s => s.name === 'bar' && s.kind === 'function')!;
            assert.equal(bar.arity, 0, '(void) means zero parameters');
            const vp = symbols.find(s => s.name === 'vp' && s.kind === 'function')!;
            assert.equal(vp.arity, 1, 'one fixed parameter before the ellipsis');
            assert.ok(vp.paramTypes!.endsWith('...'), 'variadic marked');
            const kr = symbols.find(s => s.name === 'kr' && s.kind === 'function')!;
            assert.equal(kr.arity, undefined, 'unspecified `()` leaves arity unconstrained');
        } finally {
            tree.delete();
        }
    });

    it('captures storage on an extern prototype and a static global', async () => {
        const code = 'extern int qux(char *s, int n);\nstatic int gCount;';
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { symbols } = extractFromTree(tree, 'test.c', 'c');
            const qux = symbols.find(s => s.name === 'qux' && s.kind === 'prototype');
            assert.ok(qux, 'prototype qux should be extracted');
            assert.equal(qux!.returnType, 'int');
            assert.equal(qux!.storage, 'extern');
            assert.equal(qux!.signature, 'qux(char *s, int n)');
            const g = symbols.find(s => s.name === 'gCount' && s.kind === 'global_variable');
            assert.ok(g, 'global gCount should be extracted');
            assert.equal(g!.storage, 'static', 'storage modifier captured on a global variable');
        } finally {
            tree.delete();
        }
    });

    it('captures the typedef name as the field owner when a macro sits before it', async () => {
        // `typedef struct { ... } PACKED Name;` — the PACKED attribute-macro reads as
        // an extra leading declarator. The real typedef alias is the RIGHTMOST name, so
        // the field's owning tag must be `nh`, not the macro `PACKED`. Without this the
        // owner tag collapses to `PACKED` for every such struct and type-narrowing of
        // `obj->field` can no longer tell two same-named fields apart (the btree.c bug).
        const code = `typedef struct {
    int left;
    long overflow;
} PACKED nh;`;
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { symbols } = extractFromTree(tree, 'test.c', 'c');
            const overflow = symbols.find(s => s.name === 'overflow' && s.kind === 'field');
            assert.ok(overflow, 'overflow field should be extracted');
            assert.equal(overflow!.scope, 'nh', 'owner tag is the typedef name, not the PACKED macro');
            // The macro must not be indexed as a bogus typedef symbol.
            assert.ok(!symbols.some(s => s.name === 'PACKED'), 'PACKED must not be indexed as a typedef');
        } finally {
            tree.delete();
        }
    });

    it('extracts nested struct/union fields directly from the tree', async () => {
        const code = `
struct ComplexData {
    int id;
    union {
        struct {
            int x;
            int y;
        } point;
        long rawData[2];
    } coords;
};
        `;
        const parser = await getParser('c');
        const tree = parser.parse(code)!;
        try {
            const { symbols } = extractFromTree(tree, 'test.c', 'c');
            const names = symbols.map(s => s.name);
            for (const n of ['id', 'point', 'x', 'y', 'rawData', 'coords']) {
                assert.ok(names.includes(n), `${n} should be extracted`);
            }
        } finally {
            tree.delete();
        }
    });
});
