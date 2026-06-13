/**
 * Code Insight Definition / References for a FIELD-DECLARATION cursor.
 *
 * The screenshot bug: cursor on a struct field declaration (e.g. the
 * function-pointer `data2`) listed every same-named field across the codebase
 * ("Definition 42") and all their references — because resolution only narrowed a
 * `field` token on a member access (`obj->field`), never at the declaration site
 * (no enclosing function, no member chain). The indexer now records the field's
 * owning aggregate on the ref, and resolution narrows by it.
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { scopeAt, definitionsAt, referencesAt } from '../src/features/symbolResolve';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('field-declaration cursor narrows Definition + References by owning struct', () => {
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

    async function build(): Promise<{ file: string; col: number }> {
        await store.index('/g.c', 'le16 data2;'); // unrelated global named data2
        await store.index('/other.h', 'struct other { int data2; };'); // unrelated same-named field
        const FILE = '/pq.h';
        const code = [
            'struct parity_calc_table {',
            '  void (*data2)(int, size_t);',
            '};',
        ].join('\n');
        await store.index(FILE, code);
        await store.index('/use.c', [
            'void f(struct parity_calc_table *r, struct other *o) {',
            '  r->data2;', // use of parity_calc_table.data2
            '  o->data2;', // use of other.data2
            '}',
        ].join('\n'));
        return { file: FILE, col: code.split('\n')[1].indexOf('data2') };
    }

    it('scopeAt reports the field declaration owner (the enclosing struct)', async () => {
        const { file, col } = await build();
        const scope = scopeAt(store.db, file, 'data2', 1, col);
        assert.equal(scope.role, 'field');
        assert.equal(scope.owner, 'parity_calc_table', 'owner is the enclosing struct, even for a fn-pointer field');
    });

    it('Definition lists only this struct field, not every same-named field', async () => {
        const { file, col } = await build();
        const scope = scopeAt(store.db, file, 'data2', 1, col);
        const defs = definitionsAt(store.db, 'data2', scope.role, file, { enclosingFunc: scope.func, owner: scope.owner }, false);
        assert.equal(defs.length, 1, 'exactly one field definition (parity_calc_table.data2)');
        assert.equal(defs[0].scope, 'parity_calc_table');
        assert.equal(defs[0].file, file);
    });

    it('References exclude a different struct’s same-named field', async () => {
        const { file, col } = await build();
        const scope = scopeAt(store.db, file, 'data2', 1, col);
        const refs = referencesAt(store.db, 'data2', scope.role, file, { enclosingFunc: scope.func, owner: scope.owner }, false, null);
        // every returned ref belongs to parity_calc_table (or is owner-unknown), never `other`
        assert.ok(refs.length >= 2, 'the declaration + the r->data2 use');
        assert.ok(refs.some((r) => r.file === '/use.c' && r.line === 1), 'includes the r->data2 use');
        assert.ok(!refs.some((r) => r.file === '/use.c' && r.line === 2), 'excludes the o->data2 use (struct other)');
        assert.ok(!refs.some((r) => r.owner === 'other'), 'no references owned by struct other');
    });
});
