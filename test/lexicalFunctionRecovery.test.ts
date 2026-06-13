/**
 * Function-definition recovery on the LIVE path.
 *
 * Background: tree-sitter-cpp can misread C comparison operators ('<') in
 * complex conditions as a template argument list; when it finds no matching '>',
 * the parse cascades into ERROR nodes that "swallow" the functions that follow.
 *
 * The legacy parser did *surgical* lexical recovery (findFunctionDefinitionsByText
 * supplemented the AST). The LIVE path has no such pass — `indexFile` falls back
 * to the grep scanner (`scanWithRegex`) whenever ERROR coverage is high, so
 * swallowed functions are recovered there instead. The per-header heuristic that
 * recovery relied on now lives in `src/indexer/grepScan.ts:looksLikeFuncDef`, and
 * the grep scanner drops control-flow keywords via its KEYWORDS set.
 *
 * Run: npm run test:unit
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { looksLikeFuncDef } from '../src/indexer/grepScan';
import { scanWithRegex } from '../src/indexer/regexScanner';
import { indexFile } from '../src/indexer/indexFile';
import { setupLiveParser } from './liveTestSetup';

// A condition shaped like the one in COR_HWD.c that makes tree-sitter-cpp
// swallow the functions after it.
const SWALLOWING_CONDITION = `void MODULE_A_MACRO Peek(Ctx_t* acc, int streamType)
{
    while (acc->mgr.canPeek &&
           acc->mgr.counter < acc->mgr.allowed[streamType] &&
           acc->ctxtCounter < acc->maxCtxSize &&
           (!IS_OPENED(acc->buf.id) || IHAS_ENDED((GET_INC(acc->buf, K)), acc->opId)))
    {
        runTask();
    }
}
`;

const INLINE_void_PrepareForWrite = `INLINE void PrepareForWrite()
{
    uint32_t fflba = 0;
    prepare(fflba);
}
`;

const void_MODULE_A_MACRO_HandleData = `void MODULE_A_MACRO HandleData(Ctxt_t* pHardwareContext, uint32_t id)
{
    use(pHardwareContext, id);
}
`;

/** True when `name`'s header line in `code` is recognised as a function definition. */
function headerLooksLikeDef(code: string, name: string): boolean {
    const lines = code.split('\n');
    const idx = lines.findIndex(l => new RegExp(`\\b${name}\\s*\\(`).test(l));
    return idx >= 0 && looksLikeFuncDef(lines, idx, name);
}

describe('looksLikeFuncDef - function-definition header heuristic', () => {
    it('recognises a simple top-level function definition', () => {
        const code = `int add(int a, int b)\n{\n    return a + b;\n}\n`;
        assert.ok(looksLikeFuncDef(code.split('\n'), 0, 'add'));
    });

    it('recognises a macro-attributed function definition', () => {
        const code = `void MODULE_A_MACRO HandleData(Ctxt_t* pHardwareContext, uint32_t id)\n{\n    use(pHardwareContext);\n}\n`;
        assert.ok(looksLikeFuncDef(code.split('\n'), 0, 'HandleData'), 'macro between type and name must not hide the def');
    });

    it('recognises an INLINE function with an empty parameter list', () => {
        const code = `INLINE void PrepareForWrite()\n{\n    prepare();\n}\n`;
        assert.ok(looksLikeFuncDef(code.split('\n'), 0, 'PrepareForWrite'));
    });

    it('recognises a function with a multi-line parameter list', () => {
        const code = `int many(int a,\n    int b,\n    int c)\n{\n    return a + b + c;\n}\n`;
        assert.ok(looksLikeFuncDef(code.split('\n'), 0, 'many'));
    });

    it('rejects a prototype (no braced body)', () => {
        const code = `int prototypeOnly(int a, int b);\n\nint realDef(void)\n{\n    return 0;\n}\n`;
        const lines = code.split('\n');
        assert.equal(looksLikeFuncDef(lines, 0, 'prototypeOnly'), false, 'prototype must be ignored');
        assert.ok(looksLikeFuncDef(lines, 2, 'realDef'), 'real definition must be recognised');
    });

    it('does not let the grep scanner emit a control-flow keyword as a function', () => {
        // looksLikeFuncDef trusts the caller's name; keyword filtering during
        // enumeration is the grep scanner's job (its KEYWORDS set). `int if(...){}`
        // must never produce an `if` function symbol.
        const r = scanWithRegex('int if(void) {\n}\n', 'x.c', 'c');
        assert.equal(r.symbols.filter(s => s.kind === 'function' && s.name === 'if').length, 0);
    });

    it('rejects an indented call site (not a column-0 definition header)', () => {
        const code = `int outer(int x)\n{\n    helper(x);\n    return x;\n}\n`;
        const lines = code.split('\n');
        assert.ok(looksLikeFuncDef(lines, 0, 'outer'));
        assert.equal(looksLikeFuncDef(lines, 2, 'helper'), false, 'an indented call must not look like a definition');
    });

    it('recognises every function header in the swallowing-condition fixture', () => {
        const code = SWALLOWING_CONDITION + INLINE_void_PrepareForWrite + void_MODULE_A_MACRO_HandleData;
        assert.ok(headerLooksLikeDef(code, 'Peek'), 'should recognise Peek');
        assert.ok(headerLooksLikeDef(code, 'PrepareForWrite'), 'should recognise PrepareForWrite');
        assert.ok(headerLooksLikeDef(code, 'HandleData'), 'should recognise HandleData');
    });
});

describe('indexFile recovers functions swallowed by a parse error', () => {
    before(async () => {
        await setupLiveParser();
    });

    it('indexes a function that follows a swallowing while-condition', async () => {
        const code = SWALLOWING_CONDITION + INLINE_void_PrepareForWrite + void_MODULE_A_MACRO_HandleData;
        const idx = await indexFile('COR_HWD.c', code, 'c');
        const names = idx.symbols.filter(s => s.kind === 'function').map(s => s.name);
        assert.ok(names.includes('PrepareForWrite'),
            `swallowed function "PrepareForWrite" must be indexed, got: [${names.join(', ')}]`);
        assert.ok(names.includes('HandleData'),
            `swallowed function "HandleData" must be indexed, got: [${names.join(', ')}]`);
    });

    it('also indexes the swallowed function with the two-fixture input', async () => {
        const code = SWALLOWING_CONDITION + INLINE_void_PrepareForWrite;
        const idx = await indexFile('COR_HWD.c', code, 'c');
        assert.ok(idx.symbols.some(s => s.kind === 'function' && s.name === 'PrepareForWrite'),
            'indexFile must recover PrepareForWrite');
    });

    it('does not duplicate functions that parsed cleanly', async () => {
        const code = `int alpha(int a)\n{\n    return a;\n}\n\nint beta(int b)\n{\n    return b;\n}\n`;
        const idx = await indexFile('clean.c', code, 'c');
        const alphas = idx.symbols.filter(s => s.kind === 'function' && s.name === 'alpha');
        assert.equal(alphas.length, 1, 'a clean parse must not produce duplicate function entries');
    });

    it('records outgoing calls for the recovered functions', async () => {
        const code = SWALLOWING_CONDITION + INLINE_void_PrepareForWrite + void_MODULE_A_MACRO_HandleData;
        const idx = await indexFile('COR_HWD.c', code, 'c');
        const fromPrepare = idx.calls.filter(c => c.caller === 'PrepareForWrite').map(c => c.callee);
        const fromHandle = idx.calls.filter(c => c.caller === 'HandleData').map(c => c.callee);
        assert.ok(fromPrepare.includes('prepare'),
            `PrepareForWrite should record its call to prepare(), got: [${fromPrepare.join(', ')}]`);
        assert.ok(fromHandle.includes('use'),
            `HandleData should record its call to use(), got: [${fromHandle.join(', ')}]`);
    });

    it('attributes a recovered call to its caller at the real call-site line', async () => {
        const code = SWALLOWING_CONDITION + INLINE_void_PrepareForWrite + void_MODULE_A_MACRO_HandleData;
        const idx = await indexFile('COR_HWD.c', code, 'c');
        const callSiteLine = code.split('\n').findIndex(l => l.includes('prepare(fflba'));
        const prepareCall = idx.calls.find(c => c.caller === 'PrepareForWrite' && c.callee === 'prepare');
        assert.ok(prepareCall, 'prepare() call should be recovered');
        assert.equal(prepareCall!.line, callSiteLine,
            'the recovered call must be recorded at its real call-site line');
    });
});
