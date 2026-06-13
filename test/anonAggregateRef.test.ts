/**
 * Field References must not leak a same-named field that belongs to an ANONYMOUS
 * aggregate. The real-world repro: `parity_calc_table.data2` (a function pointer
 * field) listed `sample_table[idx].data2` from an unrelated module,
 * where `sample_table` is an array of an *anonymous* struct:
 *
 *     static struct { u64 data1; u64 data2; u64 data3; } sample_table[NR_CPUS];
 *
 * An anonymous aggregate had no tag, so both the field declaration's owner and the
 * array's element type resolved to '' — indistinguishable from a genuinely
 * unresolved owner, which the best-effort filter always keeps. Anonymous aggregates
 * now get a synthetic, location-based tag so they carry a distinct identity and are
 * filtered out of an unrelated named struct's references.
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { scopeAt, referencesAt } from '../src/features/symbolResolve';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

describe('field References exclude an anonymous aggregate’s same-named field', () => {
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

    it('does not leak sample_table[idx].data2 (anon struct) into parity_calc_table.data2 refs', async () => {
        const PQ = '/pq.h';
        const pq = ['struct parity_calc_table {', '  void (*data2)(int);', '};'].join('\n');
        await store.index(PQ, pq);
        // sample_table is an array of an ANONYMOUS struct with a same-named field.
        const ERR = '/samples.c';
        const err = [
            'static struct {',
            '  unsigned long data1;',
            '  unsigned long data2;',
            '  unsigned long data3;',
            '} sample_table[4];',
            'void store_buf(int idx) {',
            '  sample_table[idx].data2 = 0;',
            '}',
        ].join('\n');
        await store.index(ERR, err);

        const col = pq.split('\n')[1].indexOf('data2');
        const scope = scopeAt(store.db, PQ, 'data2', 1, col);
        assert.equal(scope.owner, 'parity_calc_table');
        const refs = referencesAt(
            store.db, 'data2', scope.role, PQ,
            { enclosingFunc: scope.func, owner: scope.owner }, false, null,
        );
        assert.ok(
            !refs.some((r) => r.file === ERR),
            'the anonymous struct’s data2 (declaration AND use) must not appear in parity_calc_table.data2 references',
        );
        // sanity: the parity_calc field declaration itself is still listed.
        assert.ok(refs.some((r) => r.file === PQ && r.line === 1));
    });

    it('does not leak cmd.dma_block.data2 (anon-union member, named sub-struct) into parity_calc_table.data2 refs', async () => {
        // Real-world repro: a named member of an anonymous union; `dma_block` is a NAMED member of an
        // *anonymous union* inside `struct cmd_buf`; C promotes the union's members
        // into cmd_buf, so `cmd.dma_block` reaches it directly. The chain walk must
        // therefore find `dma_block` under `cmd_buf`'s tag and resolve `.data2` to
        // dma_block's (anonymous) struct — not leave it unresolved and leak into a
        // foreign struct's same-named field.
        const PQ = '/pq.h';
        const pq = ['struct parity_calc_table {', '  void (*data2)(int);', '};'].join('\n');
        await store.index(PQ, pq);
        const H = '/wifi_dev.h';
        // A real-world shape: a `__packed` attribute macro between `}` and the
        // member name, on BOTH the anonymous union and the named sub-struct. This
        // defeats tree-sitter (the macro is taken as the member name) — the recovery
        // must still produce a `dma_block` field owned by cmd_buf.
        await store.index(H, [
            'struct cmd_buf {',
            '  union {',
            '    unsigned int raw;',
            '    struct {',
            '      unsigned char cmd;',
            '      unsigned char data1;',
            '      unsigned char data2;',
            '    } __packed dma_block;',
            '  } __packed;',
            '};',
        ].join('\n'));
        const C = '/wifi_dev_core.c';
        await store.index(C, [
            'void set_dma(unsigned char arg2) {',
            '  struct cmd_buf cmd;',
            '  cmd.dma_block.data2 = arg2;',
            '}',
        ].join('\n'));

        const col = pq.split('\n')[1].indexOf('data2');
        const scope = scopeAt(store.db, PQ, 'data2', 1, col);
        assert.equal(scope.owner, 'parity_calc_table');
        const refs = referencesAt(
            store.db, 'data2', scope.role, PQ,
            { enclosingFunc: scope.func, owner: scope.owner }, false, null,
        );
        assert.ok(
            !refs.some((r) => r.file === C),
            'cmd.dma_block.data2 (a different struct, reached through an anonymous union) must not appear in parity_calc_table.data2 references',
        );
        assert.ok(refs.some((r) => r.file === PQ && r.line === 1), 'the parity_calc field declaration is still listed');
    });

    it('still narrows a use through the anonymous struct’s own variable to that struct', async () => {
        // Two anonymous structs, each with a `data2` field; a use through one must
        // resolve to that one (its synthetic tag), not list the other's field.
        const A = '/a.c';
        await store.index(A, [
            'static struct { int data2; } a_buf[2];',
            'void ua(void) { a_buf[0].data2 = 1; }',
        ].join('\n'));
        const B = '/b.c';
        await store.index(B, [
            'static struct { int data2; } b_buf[2];',
            'void ub(void) { b_buf[0].data2 = 1; }',
        ].join('\n'));

        // Cursor on the use a_buf[0].data2 in a.c — references must not include b.c.
        const aLine = 'void ua(void) { a_buf[0].data2 = 1; }';
        const col = aLine.indexOf('data2');
        const scope = scopeAt(store.db, A, 'data2', 1, col);
        const refs = referencesAt(
            store.db, 'data2', scope.role, A,
            { enclosingFunc: scope.func, owner: scope.owner, objChain: scope.objChain }, false, scope.func,
        );
        assert.ok(refs.some((r) => r.file === A), 'a.c use of a_buf.data2 is kept');
        assert.ok(
            !refs.some((r) => r.file === B),
            'b_buf.data2 (a different anonymous struct) must not leak into a_buf.data2 references',
        );
    });
});
