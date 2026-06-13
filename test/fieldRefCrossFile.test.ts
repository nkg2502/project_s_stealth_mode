/**
 * Field References must narrow by the object's REAL (cross-file) type, not a name
 * match. The indexer resolves a field-use owner only from same-file info, so a use
 * through a cross-file object (e.g. a global declared in another file) gets owner=''
 * and — under the best-effort "keep unknown owners" rule — leaked into an unrelated
 * struct's references. Resolution now re-derives the owner from the object chain
 * against the full DB at query time.
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { scopeAt, referencesAt } from '../src/features/symbolResolve';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('field References narrowed by the object real type (cross-file)', () => {
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

    it('excludes a cross-file global object’s same-named field use from another struct', async () => {
        // The field of interest: parity_calc_table.data2 (a function pointer).
        const PQ = '/pq.h';
        const pq = ['struct parity_calc_table {', '  void (*data2)(int);', '};'].join('\n');
        await store.index(PQ, pq);
        // An unrelated struct pkt with a same-named field, and a GLOBAL of that type
        // declared in pkt.h — so its use in use.c can't be typed at index time.
        await store.index('/pkt.h', ['struct pkt { int data2; };', 'struct pkt g_pkt;'].join('\n'));
        await store.index('/use.c', ['void h(void) {', '  g_pkt.data2;', '}'].join('\n'));

        const col = pq.split('\n')[1].indexOf('data2');
        const scope = scopeAt(store.db, PQ, 'data2', 1, col);
        assert.equal(scope.owner, 'parity_calc_table');
        const refs = referencesAt(
            store.db, 'data2', scope.role, PQ,
            { enclosingFunc: scope.func, owner: scope.owner }, false, null,
        );
        assert.ok(
            !refs.some((r) => r.file === '/use.c'),
            'g_pkt.data2 (struct pkt, resolved cross-file) must not appear in parity_calc_table.data2 references',
        );
        // sanity: the parity_calc declaration itself is still there
        assert.ok(refs.some((r) => r.file === PQ && r.line === 1));
    });

    it('keeps a cross-file use that DOES resolve to the target struct', async () => {
        const PQ = '/pq.h';
        const pq = ['struct parity_calc_table {', '  void (*data2)(int);', '};'].join('\n');
        await store.index(PQ, pq);
        // a global of the TARGET type, declared in another file, used in use.c
        await store.index('/glob.h', 'struct parity_calc_table g_calc;');
        await store.index('/use.c', ['void h(void) {', '  g_calc.data2;', '}'].join('\n'));

        const col = pq.split('\n')[1].indexOf('data2');
        const scope = scopeAt(store.db, PQ, 'data2', 1, col);
        const refs = referencesAt(
            store.db, 'data2', scope.role, PQ,
            { enclosingFunc: scope.func, owner: scope.owner }, false, null,
        );
        assert.ok(
            refs.some((r) => r.file === '/use.c' && r.line === 1),
            'g_calc.data2 resolves cross-file to parity_calc_table and is kept',
        );
    });
});
