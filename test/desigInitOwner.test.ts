/**
 * Designated-initializer field owner resolution (`indexer/enclosingFunc`-adjacent
 * work in extract.ts). A `.field = …` designator has no object expression — per C
 * §6.7.9 its owner is the "current object", i.e. the aggregate being initialized.
 * extract.ts previously left these `owner=''`, so a foreign struct's `.data2 = …`
 * (e.g. `struct msg_send_direct_data data = { .data2 = … }`) leaked into the
 * references of an unrelated `parity_calc_table.data2` (best-effort keeps unknown
 * owners). We now resolve the DETERMINISTIC cases — `.f`, `.a.b`, and nested
 * designated braces `{ .inner = { .f } }` — by recovering the enclosing
 * declaration / compound-literal type. POSITIONAL nesting (`{ {…}, {…} }`) needs
 * member-ordering state and stays best-effort.
 *
 * (Red baseline: an AST/owner probe showed these designated refs had owner='' on
 * every offending file before this change.)
 *
 * Run: npm run test:unit
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { getParser } from '../src/indexer/parser';
import { extractFromTree } from '../src/indexer/extract';
import { scopeAt, referencesAt } from '../src/features/symbolResolve';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

async function ownerOf(code: string, name: string, line: number): Promise<{ owner: string; objChain: string }> {
  const parser = await getParser('c');
  const tree = parser.parse(code)!;
  try {
    const { refs } = extractFromTree(tree, 't.c', 'c');
    const r = refs.find((x) => x.role === 'field' && x.name === name && x.line === line);
    return { owner: r?.owner ?? '<none>', objChain: (r?.objChain as string) ?? '' };
  } finally {
    tree.delete();
  }
}

describe('designated-initializer owner (deterministic cases)', () => {
  before(async () => { await setupLiveParser(); });

  it('(a) flat: owner is the declared aggregate, no struct def needed', async () => {
    const { owner } = await ownerOf('struct msg_send_direct_data data = { .data2 = 5 };\n', 'data2', 0);
    assert.equal(owner, 'msg_send_direct_data');
  });

  it('(b) nested designator .a.b: each level owned by the right type', async () => {
    const code = [
      'struct Inner { int b; };',
      'struct T { struct Inner a; };',
      'struct T x = { .a.b = 5 };',
    ].join('\n');
    assert.equal((await ownerOf(code, 'a', 2)).owner, 'T', '`a` is owned by T');
    assert.equal((await ownerOf(code, 'b', 2)).owner, 'Inner', '`b` is owned by Inner (the type of field `a`)');
  });

  it('(c) nested braces: inner field owned by the inner aggregate', async () => {
    const code = [
      'struct Inner { int data2; };',
      'struct Outer { struct Inner inner; };',
      'struct Outer o = { .inner = { .data2 = 5 } };',
    ].join('\n');
    assert.equal((await ownerOf(code, 'inner', 2)).owner, 'Outer', '`inner` is owned by Outer');
    assert.equal((await ownerOf(code, 'data2', 2)).owner, 'Inner', '`data2` is owned by Inner');
  });

  it('(d) positional nesting stays best-effort (owner unresolved)', async () => {
    // `{ { .data2 } }` — the inner brace is a POSITIONAL element (no designator), so
    // we do not model the current object; owner is left '' (kept best-effort).
    const { owner, objChain } = await ownerOf('struct T arr[] = { { .data2 = 5 } };\n', 'data2', 0);
    assert.equal(owner, '', 'positional element owner is not inferred');
    assert.equal(objChain, '', 'no object chain recorded for the positional case');
  });
});

describe('field References exclude a FOREIGN-struct designated initializer', () => {
  let store: LiveStore;
  before(async () => { await setupLiveParser(); });
  beforeEach(() => { store = openLiveStore(); });
  afterEach(() => { store.close(); });

  it('drops a different struct’s .data2 = …, keeps the target struct’s', async () => {
    const PQ = '/pq.h';
    const pq = ['struct parity_calc_table {', '  void (*data2)(int);', '};'].join('\n');
    await store.index(PQ, pq);
    // A foreign struct initialized with a designated `.data2` — must NOT be listed.
    await store.index('/ffa.c', ['struct msg_send_direct_data d = {', '  .data2 = 5,', '};'].join('\n'));
    // The TARGET struct initialized with a designated `.data2` — must be listed.
    await store.index('/use.c', ['struct parity_calc_table rc = {', '  .data2 = 0,', '};'].join('\n'));

    const col = pq.split('\n')[1].indexOf('data2');
    const scope = scopeAt(store.db, PQ, 'data2', 1, col);
    assert.equal(scope.owner, 'parity_calc_table');
    const refs = referencesAt(
      store.db, 'data2', scope.role, PQ,
      { enclosingFunc: scope.func, owner: scope.owner }, false, null,
    );
    assert.ok(!refs.some((r) => r.file === '/ffa.c'),
      'msg_send_direct_data.data2 (designated init) must not appear in parity_calc_table.data2 references');
    assert.ok(refs.some((r) => r.file === '/use.c'),
      'parity_calc_table.data2 designated init must be kept');
  });
});
