/**
 * Parsing tests on the LIVE indexer (`src/indexer/indexFile.ts` ->
 * `extract.ts` / `regexScanner.ts`). These were the `TreeSitterParser` tests;
 * re-pointed to `indexFile`, which returns a `FileIndex` ({symbols, refs, calls,
 * locals, aliases}) and transparently falls back to the grep scanner.
 *
 * Notable live-shape differences from the legacy parser (cases that asserted the
 * old shape are `it.skip`-ped inline as superseded):
 *  - global/member symbols carry NO dataType (only locals do, and only the
 *    aggregate tag with the pointer stripped); struct members are kind `field`.
 *  - calls use `.callee` / `.caller` (not `.calleeName` / `.callerName`).
 *
 * Run: npm run test:unit
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { indexFile } from '../src/indexer/indexFile';
import { nodeHasParseErrors } from '../src/indexer/extract';
import { setupLiveParser } from './liveTestSetup';
import type { Lang } from '../src/core/types';

before(async () => {
    await setupLiveParser();
});

/** Index `code` on the live path and return its FileIndex. */
async function index(code: string, file = '/t.c', lang: Lang = 'c') {
    return indexFile(file, code, lang);
}

describe('live indexer (was TreeSitterParser)', () => {
    it('should be available after init', async () => {
        const { symbols } = await index('void f(void) {}');
        assert.ok(symbols.some(s => s.name === 'f'), 'live parser should index a function');
    });

    it('should parse a simple function definition', async () => {
        const code = `
void myFunction(int x) {
    return;
}
        `;
        const { symbols } = await index(code);
        const func = symbols.find(s => s.name === 'myFunction');
        assert.ok(func, 'should find myFunction');
        assert.equal(func.kind, 'function');
    });

    it('should parse a struct definition', async () => {
        const code = `
struct MyStruct {
    int field;
};
        `;
        const { symbols } = await index(code);
        const s = symbols.find(s => s.name === 'MyStruct');
        assert.ok(s, 'should find MyStruct');
        assert.equal(s.kind, 'struct');
    });

    it('should NOT parse a struct parameter as a struct definition', async () => {
        const code = `
int cifs_truncate_page(struct address_space *mapping, loff_t from) {
    return 0;
}
        `;
        const { symbols } = await index(code);
        const s = symbols.find(s => s.name === 'address_space' && s.kind === 'struct' && s.isDefinition);
        assert.ok(!s, 'should NOT find address_space as a struct definition');
    });

    it('should parse a macro definition', async () => {
        const code = `
#define MAX_SIZE 1024
        `;
        const { symbols } = await index(code, '/t.h');
        const m = symbols.find(s => s.name === 'MAX_SIZE');
        assert.ok(m, 'should find MAX_SIZE');
        assert.equal(m.kind, 'macro');
    });

    it('should parse a typedef', async () => {
        const code = `
typedef unsigned int UINT32;
        `;
        const { symbols } = await index(code, '/t.h');
        const t = symbols.find(s => s.name === 'UINT32');
        assert.ok(t, 'should find UINT32');
        assert.equal(t.kind, 'typedef');
    });

    it('should parse an enum definition', async () => {
        const code = `
enum Color {
    RED,
    GREEN,
    BLUE
};
        `;
        const { symbols } = await index(code, '/t.h');
        const e = symbols.find(s => s.name === 'Color');
        assert.ok(e, 'should find Color enum');
        assert.equal(e.kind, 'enum');
    });

    it('should parse enumerators nested inside #ifdef blocks (RI-56)', async () => {
        const code = `
enum COR_CDM_States_e
{
    CDM_STATE_IDLE                   = 0,
    CDM_STATE_LOAD_REQUEST_SEND      = 7,
#ifdef PROD_XOR_SNAPSHOT_SUPPORT
    CDM_STATE_LOAD_CDMSD_REQUEST_SEND = 8,
    CDM_STATE_LOAD_CDMSD_REQUEST_WAIT = 9,
#endif
    CDM_STATE_LOAD_REQUEST_WAIT      = 10,
    CDM_STATE_NUM                    = 19
};
        `;
        const { symbols } = await index(code, '/t.h');
        const sendState = symbols.find(s => s.name === 'CDM_STATE_LOAD_CDMSD_REQUEST_SEND');
        const waitState = symbols.find(s => s.name === 'CDM_STATE_LOAD_CDMSD_REQUEST_WAIT');
        assert.ok(sendState, 'enumerator inside #ifdef should be indexed');
        assert.equal(sendState.kind, 'enumerator');
        assert.ok(waitState, 'second enumerator inside #ifdef should be indexed');
        // The macro flag name itself must NOT be indexed as an enumerator
        const phantom = symbols.find(s => s.name === 'PROD_XOR_SNAPSHOT_SUPPORT' && s.kind === 'enumerator');
        assert.ok(!phantom, 'macro flag name should not be indexed as an enumerator');
        // Enumerators outside the block still work
        assert.ok(symbols.find(s => s.name === 'CDM_STATE_LOAD_REQUEST_WAIT'), 'enumerator after #endif should be indexed');
    });

    it('should parse a goto label inside a function body', async () => {
        const code = `
void worker(void) {
    int i = 0;
retry:
    i++;
    if (i < 3) goto retry;
Again:
    return;
}
        `;
        const { symbols } = await index(code);
        const retry = symbols.find(s => s.name === 'retry' && s.kind === 'label');
        const again = symbols.find(s => s.name === 'Again' && s.kind === 'label');
        assert.ok(retry, 'should find label retry');
        assert.ok(again, 'should find label Again');
    });

    it('should extract function calls', async () => {
        const code = `
void caller() {
    funcA();
    funcB(1, 2);
}
        `;
        const { calls } = await index(code);
        const callNames = calls.map(c => c.callee);
        assert.ok(callNames.includes('funcA'), 'should find call to funcA');
        assert.ok(callNames.includes('funcB'), 'should find call to funcB');
    });

    it('should associate caller name with calls', async () => {
        const code = `
void myFunc() {
    helperA();
    helperB();
}
        `;
        const { calls } = await index(code);
        for (const c of calls) {
            assert.equal(c.caller, 'myFunc');
        }
    });

    it('should parse C++ class definition', async () => {
        const code = `
class MyClass {
public:
    void method();
};
        `;
        const { symbols } = await index(code, '/t.cpp', 'cpp');
        const cls = symbols.find(s => s.name === 'MyClass');
        assert.ok(cls, 'should find MyClass');
        assert.equal(cls.kind, 'class');
    });

    it('should parse a function prototype (forward declaration)', async () => {
        const code = `
void forwardDeclared(int x);
        `;
        const { symbols } = await index(code, '/t.h');
        const proto = symbols.find(s => s.name === 'forwardDeclared');
        assert.ok(proto, 'should find forwardDeclared');
        assert.equal(proto.kind, 'prototype');
    });

    it('should handle empty file gracefully', async () => {
        const { symbols, calls } = await index('');
        assert.equal(symbols.length, 0);
        assert.equal(calls.length, 0);
    });

    it('should extract variable from SECTION_ATTR macro', async () => {
        const code = 'SVC_Spec_t SECTION_ATTR(SVC_Spec, "SECTION_A");';
        const { symbols } = await index(code);
        const v = symbols.find(s => s.name === 'SVC_Spec');
        assert.ok(v, 'should find SVC_Spec as a variable');
        assert.equal(v.kind, 'global_variable');
        // SECTION_ATTR itself should NOT be indexed
        const bad = symbols.find(s => s.name === 'SECTION_ATTR');
        assert.ok(!bad, 'SECTION_ATTR should not be indexed as a symbol');
    });

    it('should extract array variable from SECTION_ATTR macro', async () => {
        const code = 'SVC_Partition_t SECTION_ATTR(SVC_Partitions[PARTITIONS_COUNT], "SECTION_A");';
        const { symbols } = await index(code);
        const v = symbols.find(s => s.name === 'SVC_Partitions');
        assert.ok(v, 'should find SVC_Partitions as a variable');
        assert.equal(v.kind, 'global_variable');
    });

    it('should extract variable from SECTION_DATA macro', async () => {
        const code = 'uint32_t SECTION_DATA(myVar, "SOME_SECTION");';
        const { symbols } = await index(code);
        const v = symbols.find(s => s.name === 'myVar');
        assert.ok(v, 'should find myVar as a variable');
        assert.equal(v.kind, 'global_variable');
    });

    it('should extract variable from nested macro (SECTION_ATTR + ALIGN_TO)', async () => {
        const code = 'PAR_BIN_t SECTION_ATTR(ALIGN_TO(bssParityBin[MAX_BINS], 128), "SECTION_B");';
        const { symbols } = await index(code);
        const v = symbols.find(s => s.name === 'bssParityBin');
        assert.ok(v, 'should find bssParityBin from nested ALIGN_TO inside SECTION_ATTR');
        assert.equal(v.kind, 'global_variable');
    });

    it('should auto-detect any ALL_CAPS macro wrapping a variable', async () => {
        const code = 'MyType_t UNKNOWN_FUTURE_MACRO(gMyVar, "SOME_SEC");';
        const { symbols } = await index(code);
        const v = symbols.find(s => s.name === 'gMyVar');
        assert.ok(v, 'should detect without hardcoded macro name');
        assert.equal(v.kind, 'global_variable');
        const bad = symbols.find(s => s.name === 'UNKNOWN_FUTURE_MACRO');
        assert.ok(!bad, 'macro name should not be indexed');
    });

    it('should parse multiple functions in one file', async () => {
        const code = `
void func1() {}
int func2(int a) { return a; }
static void func3() {}
        `;
        const { symbols } = await index(code);
        const funcs = symbols.filter(s => s.kind === 'function');
        assert.ok(funcs.length >= 3, `expected >= 3 functions, got ${funcs.length}`);
    });

    it('should parse file repeatedly without memory issues (tree.delete coverage)', async () => {
        const code = `
void repeatedFunc(int x) {
    someCall();
}
        `;
        // Parse same content many times; indexFile deletes each tree in a finally.
        for (let i = 0; i < 100; i++) {
            const { symbols, calls } = await index(code);
            assert.ok(symbols.length > 0);
            assert.ok(calls.length > 0);
        }
    });

    // ==========================================================
    // dataType extraction
    // ==========================================================
    describe('dataType extraction', () => {
        // Live `global_variable` / `field` symbols carry NO dataType (only locals
        // do, and only the aggregate tag with the pointer stripped). The
        // dataType-on-global/member cases below are superseded — see
        // grammar-upgrade-superseded.md for the same shape in grammarUpgrade.

        it.skip('should extract type for simple variable declaration', () => { /* superseded: globals carry no dataType */ });
        it.skip('should extract type for pointer variable', () => { /* superseded: globals carry no dataType */ });
        it.skip('should extract type for variable with initializer', () => { /* superseded: globals carry no dataType */ });
        it.skip('should extract primitive type', () => { /* superseded: globals carry no dataType */ });
        it.skip('should extract type for struct member', () => { /* superseded: members are kind `field` and carry no dataType */ });
        it.skip('should extract type for array variable', () => { /* superseded: globals carry no dataType */ });
        it.skip('should extract type for SECTION_ATTR variable', () => { /* superseded: globals carry no dataType */ });

        it('should extract type for local parameter (locals table)', async () => {
            const code = `
void foo(SVC_Spec_t *pSpec) {
    pSpec->migrationType = 0;
}
            `;
            const { locals } = await index(code);
            const pSpec = locals.filter(l => l.name === 'pSpec');
            assert.ok(pSpec.length > 0, 'should find local parameter pSpec');
            // Live LocalRow.dataType = aggregate tag only, pointer stripped.
            assert.equal(pSpec[0].dataType, 'SVC_Spec_t');
        });

        it.skip('should extract type for local variable (findLocalDefinitions)', () => {
            // superseded: scalar local types are not captured (live LocalRow.dataType
            // = aggregate tag only; `uint32_t count` -> '').
        });
    });

    // ==========================================================
    // comment handling before parse
    // ==========================================================
    describe('comment handling (was stripComments)', () => {
        it('should parse function after #define with // comment that confuses preprocessor', async () => {
            const code = [
                '#if defined(STAT_CUSTOM)',
                '    #define customPrintf(...) printf(__VA_ARGS__)//printf("\\n");fflush(stdout)',
                '#else',
                '    #define customPrintf(...)',
                '#endif',
                'void IsCommandRmw(void) {',
                '    int x = 0;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'IsCommandRmw');
            assert.ok(func, 'IsCommandRmw should be found');
            assert.equal(func.kind, 'function');
            assert.equal(func.line, 5);
        });

        it('should preserve line numbers with multiline block comments', async () => {
            const code = [
                '/* This is',
                '   a multiline',
                '   comment */',
                'void myFunc(void) {',
                '    return;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'myFunc');
            assert.ok(func, 'myFunc should be found');
            assert.equal(func.line, 3);
        });

        it('should not strip // inside string literals', async () => {
            const code = [
                'void printUrl(void) {',
                '    const char* url = "http://example.com";',
                '    return;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'printUrl');
            assert.ok(func, 'printUrl should be found');
            assert.equal(func.kind, 'function');
        });

        it('should handle // at end of function definition line', async () => {
            const code = [
                'void myFunc(int x) { // init function',
                '    return;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'myFunc');
            assert.ok(func, 'myFunc should be found');
            assert.equal(func.kind, 'function');
            assert.equal(func.line, 0);
        });

        it('should preserve column positions after inline block comment', async () => {
            const code = 'void /* attr */ myFunc(void) { return; };';
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'myFunc');
            assert.ok(func, 'myFunc should be found');
            // 'void /* attr */ ' is 16 chars -> myFunc at col 16.
            assert.equal(func.col, 16);
        });

        it('should parse functions swallowed by mismatched #if due to // in #define', async () => {
            const code = [
                '#if defined(STAT_CUSTOM)',
                '    #define customPrintf(...) printf(__VA_ARGS__)//printf("\\n");fflush(stdout)',
                '#else',
                '    #define customPrintf(...)',
                '#endif',
                'void funcA(void) {',
                '    customPrintf("test");',
                '}',
                'void funcB(int x) {',
                '    return;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const funcA = symbols.find(s => s.name === 'funcA' && s.kind === 'function');
            const funcB = symbols.find(s => s.name === 'funcB' && s.kind === 'function');
            assert.ok(funcA, 'funcA should be found as function');
            assert.ok(funcB, 'funcB should be found as function');
            assert.equal(funcA.line, 5);
            assert.equal(funcB.line, 8);
        });

        it('should parse function after /* */ comment containing preprocessor-like text', async () => {
            const code = [
                '/* #if 0',
                '   old code',
                '   #endif */',
                'void ActiveFunc(void) {',
                '    return;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'ActiveFunc' && s.kind === 'function');
            assert.ok(func, 'ActiveFunc should be found');
            assert.equal(func.line, 3);
        });

        it('should parse function after // comment with unbalanced braces', async () => {
            const code = [
                'int globalVar = 0; // TODO: move to {config}',
                'void CleanFunc(void) {',
                '    return;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'CleanFunc' && s.kind === 'function');
            assert.ok(func, 'CleanFunc should be found');
            assert.equal(func.line, 1);
        });

        it('should parse function after block comment with unbalanced parens', async () => {
            const code = [
                '/* Note: call foo( but never close it */',
                'void SafeFunc(int a) {',
                '    return;',
                '}'
            ].join('\n');
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'SafeFunc' && s.kind === 'function');
            assert.ok(func, 'SafeFunc should be found');
            assert.equal(func.line, 1);
        });
    });

    // ==========================================================
    // attribute-macro tolerance (was stripAttributeMacros)
    // ==========================================================
    // The legacy parser STRIPPED attribute macros before parsing (Layer 1/2/3
    // heuristics). The live path instead anchors a function name to its
    // parameter list in `extract.ts:funcDefName` (the fuzzy fallback), so the
    // SAME observable outcome holds: the function is found, and the attribute
    // macro / return type are never the function name. (A stripped macro may now
    // surface as a stray `global_variable`, which these cases do not forbid.)
    describe('attribute-macro tolerance (was stripAttributeMacros)', () => {
        it('should parse function with CODE_ATTR__ macro between return type and name', async () => {
            const code = `
void MODULE_A_MACRO HandleUpdates(void) {
    int x = 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'HandleUpdates');
            assert.ok(func, 'should find HandleUpdates through macro tolerance');
            assert.equal(func.kind, 'function');
        });

        it('should parse function with macro after static keyword', async () => {
            const code = `
static void MODULE_A_MACRO some_internal_func(int x) {
    return;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'some_internal_func');
            assert.ok(func, 'should find some_internal_func with static + macro');
            assert.equal(func.kind, 'function');
        });

        it('should parse function with typedef return type and macro', async () => {
            const code = `
UINT32 MODULE_B_MACRO SVC_Init(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'SVC_Init');
            assert.ok(func, 'should find SVC_Init with typedef return + macro');
            assert.equal(func.kind, 'function');
        });

        it('should parse function with pointer return type and macro', async () => {
            const code = `
int *MODULE_C_MACRO get_buffer(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'get_buffer');
            assert.ok(func, 'should find get_buffer with pointer return + macro');
            assert.equal(func.kind, 'function');
        });

        it('should parse multiple functions with different macros in same file', async () => {
            const code = `
void MODULE_A_MACRO funcA(void) {}
UINT32 MODULE_B_MACRO funcB(int x) { return x; }
void MODULE_D_MACRO funcC(void) {}
            `;
            const { symbols } = await index(code);
            assert.ok(symbols.find(s => s.name === 'funcA' && s.kind === 'function'), 'funcA');
            assert.ok(symbols.find(s => s.name === 'funcB' && s.kind === 'function'), 'funcB');
            assert.ok(symbols.find(s => s.name === 'funcC' && s.kind === 'function'), 'funcC');
        });

        // --- Cases that MUST NOT produce a false function symbol ---

        it('should NOT strip macro before function pointer declaration', async () => {
            const code = `
void MODULE_A_MACRO (*callback)(int x);
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'callback' && s.kind === 'function');
            assert.ok(!func, 'function pointer should NOT be misidentified as function definition');
        });

        it('should NOT strip tokens without double underscore', async () => {
            const code = `
UINT32 MY_FUNC(int x) {
    return x;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'MY_FUNC' && s.kind === 'function');
            assert.ok(func, 'MY_FUNC is valid C function - tree-sitter parses without needing strip');
            const wrongName = symbols.find(s => s.name === 'UINT32' && s.kind === 'function');
            assert.ok(!wrongName, 'UINT32 should not become function name');
        });

        it('should strip macro after _t type (Layer 1)', async () => {
            const code = `
uint32_t MODULE_CODE_MACRO get_count(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'get_count' && s.kind === 'function');
            assert.ok(func, 'should resolve get_count after _t type + macro');
        });

        it('should NOT strip macro when no parenthesis follows (struct context)', async () => {
            const code = `
struct HW_REG_STATUS {
    int value;
};
            `;
            const { symbols } = await index(code);
            const s = symbols.find(s => s.name === 'HW_REG_STATUS');
            assert.ok(s, 'struct HW_REG_STATUS should still be found');
            assert.equal(s.kind, 'struct');
        });

        it('should NOT strip macro used as a type name (variable declaration)', async () => {
            const code = `
MODULE_STATUS_T status_reg;
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.kind === 'function');
            assert.ok(!func, 'variable declaration should not produce a function symbol');
        });

        it('should NOT affect typedef function pointers', async () => {
            const code = `
typedef void (*FuncPtr)(void);
typedef int (*MODULE_HANDLER)(int, int);
            `;
            const { symbols } = await index(code);
            const t = symbols.find(s => s.name === 'FuncPtr');
            assert.ok(t, 'FuncPtr typedef should be found');
            assert.equal(t.kind, 'typedef');
        });

        it('should strip single-underscore ALL_CAPS macro when preceded by type (Layer 1)', async () => {
            const code = `
void SIMPLE_MACRO funcX(void) {
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'funcX' && s.kind === 'function');
            assert.ok(func, 'should resolve funcX past SIMPLE_MACRO after void');
            const wrongName = symbols.find(s => s.name === 'SIMPLE_MACRO' && s.kind === 'function');
            assert.ok(!wrongName, 'SIMPLE_MACRO should not become a function name');
        });

        it('should NOT strip ALL_CAPS token without preceding type context', async () => {
            const code = `
UINT32 MY_FUNC(int x) {
    return x;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'MY_FUNC' && s.kind === 'function');
            assert.ok(func, 'MY_FUNC is valid C - tree-sitter handles it natively');
        });

        it('should NOT strip ALL_CAPS type after storage-class keyword', async () => {
            const code = `
static UINT32 my_helper(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'my_helper' && s.kind === 'function');
            assert.ok(func, 'static UINT32 func() should parse normally');
        });

        // --- A B C(void) pattern: two ALL_CAPS before identifier ---

        it('should handle TYPEDEF MACRO func() - custom type + attribute macro', async () => {
            const code = `
UINT32 SECTION_ATTR my_func(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'my_func' && s.kind === 'function');
            assert.ok(func, 'A B C() pattern: my_func is the function name');
        });

        it('should handle TYPEDEF MACRO__X func() - custom type + __ macro (Layer 2)', async () => {
            const code = `
UINT32 MODULE_MACRO my_func(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'my_func' && s.kind === 'function');
            assert.ok(func, 'resolves my_func past __ macro after custom typedef');
        });

        it('should handle void MACRO1 MACRO2 func() - type + two macros', async () => {
            const code = `
void MODULE_A_MACRO SECTION_B_MACRO my_func(void) {
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'my_func' && s.kind === 'function');
            assert.ok(func, 'multiple macros between type and func name still resolve the name');
        });

        it('should handle static TYPEDEF MACRO func() - storage class + type + macro', async () => {
            const code = `
static UINT32 SECTION_ATTR my_func(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'my_func' && s.kind === 'function');
            assert.ok(func, 'static + type + macro should resolve the function name');
        });

        it('should NOT misparse two-word valid C as needing strip', async () => {
            const code = `
UINT32 my_func(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'my_func' && s.kind === 'function');
            assert.ok(func, 'UINT32 my_func() is valid C');
        });

        it('should handle generic A B C(void) pattern - C is function name', async () => {
            const code = `
RETVAL_T ATTRIB_MACRO handler_init(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'handler_init' && s.kind === 'function');
            assert.ok(func, 'A B C(): handler_init is the function name');
            const bad1 = symbols.find(s => s.name === 'RETVAL_T' && s.kind === 'function');
            const bad2 = symbols.find(s => s.name === 'ATTRIB_MACRO' && s.kind === 'function');
            assert.ok(!bad1, 'RETVAL_T should not be a function');
            assert.ok(!bad2, 'ATTRIB_MACRO should not be a function');
        });

        it('should handle PascalCase type + macro (no ALL_CAPS requirement)', async () => {
            const code = `
SvcStatus SECTION_ATTR handle_request(int x) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'handle_request' && s.kind === 'function');
            assert.ok(func, 'PascalCase type + ALL_CAPS attr: resolves handle_request');
        });

        it('should handle lowercase type + lowercase attr', async () => {
            const code = `
my_type_t my_section_attr do_work(void) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'do_work' && s.kind === 'function');
            assert.ok(func, 'lowercase type + lowercase attr: resolves do_work');
        });

        it('should NOT strip after C keywords (static, extern, inline, const)', async () => {
            const cases: Array<[string, string, string, string]> = [
                ['static UINT32 my_func(void) { return 0; }', 'my_func', 'function', 'static'],
                ['inline int fast_func(void) { return 0; }', 'fast_func', 'function', 'inline'],
                ['const int get_val(void) { return 0; }', 'get_val', 'function', 'const'],
            ];
            for (const [code, expectedName, expectedKind, keyword] of cases) {
                const { symbols } = await index(code);
                const sym = symbols.find(s => s.name === expectedName);
                assert.ok(sym, `${keyword} + type + func: should find ${expectedName}`);
                assert.equal(sym.kind, expectedKind, `${keyword}: ${expectedName} should be ${expectedKind}`);
            }
        });

        // --- Column position accuracy (RI-42 regression) ---

        it('should preserve correct column position after stripping CODE_ATTR_ macro (Layer 2)', async () => {
            const code = 'void MODULE_A_MACRO HandleUpdate(void) {\n';
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'HandleUpdate');
            assert.ok(func, 'should find HandleUpdate');
            // 'void MODULE_A_MACRO ' is 20 chars, so HandleUpdate starts at col 20.
            assert.equal(func.col, 20, 'col should point to HandleUpdate in original source');
        });

        it('should preserve correct column position after stripping Layer 1 macro', async () => {
            const code = 'void SIMPLE_MACRO funcX(void) {\n';
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'funcX');
            assert.ok(func, 'should find funcX');
            assert.equal(func.col, 18, 'col should point to funcX in original source (col-18)');
        });

        it('should preserve correct column position after stripping Layer 3 macro', async () => {
            const code = 'UINT32 SECTION_ATTR my_func(void) {\n';
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'my_func');
            assert.ok(func, 'should find my_func');
            assert.equal(func.col, 20, 'col should point to my_func in original source (col-20)');
        });

        it('should preserve correct column for static + macro case', async () => {
            const code = 'static void MODULE_A_MACRO some_func(int x) {\n';
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'some_func');
            assert.ok(func, 'should find some_func');
            // 'static void MODULE_A_MACRO ' is 27 chars.
            assert.equal(func.col, 27, 'col should point to some_func in original source');
        });

        // --- Line number preservation when macro and function name span lines ---

        it('should preserve correct LINE when macro is on separate line from function name', async () => {
            const code = 'void MODULE_A_MACRO\nHandleUpdates(void) {\n}\n';
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'HandleUpdates');
            assert.ok(func, 'should find HandleUpdates');
            assert.equal(func.line, 1, 'line must be 1 (function name is on line 1 in original source)');
            assert.equal(func.col, 0, 'col must be 0 (function name starts at column 0 on line 1)');
        });

        it('should preserve line numbers for both functions when macros span lines', async () => {
            const code = [
                'void MODULE_A_MACRO',
                'HandleUpdates(void) {',
                '}',
                'void MODULE_A_MACRO ReleaseBuffer(uint32_t id) {',
                '}'
            ].join('\n') + '\n';
            const { symbols } = await index(code);

            const handleUpd = symbols.find(s => s.name === 'HandleUpdates');
            assert.ok(handleUpd, 'should find HandleUpdates');
            assert.equal(handleUpd.line, 1, 'HandleUpdates should be at line 1');
            assert.equal(handleUpd.col, 0, 'HandleUpdates col=0');

            const releaseBuf = symbols.find(s => s.name === 'ReleaseBuffer');
            assert.ok(releaseBuf, 'should find ReleaseBuffer');
            assert.equal(releaseBuf.line, 3, 'ReleaseBuffer should be at line 3');
            // 'void MODULE_A_MACRO ' is 20 chars.
            assert.equal(releaseBuf.col, 20, 'ReleaseBuffer col=20');
        });

        it('should preserve line when UINT32 type + macro spans lines', async () => {
            const code = 'UINT32 MODULE_A_MACRO\nHandleUpdates(void) {\n return 0;\n}\n';
            const { symbols } = await index(code);
            const func = symbols.find(s => s.name === 'HandleUpdates');
            assert.ok(func, 'should find HandleUpdates');
            assert.equal(func.line, 1, 'line must be 1 (original line of function name)');
            assert.equal(func.col, 0, 'col must be 0');
        });
    });

    // ==========================================================
    // nodeHasParseErrors - parse-error detection across web-tree-sitter shapes
    // ==========================================================
    describe('nodeHasParseErrors', () => {
        // Regression: in web-tree-sitter 0.25+ a node's hasError is a boolean
        // PROPERTY, not a method. A naive 'type === "ERROR"' check silently failed
        // for large files whose root stays 'translation_unit' while only an
        // interior node carries the error. Promoted to src/indexer/extract.ts.
        it('detects errors when hasError is a boolean property and root is translation_unit', () => {
            const node = { type: 'translation_unit', hasError: true };
            assert.equal(nodeHasParseErrors(node), true);
        });

        it('reports clean when hasError boolean property is false', () => {
            const node = { type: 'translation_unit', hasError: false };
            assert.equal(nodeHasParseErrors(node), false);
        });

        it('falls back to root type ERROR when no hasError is present', () => {
            assert.equal(nodeHasParseErrors({ type: 'ERROR' }), true);
            assert.equal(nodeHasParseErrors({ type: 'translation_unit' }), false);
        });

        it('treats a missing node as error-free', () => {
            assert.equal(nodeHasParseErrors(null), false);
            assert.equal(nodeHasParseErrors(undefined), false);
        });
    });
});
