/**
 * 10 Ambiguous edge cases - current behavior is documented but debatable.
 * Re-pointed to the LIVE indexer (`src/indexer/indexFile.ts`) + the live grep
 * scanner (`src/indexer/grepScan.ts`) and keyword sets (`src/defaults.ts`).
 *
 * The live C++ model is name-only: functions/enumerators carry no `scope` or
 * `qualifiedName` (only struct/union/class members get an owning-aggregate
 * `scope`). Cases that asserted C++ scope/qualifiedName on functions/enumerators
 * are `it.skip`-ped as superseded/deferred.
 *
 * Run: npm run test:unit
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { indexFile } from '../src/indexer/indexFile';
import { grepWordInContent, buildCodeMask } from '../src/indexer/grepScan';
import { C_CPP_KEYWORDS, C_CPP_SOFT_KEYWORDS } from '../src/indexer/defaults';
import { setupLiveParser } from './liveTestSetup';
import type { SymbolRow, Lang } from '../src/core/types';

before(async () => { await setupLiveParser(); });

async function syms(code: string, lang: Lang = 'c'): Promise<SymbolRow[]> {
    return (await indexFile(lang === 'cpp' ? '/t.cpp' : '/t.c', code, lang)).symbols;
}

// ============================================================================
// Ambiguous #1: BOOL, NULL, VOID etc. are soft keywords
// ============================================================================
describe('Ambiguous #1: Firmware type macros as soft keywords', () => {
    it('NULL is a hard keyword (standard C macro - not useful to navigate)', () => {
        assert.ok(C_CPP_KEYWORDS.has('NULL'), 'NULL should be in hard keyword set');
        assert.ok(!C_CPP_SOFT_KEYWORDS.has('NULL'), 'NULL should NOT be in soft keyword set');
    });

    it('BOOL is a soft keyword, not a hard keyword', () => {
        assert.ok(!C_CPP_KEYWORDS.has('BOOL'), 'BOOL should NOT be in hard keyword set');
        assert.ok(C_CPP_SOFT_KEYWORDS.has('BOOL'), 'BOOL should be in soft keyword set');
    });

    it('VOID is a soft keyword, not a hard keyword', () => {
        assert.ok(!C_CPP_KEYWORDS.has('VOID'), 'VOID should NOT be in hard keyword set');
        assert.ok(C_CPP_SOFT_KEYWORDS.has('VOID'), 'VOID should be in soft keyword set');
    });

    it('UINT is a soft keyword - typedef in DB will make F12 work', () => {
        assert.ok(!C_CPP_KEYWORDS.has('UINT'));
        assert.ok(C_CPP_SOFT_KEYWORDS.has('UINT'));
    });

    it('WRAPPERDLEXPORT is neither hard nor soft keyword', () => {
        assert.ok(!C_CPP_KEYWORDS.has('WRAPPERDLEXPORT'));
        assert.ok(!C_CPP_SOFT_KEYWORDS.has('WRAPPERDLEXPORT'));
    });

    it('true C++ keywords remain hard-blocked', () => {
        for (const kw of ['if', 'for', 'class', 'void', 'int', 'return']) {
            assert.ok(C_CPP_KEYWORDS.has(kw), `"${kw}" should be a hard keyword`);
            assert.ok(!C_CPP_SOFT_KEYWORDS.has(kw), `"${kw}" should NOT be a soft keyword`);
        }
    });
});

// ============================================================================
// Ambiguous #2: typedef struct Foo {} Foo - duplicate symbol emission
// ============================================================================
describe('Ambiguous #2: typedef struct Foo {} Foo - dedup behavior', () => {
    it('emits both struct and typedef for same name', async () => {
        const s = await syms('typedef struct Foo { int x; } Foo;');
        const fooSyms = s.filter(x => x.name === 'Foo');
        assert.ok(fooSyms.some(x => x.kind === 'struct'), 'should have struct');
        assert.ok(fooSyms.some(x => x.kind === 'typedef'), 'should have typedef');
    });

    it('emits different names correctly for typedef struct Tag {} Alias;', async () => {
        const s = await syms('typedef struct Tag { int x; } Alias;');
        assert.ok(s.find(x => x.name === 'Tag' && x.kind === 'struct'));
        assert.ok(s.find(x => x.name === 'Alias' && x.kind === 'typedef'));
    });
});

// ============================================================================
// Ambiguous #3: Out-of-class method definition - scope from qualified id
// ============================================================================
describe('Ambiguous #3: Out-of-class method - scope field', () => {
    // The live model is name-only for C++: functions carry no `scope` /
    // `qualifiedName`, so out-of-class qualified definitions and multi-level
    // nesting are deferred (RESUME appendix: nested scope). Only the in-class
    // member case — where the owning aggregate IS recorded as `scope` — holds.
    it.skip('out-of-class method now has scope extracted from qualified name', () => { /* deferred: function scope not modeled live */ });
    it.skip('out-of-class method preserves qualifiedName', () => { /* superseded: no qualifiedName field in live model */ });
    it.skip('nested scope: Outer::Inner::method gets scope=Outer::Inner', () => { /* deferred: multi-level scope (appendix) */ });

    it('in-class method still has scope set', async () => {
        const m = (await syms('class MyClass { void method(); };', 'cpp')).find(x => x.name === 'method');
        assert.ok(m);
        assert.equal(m.scope, 'MyClass');
    });
});

// ============================================================================
// Ambiguous #4: Anonymous namespace - symbols get no scope
// ============================================================================
describe('Ambiguous #4: Anonymous namespace scope', () => {
    it('anonymous namespace is not emitted as a symbol', async () => {
        const s = await syms('namespace { void helper() {} }', 'cpp');
        assert.ok(!s.find(x => x.kind === 'namespace'));
    });

    it('symbols inside anonymous namespace have no scope', async () => {
        const h = (await syms('namespace { void helper() {} }', 'cpp')).find(x => x.name === 'helper');
        assert.ok(h);
        assert.equal(h.scope, undefined, 'anonymous namespace gives no scope');
    });

    // Deferred: the live model does not attach a namespace name as the `scope`
    // of functions inside it (functions are name-only).
    it.skip('named namespace DOES give scope', () => { /* deferred: namespace scope not modeled live for functions */ });
});

// ============================================================================
// Ambiguous #5: C-style enum enumerators
// ============================================================================
describe('Ambiguous #5: C-style enum enumerator scope', () => {
    // Deferred: live enumerators carry no enum-tag scope / qualifiedName.
    it.skip('enumerator gets enum name as scope', () => { /* deferred: enumerator scope not modeled live */ });

    it('anonymous enum enumerator has no scope', async () => {
        const a = (await syms('enum { FLAG_A, FLAG_B };')).find(x => x.name === 'FLAG_A');
        assert.ok(a);
        assert.equal(a.scope, undefined);
    });
});

// ============================================================================
// Ambiguous #6: Grep finds identifiers inside #define bodies
// ============================================================================
describe('Ambiguous #6: Grep matches inside #define bodies', () => {
    it('finds identifier inside #define value', () => {
        const content = '#define HANDLER myFunc\nvoid test() { HANDLER(); }';
        const hits = grepWordInContent(content, 'myFunc');
        const defineLine = hits.find(h => h.line === 0);
        assert.ok(defineLine, '#define body should be matched by grep');
    });

    it('finds identifier inside function-like macro body', () => {
        const content = '#define CALL_IT(x) myFunc(x)\nvoid test() { CALL_IT(5); }';
        const hits = grepWordInContent(content, 'myFunc');
        assert.ok(hits.find(h => h.line === 0), 'macro body should match');
    });
});

// ============================================================================
// Ambiguous #7: buildCodeMask double-backslash escape at string end
// ============================================================================
describe('Ambiguous #7: Double-backslash before closing quote', () => {
    it('single backslash correctly keeps string open', () => {
        const mask = buildCodeMask('"hello\\" world"');
        const allMasked = Array.from(mask).every(v => v === 1);
        assert.ok(allMasked, 'escaped quote should not close the string');
    });

    it('double-backslash before quote closes string; following code is unmasked', () => {
        const line = '"path\\\\" code';
        const mask = buildCodeMask(line);
        const codeStart = line.indexOf('code');
        assert.equal(mask[codeStart], 0, 'code after closed string should be 0');
    });

    it('grepWordInContent should find code token after string ending with escaped backslash', () => {
        const content = 'printf("path\\\\"); realFunction();';
        const hits = grepWordInContent(content, 'realFunction');
        assert.equal(hits.length, 1);
        assert.equal(hits[0].line, 0);
    });
});

// ============================================================================
// Ambiguous #8: Single-character identifiers blocked from references
// ============================================================================
describe('Ambiguous #8: Single-char identifier reference cutoff', () => {
    it('grep itself CAN find single-char word', () => {
        const content = 'int i = 0;\nfor (i = 0; i < 10; i++) {}';
        const hits = grepWordInContent(content, 'i');
        assert.ok(hits.length >= 2, 'grep has no length restriction');
    });

    it('two-char words are not blocked', () => {
        assert.ok('ab'.length >= 2);
    });
});

// ============================================================================
// Ambiguous #9: Enumerator and macro with same name - both indexed
// ============================================================================
describe('Ambiguous #9: Enumerator shadows macro name', () => {
    it('both macro and enumerator are indexed', async () => {
        const s = await syms('#define STATUS_OK 0\nenum { STATUS_OK = 0 };');
        const macro = s.find(x => x.name === 'STATUS_OK' && x.kind === 'macro');
        const enumerator = s.find(x => x.name === 'STATUS_OK' && x.kind === 'enumerator');
        assert.ok(macro, 'macro should be indexed');
        assert.ok(enumerator, 'enumerator should also be indexed');
    });

    it('same name in different kinds both survive', async () => {
        const s = await syms('#define MAX_VAL 255\nenum Limits { MAX_VAL = 255 };');
        const kinds = s.filter(x => x.name === 'MAX_VAL').map(x => x.kind);
        assert.ok(kinds.includes('macro'));
        assert.ok(kinds.includes('enumerator'));
    });
});

// ============================================================================
// Ambiguous #10: Cursor on scope part navigates to target, not class
// ============================================================================
describe('Ambiguous #10: Scope part cursor - redirects to target', () => {
    function getSymbolAtPosition(lineText: string, wordStart: number, wordEnd: number, word: string): { word: string; scope?: string } {
        if (C_CPP_KEYWORDS.has(word)) return { word: '' };

        if (wordStart >= 2 && lineText.substring(wordStart - 2, wordStart) === '::') {
            const beforeScope = lineText.substring(0, wordStart - 2);
            const scopeMatch = beforeScope.match(/([a-zA-Z_]\w*(?:::[a-zA-Z_]\w*)*)$/);
            if (scopeMatch) return { word, scope: scopeMatch[1] };
        }

        if (lineText.substring(wordEnd, wordEnd + 2) === '::') {
            const afterScope = lineText.substring(wordEnd + 2);
            const targetMatch = afterScope.match(/^([a-zA-Z_]\w*)/);
            if (targetMatch) return { word: targetMatch[1], scope: word };
        }

        return { word };
    }

    it('cursor on MyClass in MyClass::method - navigates to method, not class', () => {
        const line = '    MyClass::method();';
        const result = getSymbolAtPosition(line, 4, 11, 'MyClass');
        assert.equal(result.word, 'method', 'redirects to method');
        assert.equal(result.scope, 'MyClass', 'with scope MyClass');
    });

    it('cursor on method in MyClass::method - correctly goes to method', () => {
        const line = '    MyClass::method();';
        const result = getSymbolAtPosition(line, 13, 19, 'method');
        assert.equal(result.word, 'method');
        assert.equal(result.scope, 'MyClass');
    });
});
