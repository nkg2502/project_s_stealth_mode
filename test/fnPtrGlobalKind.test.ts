/**
 * A file-scope function-pointer declaration is a VARIABLE (a global holding a
 * function pointer), not a function prototype. The real repro: `parity_2data_op`
 * is declared `extern void (*parity_2data_op)(int, size_t, int, int, void **);`
 * and defined `void (*parity_2data_op)(...);` in a separate source file, then assigned
 * `parity_2data_op = (*ra)->data2;`. The indexer classified it as a `prototype`
 * (a function declaration) because `findFunctionDeclarator` matches the outer call
 * signature — so Code Insight read it as a function, never as the function-pointer
 * variable it is, and there was no `is_definition=1` row to jump to.
 *
 * tree-sitter distinguishes the two structurally: a function-pointer declarator is a
 * `function_declarator` whose `declarator` field is a `parenthesized_declarator`
 * (`(*name)`), whereas a real prototype's is a bare `identifier` (and a
 * pointer-returning prototype `void *foo(int)` wraps the function_declarator in an
 * outer pointer_declarator). The `= 0` initializer case was already handled.
 *
 * Run: npm run test:unit
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { setupLiveParser } from './liveTestSetup';
import { indexFile } from '../src/indexer/indexFile';
import type { SymbolRow } from '../src/core/types';

const find = (syms: SymbolRow[], name: string): SymbolRow | undefined => syms.find((s) => s.name === name);

describe('function-pointer global is a variable, not a prototype', () => {
    before(async () => {
        await setupLiveParser();
    });

    it('a bare definition `void (*fp)(int);` is a global_variable definition', async () => {
        const { symbols } = await indexFile('/v.c', 'void (*parity_2data_op)(int, size_t, int, int, void **);', 'c');
        const sym = find(symbols, 'parity_2data_op');
        assert.ok(sym, 'symbol should exist');
        assert.equal(sym!.kind, 'global_variable');
        assert.equal(sym!.isDefinition, true, 'a non-extern function-pointer global is a definition');
        // declType is the pointer-to-function type, not the bare return specifier.
        assert.equal(sym!.declType, 'void (*)(int, size_t, int, int, void **)');
    });

    it('an `extern void (*fp)(int);` is a global_variable declaration', async () => {
        const { symbols } = await indexFile('/v.c', 'extern void (*parity_2data_op)(int, size_t, int, int, void **);', 'c');
        const sym = find(symbols, 'parity_2data_op');
        assert.ok(sym);
        assert.equal(sym!.kind, 'global_variable');
        assert.equal(sym!.isDefinition, false, 'an extern function-pointer global is a declaration');
    });

    it('a real prototype `void foo(int);` stays a prototype (regression)', async () => {
        const { symbols } = await indexFile('/v.c', 'void foo(int);', 'c');
        assert.equal(find(symbols, 'foo')?.kind, 'prototype');
    });

    it('a pointer-returning prototype `void *bar(int);` stays a prototype (regression)', async () => {
        const { symbols } = await indexFile('/v.c', 'void *bar(int);', 'c');
        assert.equal(find(symbols, 'bar')?.kind, 'prototype');
    });

    it('a local function-pointer `void (*cb)(int);` inside a function is a local_variable', async () => {
        const { symbols, locals } = await indexFile('/v.c', 'void f(void) {\n  void (*cb)(int);\n}', 'c');
        assert.ok(!find(symbols, 'cb'), 'a function-body local must not leak into global symbols');
        assert.equal(locals.find((l) => l.name === 'cb')?.kind, 'local_variable');
    });
});

describe('grep fallback emits a symbol for a file-scope function-pointer declaration', () => {
    // When a file falls back to the grep scanner (heavy macros defeat tree-sitter),
    // a function-pointer global like `extern void (*parity_2data_op)(...)` must still
    // produce a symbol — otherwise the header reads NOT FOUND even though Called by /
    // References populate from the name-based call/ref scan. This is exactly the
    // a real-world function-pointer global case.
    const scan = (src: string) => {
        const { scanWithRegex } = require('../src/indexer/regexScanner') as {
            scanWithRegex: (t: string, f: string, l: string) => { symbols: SymbolRow[] };
        };
        return scanWithRegex(src, '/parity.c', 'c').symbols;
    };

    it('emits a global_variable for a bare definition (multi-line params)', () => {
        const syms = scan([
            'void (*parity_2data_op)(int disks, size_t bytes, int faila, int failb,',
            '\t\t\t   void **ptrs);',
        ].join('\n'));
        const s = find(syms, 'parity_2data_op');
        assert.ok(s, 'grep must emit a symbol for the fn-pointer global');
        assert.equal(s!.kind, 'global_variable');
        assert.equal(s!.isDefinition, true);
    });

    it('emits a declaration for an extern fn-pointer', () => {
        const syms = scan('extern void (*parity_2data_op)(int, size_t, int, int, void **);');
        const s = find(syms, 'parity_2data_op');
        assert.ok(s);
        assert.equal(s!.kind, 'global_variable');
        assert.equal(s!.isDefinition, false);
    });

    it('does not misfire on a real prototype or a struct field', () => {
        // a plain prototype is a prototype, not a fn-ptr global
        assert.equal(find(scan('void foo(int);'), 'foo')?.kind, 'prototype');
        // an indented struct member is NOT emitted as a file-scope global (grep only
        // takes column-0 declarations, mirroring RE_FUNC_DEF/RE_FUNC_PROTO)
        assert.ok(!find(scan('\tvoid (*data2)(int, size_t);'), 'data2'));
        // a typedef'd function pointer is not a variable
        assert.ok(!scan('typedef void (*Callback)(int);').some((s) => s.name === 'Callback' && s.kind === 'global_variable'));
    });
});
