/**
 * A struct FIELD's references must not be polluted by same-named LOCAL VARIABLES
 * in grep-fallback files. User case: the `data2` function-pointer field of
 * `struct parity_calc_table` (pq.h) listed `data2 = temp - …` etc. from a local
 * `unsigned short data2` in a large vendor driver file — one that falls to
 * the grep scanner (errorRatio high), where every identifier is recorded with
 * `role=''` and the References query keeps role='' rows blanket via `OR r.role=''`.
 *
 * Fix: the grep scanner can reliably spot ONE thing — a member access (`.x` /
 * `->x`) — and tags those `role='field'`. A field cursor's References then require
 * an exact `role='field'` (no blanket grep keep), excluding plain (non-member)
 * grep uses while keeping genuine `->field` accesses. Value/type cursors keep the
 * best-effort grep rows (role='') as before.
 *
 * Run: npx tsc -p tsconfig.test.json && node --test out/test/fieldRefGrepNarrow.test.js
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanWithRegex } from '../src/indexer/regexScanner';
import { findReferences } from '../src/store/db';
import { openLiveStore, setupLiveParser } from './liveTestSetup';
import type { FileIndex } from '../src/core/types';

const GREP = `void f(void)
{
\tint data2 = 0;
\tdata2 = data2 + 1;
\tuse(p->data2);
\ts.data2 = 3;
}
`;

describe('grep scanner: member-access gets role=field', () => {
  it('tags ->x and .x occurrences role=field, plain ones role=""', () => {
    const r = scanWithRegex(GREP, 'g.c', 'c');
    const d = r.refs.filter((x) => x.name === 'data2');
    const fieldRoled = d.filter((x) => x.role === 'field').length;
    const plain = d.filter((x) => x.role === '').length;
    assert.equal(fieldRoled, 2, `p->data2 and s.data2 → field; got field=${fieldRoled}, plain=${plain}`);
    assert.ok(plain >= 3, `the decl + two plain uses stay role=""; got plain=${plain}`);
  });
});

describe('findReferences: a field cursor excludes plain grep uses', () => {
  before(async () => { await setupLiveParser(); });

  it('keeps only member-access grep refs for a field, all grep refs for a value', () => {
    const store = openLiveStore();
    try {
      const fi: FileIndex = {
        file: 'g.c', hash: 'h', parsedBy: 'grep', locals: [], aliases: [],
        ...scanWithRegex(GREP, 'g.c', 'c'),
      };
      store.writer.applyBatch([{ fi, mtime: 1 }]);

      // FIELD cursor: only the two member accesses (p->data2, s.data2).
      const asField = findReferences(store.db, 'data2', 'field');
      assert.equal(asField.length, 2, `field refs should be the 2 member accesses, got ${asField.length}`);

      // VALUE cursor: best-effort keeps the plain (role='') uses, drops the member accesses.
      const asValue = findReferences(store.db, 'data2', 'value');
      assert.ok(asValue.length >= 3, `value refs keep the plain grep uses, got ${asValue.length}`);
      assert.ok(!asValue.some((r) => r.line === 4 || r.line === 5),
        'a value cursor must not list the ->data2 / .data2 member accesses');
    } finally {
      store.close();
    }
  });
});
