/**
 * Field References must narrow by more object base shapes than a plain name chain:
 *   - a CAST base `((struct X *)p)->f` — the owning struct is stated outright by the
 *     cast type (resolved same-file at index time).
 *   - a CALL base `get_obj()->f` — the owner is the callee's return type, which may
 *     live in another file (resolved cross-file at query time via the `@call:` marker).
 * Both close residual `owner=''` false positives in the References list. Mirrors
 * test/fieldRefCrossFile.test.ts.
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { scopeAt, referencesAt, definitionsAt } from '../src/features/symbolResolve';
import type { MemberCtx } from '../src/features/symbolResolve';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('field References narrowed by cast / call object bases', () => {
    let store: LiveStore;
    const PQ = '/pq.h';
    const pq = ['struct parity_calc_table {', '  void (*data2)(int);', '};'].join('\n');
    before(async () => {
        await setupLiveParser();
    });
    beforeEach(() => {
        store = openLiveStore();
    });
    afterEach(() => {
        store.close();
    });

    const refsForData2 = () => {
        const col = pq.split('\n')[1].indexOf('data2');
        const scope = scopeAt(store.db, PQ, 'data2', 1, col);
        assert.equal(scope.owner, 'parity_calc_table');
        return referencesAt(
            store.db, 'data2', scope.role, PQ,
            { enclosingFunc: scope.func, owner: scope.owner }, false, null,
        );
    };

    it('excludes a cast to a different struct from the target field references', async () => {
        await store.index(PQ, pq);
        await store.index('/pkt.h', 'struct pkt { int data2; };');
        await store.index('/use.c', ['void h(void *p) {', '  ((struct pkt *)p)->data2;', '}'].join('\n'));
        const refs = refsForData2();
        assert.ok(
            !refs.some((r) => r.file === '/use.c'),
            '((struct pkt *)p)->data2 belongs to struct pkt, not parity_calc_table',
        );
        assert.ok(refs.some((r) => r.file === PQ && r.line === 1), 'the parity_calc declaration is still there');
    });

    it('keeps a cast to the target struct in the field references', async () => {
        await store.index(PQ, pq);
        await store.index('/use.c', ['void h(void *p) {', '  ((struct parity_calc_table *)p)->data2;', '}'].join('\n'));
        const refs = refsForData2();
        assert.ok(
            refs.some((r) => r.file === '/use.c' && r.line === 1),
            '((struct parity_calc_table *)p)->data2 resolves to the target struct and is kept',
        );
    });

    it('excludes a call returning a different struct (cross-file return type) from the references', async () => {
        await store.index(PQ, pq);
        // get_pkt's return type lives in another file → can't be typed at index time;
        // the @call marker lets References resolve it cross-file. Prototype: is_definition=0.
        await store.index('/pkt.h', ['struct pkt { int data2; };', 'struct pkt *get_pkt(void);'].join('\n'));
        await store.index('/use.c', ['void h(void) {', '  get_pkt()->data2;', '}'].join('\n'));
        const refs = refsForData2();
        assert.ok(
            !refs.some((r) => r.file === '/use.c'),
            'get_pkt() returns struct pkt, so its ->data2 is not a parity_calc_table reference',
        );
    });

    it('keeps a call returning the target struct in the references', async () => {
        await store.index(PQ, pq);
        await store.index('/glob.h', 'struct parity_calc_table *get_calc(void);');
        await store.index('/use.c', ['void h(void) {', '  get_calc()->data2;', '}'].join('\n'));
        const refs = refsForData2();
        assert.ok(
            refs.some((r) => r.file === '/use.c' && r.line === 1),
            'get_calc() returns parity_calc_table (resolved cross-file) and is kept',
        );
    });
});

describe('cursor-side Definition/References narrowed by a cross-file call base (#4b/#5)', () => {
    // The cursor sits ON `get_pkt()->data2` in use.c. The index-time owner is '' (the
    // callee's return type lives in another file), so the cursor side must re-derive
    // the owner from the stored AST object chain (`@call:get_pkt`), the same way
    // References does — narrowing Definition AND the References target to struct pkt.
    let store: LiveStore;
    before(async () => {
        await setupLiveParser();
    });
    beforeEach(async () => {
        store = openLiveStore();
        await store.index('/pq.h', ['struct parity_calc_table {', '  void (*data2)(int);', '};'].join('\n'));
        await store.index('/pkt.h', ['struct pkt { int data2; };', 'struct pkt *get_pkt(void);'].join('\n'));
        await store.index('/use.c', ['void h(void) {', '  get_pkt()->data2;', '}'].join('\n'));
    });
    afterEach(() => {
        store.close();
    });

    const cursorMember = () => {
        const line = '  get_pkt()->data2;';
        const col = line.indexOf('data2');
        const scope = scopeAt(store.db, '/use.c', 'data2', 1, col);
        const member: MemberCtx = {
            objectName: undefined,
            memberChain: [],
            enclosingFunc: scope.func,
            owner: scope.owner,
            objChain: scope.objChain,
        };
        return { scope, member };
    };

    it('Definition narrows get_pkt()->data2 to struct pkt, not parity_calc_table', () => {
        const { scope, member } = cursorMember();
        assert.equal(scope.objChain, '@call:get_pkt', 'cursor ref carries the call marker chain');
        const defs = definitionsAt(store.db, 'data2', scope.role, '/use.c', member, true);
        const scopes = new Set(defs.map((d) => d.scope));
        assert.ok(scopes.has('pkt'), 'pkt.data2 is a definition');
        assert.ok(!scopes.has('parity_calc_table'), 'parity_calc_table.data2 is narrowed out');
    });

    it('References from the use site narrow to struct pkt', () => {
        const { scope, member } = cursorMember();
        const refs = referencesAt(store.db, 'data2', scope.role, '/use.c', member, false, scope.func);
        // parity_calc_table.data2 lives in /pq.h — it must NOT be in pkt's references.
        assert.ok(!refs.some((r) => r.file === '/pq.h'), 'parity_calc field declaration excluded from pkt references');
        assert.ok(refs.some((r) => r.file === '/use.c' && r.line === 1), 'the get_pkt()->data2 use itself is kept');
    });
});
