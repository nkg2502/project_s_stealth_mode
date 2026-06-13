/**
 * Regression suite for review findings, re-pointed to the LIVE path.
 *
 * The legacy providers/typeResolver + providers/memberNarrowing are superseded by
 * the inline type-based member narrowing in features/resolve.ts (driven here via
 * resolveDefinition). Macro preservation through a parse hazard is verified via
 * the live indexFile.
 *
 * Run: npm run test:unit
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { findDefinitions } from '../src/store/db';
import { indexFile } from '../src/indexer/indexFile';
import { setupLiveParser, openLiveStore, resolveDefinitionAt, ROOT } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('Review Findings Regression Suite (live)', () => {
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

    // DEFERRED — parseWithRecovery was a legacy internal: re-parse with
    // preprocessed content when the first tree had embedded errors. The live
    // indexFile has no parse-retry; it falls back to the grep scanner on high
    // ERROR coverage (covered by lexicalFunctionRecovery.test.ts). Superseded
    // internal mechanism with no live entry point to drive.
    it.skip('retries parseWithRecovery when the initial tree has embedded errors', () => {
        // superseded by indexFile's errorRatio -> grep fallback
    });

    it('preserves macro definitions from cor_common.h even through a parse hazard', async () => {
        // Synthetic stand-in for the proprietary cor_common.h (in test/fixtures):
        // it pairs the #define under test with a parse-error-inducing function so
        // the fallback path runs and must not drop the macro.
        const filePath = path.join(ROOT, 'test', 'fixtures', 'cor_common.h');
        const content = fs.readFileSync(filePath, 'utf-8');
        const idx = await indexFile(filePath, content, 'c');
        const macro = idx.symbols.find(s => s.name === 'COR_BLOCK_MAX_XOR_ZONES' && s.kind === 'macro');
        assert.ok(macro, 'the #define symbol must survive even when the grep fallback runs');
    });

    it('prefers the local variable type over an unrelated same-named struct', async () => {
        const FILE = '/review.c';
        const code = [
            'struct Current_t { int field; };',  // line 0
            'struct Other_t { int field; };',    // line 1
            'void f(void) {',                    // line 2
            '\tCurrent_t *spec;',                // line 3
            '\tspec->field = 1;',                // line 4  (field at cols 6-10)
            '}',                                 // line 5
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 4, 7);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'narrowed by the declared type of the local spec');
        assert.equal(res!.hits[0].line, 0, 'jumps to Current_t.field, not Other_t.field');
    });

    it('keeps same-name members from different scopes in the same file', async () => {
        const FILE = '/members.h';
        const code = [
            'struct StructA { int field; };',  // line 0
            'struct StructB { int field; };',  // line 1
        ].join('\n');
        await store.index(FILE, code);
        const members = findDefinitions(store.db, 'field').filter(r => r.kind === 'field');
        assert.equal(members.length, 2, 'both scoped members should survive');
        assert.deepEqual(members.map(r => r.scope).sort(), ['StructA', 'StructB']);
    });

    it('prefers typedef alias metadata over same-file co-location when narrowing', async () => {
        const FILE = '/types.c';
        const code = [
            'struct Bar_s { int field; };',   // line 0
            'struct Foo_s { int field; };',   // line 1
            'typedef struct Foo_s Foo_t;',    // line 2
            'void use(Foo_t *o) {',           // line 3
            '\to->field = 1;',                // line 4  (field at cols 3-7)
            '}',                              // line 5
        ].join('\n');
        await store.index(FILE, code);
        const res = resolveDefinitionAt(store.db, FILE, code, 4, 4);
        assert.ok(res, 'should resolve');
        assert.equal(res!.hits.length, 1, 'should narrow to the alias-resolved scope only');
        assert.equal(res!.hits[0].line, 1, 'jumps to Foo_s.field (alias Foo_t -> Foo_s), not Bar_s.field');
    });
});
