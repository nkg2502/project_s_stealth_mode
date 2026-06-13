/**
 * Code Insight: a scope-local variable must not adopt the call relations of a
 * same-named GLOBAL function.
 *
 * Repro (user report): `dir_edit.c` has `u64 bitmap;` as a function-body local.
 * Elsewhere a function `test_pointer` contains a call `bitmap(...)`, so the call
 * graph has an edge `test_pointer -> bitmap`. With the cursor on the *local*
 * `bitmap` declaration, Code Insight's "Called by" listed `test_pointer` — it
 * resolved the call graph by bare name, ignoring that the cursor symbol is a
 * local (not a function). A local can never be called via the global call graph,
 * so its "Called by" / "Calls" must be empty.
 *
 * Run: npm run test:unit
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { findCallers, refAt } from '../src/store/db';
import { callRelations } from '../src/features/callGraph';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

// The view derives scope from `scopeAt` (resolve.ts), which top-level `require`s
// vscode and so can't be imported under `node --test`. `scopeAt` is a thin
// wrapper over the vscode-free `refAt`, whose `is_local`/`enclosing_func` are the
// exact scope signals the Code Insight view consults — use them directly.
const scopeAt = (db: LiveStore['db'], file: string, name: string, line: number, col: number) => {
  const ref = refAt(db, file, name, line, col);
  return { isLocal: ref?.isLocal ?? false, func: ref?.enclosingFunc ?? null };
};

const FILE = '/dir_edit.c';
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

// `dir_edit` declares a local `u64 bitmap;`. `test_pointer` calls a same-named
// global function `bitmap(...)`, seeding a `test_pointer -> bitmap` call edge.
const SRC = [
  'void bitmap(int x);',                 // 0: a global function named bitmap
  '',                                    // 1
  'void test_pointer(void) {',           // 2
  '    bitmap(1);',                      // 3: call site -> findCallers(bitmap) = test_pointer
  '}',                                   // 4
  '',                                    // 5
  'void dir_edit(void) {',               // 6
  '    u64 bitmap;',                     // 7: the LOCAL the cursor sits on
  '    bitmap = 0;',                     // 8
  '}',                                   // 9
  '',
].join('\n');

describe('Code Insight call relations are scope-aware (local var bitmap)', () => {
  it('records the call edge test_pointer -> bitmap (data sanity)', async () => {
    await store.index(FILE, SRC);
    const callers = findCallers(store.db, 'bitmap');
    assert.ok(
      callers.some((c) => c.caller === 'test_pointer'),
      'expected a call edge test_pointer -> bitmap to exist',
    );
  });

  it('treats the cursor on `u64 bitmap;` as a local', async () => {
    await store.index(FILE, SRC);
    const col = SRC.split('\n')[7].indexOf('bitmap');
    const scope = scopeAt(store.db, FILE, 'bitmap', 7, col);
    assert.equal(scope.isLocal, true, 'cursor on the local declaration must be scope-local');
    assert.equal(scope.func, 'dir_edit');
  });

  it('shows NO "Called by" for the local bitmap (the bug)', async () => {
    await store.index(FILE, SRC);
    const col = SRC.split('\n')[7].indexOf('bitmap');
    const scope = scopeAt(store.db, FILE, 'bitmap', 7, col);
    const callers = callRelations(store.db, 'callers', 'bitmap', scope.isLocal);
    assert.equal(callers.length, 0, 'a local variable must not list a same-named function\'s callers');
  });

  it('still shows the global function bitmap\'s callers when NOT local', async () => {
    await store.index(FILE, SRC);
    const callers = callRelations(store.db, 'callers', 'bitmap', /*isLocal*/ false);
    assert.ok(
      callers.some((n) => n.name === 'test_pointer'),
      'a non-local symbol must still resolve the global call graph',
    );
  });
});
