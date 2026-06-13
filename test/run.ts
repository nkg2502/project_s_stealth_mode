import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import assert from 'node:assert/strict';
import { fuzzyFilterSymbols } from '../src/store/fuzzyMatch';
import { tagKindBefore } from '../src/features/typeTag';
import { isCallTarget, narrowCallTarget } from '../src/features/callContext';
import { WorkerPool } from '../src/indexer/workerPool';
import { configureAssets, disposeParsers, initParser } from '../src/indexer/parser';
import { indexFile } from '../src/indexer/indexFile';
import { scanWithRegex } from '../src/indexer/regexScanner';
import { callChildren, hasCallChildren } from '../src/features/callGraph';
import { isRefRole, kindsForRole, narrowByRole, roleForNodeType } from '../src/core/refRole';
import { IndexGate } from '../src/core/indexGate';
import { computeIndexPlan } from '../src/core/indexPlan';
import { groupReferencesByFile, snippetLabel } from '../src/features/refGroups';
import {
  countSymbolsForFile,
  createWriter,
  enclosingFuncAt,
  ensureSchema,
  findCallees,
  findCallers,
  findDefinitions,
  findLocal,
  findLocalReferences,
  findReferences,
  findTypedefTarget,
  getFileMeta,
  openDb,
  refAt,
  schemaVersionFor,
  searchSymbolNames,
} from '../src/store/db';
import type { RefHit } from '../src/store/db';
import type { FileIndex } from '../src/core/types';

// Headless indexer tests (no vscode). Run via: npm test
const root = process.cwd();
const fixtures = path.join(root, 'test', 'fixtures');

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  configureAssets({
    runtimeWasmPath: path.join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    grammarPaths: {
      c: path.join(root, 'node_modules', 'tree-sitter-c', 'tree-sitter-c.wasm'),
      cpp: path.join(root, 'node_modules', 'tree-sitter-cpp', 'tree-sitter-cpp.wasm'),
    },
  });
  await initParser();

  try {
  const sample = fs.readFileSync(path.join(fixtures, 'sample.c'), 'utf8');

  // 1) tree-sitter extraction
  const idx = await indexFile('sample.c', sample, 'c');
  const names = new Set(idx.symbols.map((s) => s.name));
  check('parsed by tree-sitter', () => assert.equal(idx.parsedBy, 'ts'));
  for (const n of [
    'MAX_LEN', 'my_int_t', 'Point', 'Color', 'RED', 'GREEN', 'BLUE',
    'helper', 'main', 'done', 'disabled_function',
  ]) {
    check(`symbol present: ${n}`, () => assert.ok(names.has(n), `missing ${n}`));
  }
  check('comment identifiers excluded (symbols)', () => {
    assert.ok(!names.has('comment_only'));
    assert.ok(!names.has('block_only'));
    assert.ok(!names.has('must_not_index'));
  });
  check('comment identifiers excluded (refs)', () =>
    assert.ok(!idx.refs.some((r) => r.name === 'comment_only' || r.name === 'block_only')));
  check('#if 0 body indexed', () => assert.ok(names.has('disabled_function')));
  check('goto label "done"', () =>
    assert.ok(idx.symbols.some((s) => s.name === 'done' && s.kind === 'label')));
  check('main is a function definition', () =>
    assert.ok(idx.symbols.some((s) => s.name === 'main' && s.kind === 'function' && s.isDefinition)));
  check('helper has a prototype symbol', () =>
    assert.ok(idx.symbols.some((s) => s.name === 'helper' && s.kind === 'prototype')));
  check('call edge main -> helper', () =>
    assert.ok(idx.calls.some((c) => c.caller === 'main' && c.callee === 'helper')));

  // 2) regex scanner (fallback) directly
  const r = scanWithRegex(sample, 'sample.c', 'c');
  const rnames = new Set(r.symbols.map((s) => s.name));
  check('grep: all rows source=grep', () => assert.ok(r.symbols.every((s) => s.source === 'grep')));
  for (const n of ['MAX_LEN', 'my_int_t', 'Point', 'Color', 'helper', 'main', 'done']) {
    check(`grep symbol present: ${n}`, () => assert.ok(rnames.has(n), `grep missing ${n}`));
  }
  check('grep: comment identifiers excluded', () => {
    assert.ok(!rnames.has('comment_only') && !rnames.has('block_only'));
    assert.ok(!r.refs.some((x) => x.name === 'comment_only' || x.name === 'block_only'));
  });

  // 3) size limit forces grep
  const small = await indexFile('sample.c', sample, 'c', {
    maxFileSizeBytes: 1,
    errorRatioThreshold: 0.25,
    parseTimeoutMicros: 0,
  });
  check('size limit forces grep', () => {
    assert.equal(small.parsedBy, 'grep');
    assert.ok(small.symbols.length > 0);
  });

  // 4) high error ratio forces grep
  const broken = fs.readFileSync(path.join(fixtures, 'broken.c'), 'utf8');
  const b = await indexFile('broken.c', broken, 'c', {
    maxFileSizeBytes: 2048 * 1024,
    errorRatioThreshold: 0,
    parseTimeoutMicros: 0,
  });
  check('high error ratio forces grep', () => assert.equal(b.parsedBy, 'grep'));

  // 5) SQLite store: apply + queries + incremental replacement
  const db = openDb(':memory:');
  const writer = createWriter(db);
  writer.apply(idx, 1000);
  check('store: main definition found', () =>
    assert.ok(findDefinitions(db, 'main').some((s) => s.kind === 'function')));
  check('store: helper called by main', () =>
    assert.ok(findCallers(db, 'helper').some((c) => c.caller === 'main')));
  check('store: main calls helper', () =>
    assert.ok(findCallees(db, 'main').some((c) => c.callee === 'helper')));
  check('store: file meta recorded', () =>
    assert.equal(getFileMeta(db).get('sample.c')?.hash, idx.hash));
  const reduced = { ...idx, symbols: idx.symbols.slice(0, 1) };
  writer.apply(reduced, 2000);
  check('store: incremental replace (rows not appended)', () =>
    assert.equal(countSymbolsForFile(db, 'sample.c'), 1));
  check('store: mtime updated on reindex', () =>
    assert.equal(getFileMeta(db).get('sample.c')?.mtime, 2000));
  writer.remove('sample.c');
  check('store: remove clears file rows', () =>
    assert.equal(countSymbolsForFile(db, 'sample.c'), 0));
  db.close();

  // 6) F10 search: SQLite candidate fetch (searchSymbolNames) + JS fzf rank
  const fdb = openDb(':memory:');
  const fwriter = createWriter(fdb);
  const namesIdx: FileIndex = {
    file: 'names.c',
    hash: '',
    parsedBy: 'ts',
    symbols: [
      { name: 'helper', kind: 'function', file: 'names.c', line: 1, col: 0, endLine: 1, endCol: 0, isDefinition: true, source: 'ts' },
      { name: 'main', kind: 'function', file: 'names.c', line: 2, col: 0, endLine: 2, endCol: 0, isDefinition: true, source: 'ts' },
      { name: 'MAX_LEN', kind: 'macro', file: 'names.c', line: 3, col: 0, endLine: 3, endCol: 0, isDefinition: true, source: 'ts' },
    ],
    refs: [],
    calls: [],
    locals: [],
    aliases: [],
  };
  fwriter.apply(namesIdx, 1000);
  check('fuzzy: subsequence "hlp" matches helper', () =>
    assert.ok(fuzzyFilterSymbols(searchSymbolNames(fdb, 'hlp'), 'hlp', 10).some((h) => h.item.name === 'helper')));
  check('fuzzy: exact match ranks first', () =>
    assert.equal(fuzzyFilterSymbols(searchSymbolNames(fdb, 'main'), 'main', 10)[0]?.item.name, 'main'));
  fdb.close();

  // 6b) struct fields (global) + scope-local parameters/variables
  const scopeSrc = [
    'struct point { int x; int y; };',
    'int add(int a, int b) {',
    '  int sum = a + b;',
    '  return sum + a;',
    '}',
    '',
  ].join('\n');
  const fi2 = await indexFile('scope.c', scopeSrc, 'c');
  check('field x indexed as a definition', () =>
    assert.ok(fi2.symbols.some((s) => s.name === 'x' && s.kind === 'field' && s.isDefinition)));
  check('parameter a is scope-local to add', () =>
    assert.ok(fi2.locals.some((l) => l.name === 'a' && l.kind === 'parameter' && l.func === 'add')));
  check('local sum is scope-local to add', () =>
    assert.ok(fi2.locals.some((l) => l.name === 'sum' && l.kind === 'local_variable' && l.func === 'add')));
  check('locals do not leak into global symbols', () =>
    assert.ok(!fi2.symbols.some((s) => s.name === 'sum' || s.name === 'a' || s.name === 'b')));

  const sdb = openDb(':memory:');
  createWriter(sdb).apply(fi2, 1);
  check('store: field x resolves as a definition', () =>
    assert.ok(findDefinitions(sdb, 'x').some((h) => h.kind === 'field')));
  check('store: findLocal a within add', () =>
    assert.equal(findLocal(sdb, 'a', 'scope.c', 'add').length, 1));
  check('store: findLocal a absent in another scope', () =>
    assert.equal(findLocal(sdb, 'a', 'scope.c', 'other').length, 0));
  const aRef = fi2.refs.find((r) => r.name === 'a' && r.enclosingFunc === 'add');
  if (!aRef) {
    throw new Error('expected a ref to "a" inside add');
  }
  check('store: enclosingFuncAt resolves the cursor scope', () =>
    assert.equal(enclosingFuncAt(sdb, 'scope.c', 'a', aRef.line, aRef.col), 'add'));
  check('refs: local "a" is excluded from GLOBAL references', () =>
    assert.equal(findReferences(sdb, 'a').length, 0));
  check('refs: findLocalReferences "a" scoped to add', () =>
    assert.ok(findLocalReferences(sdb, 'a', 'scope.c', 'add').length >= 2));
  sdb.close();

  // 6c) type-tag definition narrowing.
  // A struct/union/enum/class tag used as a type — `struct inode *p;` — must
  // resolve to the AGGREGATE definition, not to every same-named field. When a
  // field named `inode` exists in many other structs, an unfiltered lookup floods
  // F12 with field declarations that have nothing to do with `struct inode`.
  const tagSrc = [
    'struct inode { int i_count; };',
    'struct file { struct inode *inode; };',
    'struct dentry { struct inode *inode; };',
    'void coda_file_mmap(void) {',
    '  struct inode *coda_inode;',
    '}',
    '',
  ].join('\n');
  const fiTag = await indexFile('file.c', tagSrc, 'c');
  const tdb = openDb(':memory:');
  createWriter(tdb).apply(fiTag, 1);
  // Baseline: the unfiltered lookup is noisy — the struct def AND both fields.
  check('tag: unfiltered "inode" returns the struct + field noise', () =>
    assert.ok(findDefinitions(tdb, 'inode').length >= 3, 'expected struct def plus field defs'));
  // The fix: restricting to the struct kind yields ONLY `struct inode`.
  check('tag: "inode" restricted to struct resolves to the aggregate only', () => {
    const hits = findDefinitions(tdb, 'inode', ['struct']);
    assert.equal(hits.length, 1, `expected 1 struct def, got ${hits.length}`);
    assert.equal(hits[0].kind, 'struct');
  });
  // The keyword preceding the cursor word drives the restriction.
  check('tag: tagKindBefore maps the struct keyword to kinds', () => {
    assert.deepEqual(tagKindBefore('\tstruct '), ['struct', 'class']);
    assert.deepEqual(tagKindBefore('  union '), ['union']);
    assert.deepEqual(tagKindBefore('enum '), ['enum']);
    assert.equal(tagKindBefore('  coda_inode = '), undefined);
    assert.equal(tagKindBefore('my_struct '), undefined); // not the keyword
  });
  tdb.close();

  // 6d) call-target field narrowing.
  // A bare `name(...)` call can only be a function / macro / function-pointer —
  // it can NEVER be a struct field (reaching a field requires `obj.`/`obj->`).
  // When `spin_lock` is BOTH a function and a struct member, F12 on the *call*
  // `spin_lock(l)` must list the function only, not the same-named field.
  const callSrc = [
    'struct rq { int spin_lock; };',   // a FIELD named spin_lock
    'void spin_lock(int *l) {}',       // a FUNCTION named spin_lock
    'void caller(int *l) {',
    '  spin_lock(l);',
    '}',
    '',
  ].join('\n');
  const fiCall = await indexFile('lock.c', callSrc, 'c');
  const cdb = openDb(':memory:');
  createWriter(cdb).apply(fiCall, 1);
  // Baseline: the unfiltered lookup is noisy — the function def AND the field def.
  check('call: unfiltered "spin_lock" returns the function + field noise', () => {
    const hits = findDefinitions(cdb, 'spin_lock');
    assert.ok(hits.some((h) => h.kind === 'function'), 'expected the function def');
    assert.ok(hits.some((h) => h.kind === 'field'), 'expected the field def (the noise)');
  });
  // The pure predicate: `(` after the word, and not a member access before it.
  check('call: isCallTarget detects a bare call vs member access vs non-call', () => {
    assert.equal(isCallTarget('  ', '(l);'), true);
    assert.equal(isCallTarget('  ', ' (l);'), true); // space before the paren is ok
    assert.equal(isCallTarget('rsp->', '(l);'), false); // member access keeps fields
    assert.equal(isCallTarget('obj.', '(l);'), false);
    assert.equal(isCallTarget('  return ', ' + 1;'), false); // not a call
  });
  // The fix: a bare call drops the same-named field, keeping the function.
  check('call: narrowCallTarget drops the field for a bare call', () => {
    const hits = narrowCallTarget(findDefinitions(cdb, 'spin_lock'), '  ', '(l);');
    assert.equal(hits.length, 1, `expected 1 hit, got ${hits.length}`);
    assert.equal(hits[0].kind, 'function');
  });
  // A function-pointer member call (`obj->spin_lock(...)`) keeps the field.
  check('call: narrowCallTarget keeps fields for a member-access call', () => {
    const hits = narrowCallTarget(findDefinitions(cdb, 'spin_lock'), 'rsp->', '(l);');
    assert.ok(hits.some((h) => h.kind === 'field'), 'field must remain for obj->field()');
  });
  cdb.close();

  // 6e) namespace-aware local binding
  // A struct tag (type_identifier) or struct field (field_identifier) MUST NOT
  // shadow a local variable that happens to have the same name.
  // E.g., `struct frame *frame = bh->b_frame;` - the struct tag "frame" and field "b_frame"
  // should not bind to a local variable named "frame" or "b_frame".
  const namespaceSrc = [
    'void test() {',
    '  struct frame *frame = bh->b_frame;',
    '  int b_frame = 1;',
    '}',
    '',
  ].join('\n');
  const fiNs = await indexFile('ns.c', namespaceSrc, 'c');
  check('namespace: struct tag is NOT marked as local variable', () => {
    // The first "frame" in "struct frame" is a type_identifier.
    // In our AST, it's a ref at line 1, col 9.
    const tagRef = fiNs.refs.find((r) => r.name === 'frame' && r.col === 9);
    assert.ok(tagRef, 'struct tag ref should exist');
    assert.equal(tagRef.isLocal, false, 'struct tag MUST NOT bind to local variable');
  });
  check('namespace: variable is marked as local variable', () => {
    // The second "frame" is an identifier at line 1, col 16.
    const varRef = fiNs.refs.find((r) => r.name === 'frame' && r.col === 16);
    assert.ok(varRef, 'variable ref should exist');
    assert.equal(varRef.isLocal, true, 'variable identifier MUST bind to local variable');
  });
  check('namespace: struct field is NOT marked as local variable', () => {
    // "b_frame" in "bh->b_frame" is a field_identifier at col 28.
    const fieldRef = fiNs.refs.find((r) => r.name === 'b_frame' && r.col === 28);
    assert.ok(fieldRef, 'field ref should exist');
    assert.equal(fieldRef.isLocal, false, 'struct field MUST NOT bind to local variable');
  });

  // The structural ROLE of each occurrence is recorded straight from the
  // tree-sitter node type — this is the principled discriminator (a value use
  // never resolves to a type tag / field, etc.). is_local is just the value-token
  // subset that also matches a local.
  check('role: struct tag is a `type` token', () => {
    const tagRef = fiNs.refs.find((r) => r.name === 'frame' && r.col === 9);
    assert.equal(tagRef?.role, 'type');
  });
  check('role: variable is a `value` token', () => {
    const varRef = fiNs.refs.find((r) => r.name === 'frame' && r.col === 16);
    assert.equal(varRef?.role, 'value');
  });
  check('role: struct field is a `field` token', () => {
    const fieldRef = fiNs.refs.find((r) => r.name === 'b_frame' && r.col === 28);
    assert.equal(fieldRef?.role, 'field');
  });
  check('role: only a `value` token can be is_local', () => {
    // the type tag (role=type) must never be flagged local even though a local
    // named frame exists in the function
    const tagRef = fiNs.refs.find((r) => r.name === 'frame' && r.col === 9);
    assert.ok(tagRef && tagRef.role === 'type' && tagRef.isLocal === false);
  });

  // refAt: read the is_local flag AND role of the ref AT a cursor position, so
  // scope-aware resolution distinguishes the type tag `struct frame` from the
  // same-named variable `*frame` on the same line (the front/back-cursor bug),
  // and routes by role at any scope.
  const nsdb = openDb(':memory:');
  createWriter(nsdb).apply(fiNs, 1);
  check('refAt: struct-tag position reports is_local=false + role=type', () => {
    const r = refAt(nsdb, 'ns.c', 'frame', 1, 9);
    assert.equal(r?.isLocal, false);
    assert.equal(r?.role, 'type');
  });
  check('refAt: variable position reports is_local=true + role=value', () => {
    const r = refAt(nsdb, 'ns.c', 'frame', 1, 16);
    assert.equal(r?.isLocal, true);
    assert.equal(r?.role, 'value');
  });
  check('refAt: same name, two positions on one line, opposite role', () => {
    const tag = refAt(nsdb, 'ns.c', 'frame', 1, 9);
    const variable = refAt(nsdb, 'ns.c', 'frame', 1, 16);
    assert.ok(tag && variable && tag.role !== variable.role);
  });
  check('refAt: returns undefined when no ref is recorded at the position', () =>
    assert.equal(refAt(nsdb, 'ns.c', 'frame', 99, 0), undefined));
  nsdb.close();

  // Role-aware references: the refs of a `type` token and a same-named `value`
  // token must NOT mix — mirror role-based Go-to-Definition for Find-All-References.
  // The refs.role column (schema 0.0.5) is the discriminator; grep rows (role='')
  // carry no AST role and are always kept (best-effort, never hidden). With no role
  // passed (cursor on a grep row) the old name-only behavior stands.
  {
    const rdb = openDb(':memory:');
    const RFILE = 'roleref.c';
    const fiRef: FileIndex = {
      file: RFILE, hash: 'h', parsedBy: 'ts',
      symbols: [
        { name: 'frame', kind: 'struct', file: RFILE, line: 0, col: 7, endLine: 0, endCol: 12, isDefinition: true, source: 'ts' },
        { name: 'frame', kind: 'global_variable', file: RFILE, line: 1, col: 14, endLine: 1, endCol: 19, isDefinition: true, source: 'ts' },
      ],
      refs: [
        // type occurrences
        { name: 'frame', file: RFILE, line: 1, col: 7, enclosingFunc: null, isLocal: false, role: 'type', source: 'ts' },
        { name: 'frame', file: RFILE, line: 3, col: 9, enclosingFunc: 'reader', isLocal: false, role: 'type', source: 'ts' },
        // value occurrences
        { name: 'frame', file: RFILE, line: 1, col: 14, enclosingFunc: null, isLocal: false, role: 'value', source: 'ts' },
        { name: 'frame', file: RFILE, line: 4, col: 20, enclosingFunc: 'writer', isLocal: false, role: 'value', source: 'ts' },
        // grep-fallback occurrence (no AST role) — must always be kept
        { name: 'frame', file: RFILE, line: 9, col: 0, enclosingFunc: null, isLocal: false, role: '', source: 'grep' },
      ],
      calls: [],
      locals: [],
      aliases: [],
    };
    createWriter(rdb).apply(fiRef, 1);

    check('refs(role): a `type` token returns only type refs (+ grep rows)', () => {
      const hits = findReferences(rdb, 'frame', 'type');
      assert.equal(hits.length, 3, 'two type refs + one grep row');
      assert.ok(!hits.some((h) => h.line === 1 && h.col === 14), 'the value occurrence is excluded');
      assert.ok(hits.some((h) => h.source === 'grep'), 'grep row (role="") is always kept');
    });
    check('refs(role): a `value` token returns only value refs (+ grep rows)', () => {
      const hits = findReferences(rdb, 'frame', 'value');
      assert.equal(hits.length, 3, 'two value refs + one grep row');
      assert.ok(!hits.some((h) => h.line === 1 && h.col === 7), 'the type occurrence is excluded');
      assert.ok(hits.some((h) => h.source === 'grep'));
    });
    check('refs(role): no role (grep cursor) keeps the name-only behavior', () =>
      assert.equal(findReferences(rdb, 'frame').length, 5, 'all occurrences, unfiltered'));
    rdb.close();
  }

  // Type-based member narrowing — extraction enrichment (schema 0.0.6):
  //   A) struct/union fields carry the OWNING aggregate tag (`scope`);
  //   B) locals/parameters carry their declared aggregate `dataType`;
  //   C) `typedef <named aggregate> Alias;` records an alias `name -> target`.
  // Together these let `obj->field` narrow to the field of obj's actual type.
  const memberSrc = [
    'struct mgr_state { int gen_state; };',
    'struct mgr_sync  { int gen_state; };',
    'typedef struct mgr_state_s { int x; } mgr_state_t;',
    'void f(struct mgr_state *rsp) {',
    '  struct mgr_sync *rsq;',
    '  mgr_state_t *rst;',
    '}',
    '',
  ].join('\n');
  const fiMem = await indexFile('mgr.c', memberSrc, 'c');
  // A) field owning-tag
  check('scope: field gen_state of mgr_state carries the owning tag', () =>
    assert.ok(fiMem.symbols.some((s) => s.name === 'gen_state' && s.kind === 'field' && s.scope === 'mgr_state')));
  check('scope: same-named field gen_state of mgr_sync is scoped separately', () =>
    assert.ok(fiMem.symbols.some((s) => s.name === 'gen_state' && s.kind === 'field' && s.scope === 'mgr_sync')));
  // B) local/parameter declared type
  check('dataType: parameter rsp is typed by struct mgr_state', () =>
    assert.equal(fiMem.locals.find((l) => l.name === 'rsp')?.dataType, 'mgr_state'));
  check('dataType: local rsq is typed by struct mgr_sync', () =>
    assert.equal(fiMem.locals.find((l) => l.name === 'rsq')?.dataType, 'mgr_sync'));
  check('dataType: local rst is typed by the typedef name mgr_state_t', () =>
    assert.equal(fiMem.locals.find((l) => l.name === 'rst')?.dataType, 'mgr_state_t'));
  // C) typedef alias
  check('alias: typedef mgr_state_t -> mgr_state_s recorded', () =>
    assert.equal(fiMem.aliases.find((a) => a.name === 'mgr_state_t')?.target, 'mgr_state_s'));

  // Store round-trip on the SAME real-parsed file: the writer persists and the
  // read queries return the owning tag / declared type / alias target — the data
  // the resolver narrows `obj->field` with.
  {
    const mdb = openDb(':memory:');
    createWriter(mdb).apply(fiMem, 1);
    check('store: findDefinitions("gen_state") returns both fields with distinct scopes', () => {
      const scopes = findDefinitions(mdb, 'gen_state', ['field']).map((h) => h.scope).sort();
      assert.deepEqual(scopes, ['mgr_state', 'mgr_sync']);
    });
    check('store: findLocal("rsp") round-trips its dataType', () =>
      assert.equal(findLocal(mdb, 'rsp', 'mgr.c', 'f')[0]?.dataType, 'mgr_state'));
    check('store: findTypedefTarget resolves the alias', () =>
      assert.equal(findTypedefTarget(mdb, 'mgr_state_t'), 'mgr_state_s'));
    check('store: findTypedefTarget is undefined for a non-alias', () =>
      assert.equal(findTypedefTarget(mdb, 'nope'), undefined));
    mdb.close();
  }

  // refRole unit: node type -> role, role -> admissible kinds, and the narrowing.
  check('refRole: roleForNodeType maps node types', () => {
    assert.equal(roleForNodeType('identifier'), 'value');
    assert.equal(roleForNodeType('type_identifier'), 'type');
    assert.equal(roleForNodeType('field_identifier'), 'field');
    assert.equal(roleForNodeType('statement_identifier'), 'label');
    assert.equal(roleForNodeType('namespace_identifier'), 'namespace');
  });
  check('refRole: isRefRole rejects the grep empty sentinel', () => {
    assert.equal(isRefRole('value'), true);
    assert.equal(isRefRole(''), false);
    assert.equal(isRefRole(undefined), false);
  });
  check('refRole: a value token admits global_variable but NOT struct/field', () => {
    const kinds = kindsForRole('value');
    assert.ok(kinds.includes('global_variable') && kinds.includes('function'));
    assert.ok(!kinds.includes('struct') && !kinds.includes('field'));
  });
  check('refRole: a type token admits struct/typedef but NOT global_variable', () => {
    const kinds = kindsForRole('type');
    assert.ok(kinds.includes('struct') && kinds.includes('typedef'));
    assert.ok(!kinds.includes('global_variable'));
  });
  check('refRole: macro is admissible under every role (never hidden)', () => {
    for (const role of ['value', 'type', 'field', 'namespace'] as const) {
      assert.ok(kindsForRole(role).includes('macro'), `macro missing from ${role}`);
    }
  });
  check('refRole: narrowByRole drops cross-namespace hits, keeps macro', () => {
    const hits = [
      { kind: 'struct' as const },
      { kind: 'global_variable' as const },
      { kind: 'macro' as const },
    ];
    const valueKept = narrowByRole(hits, 'value').map((h) => h.kind).sort();
    assert.deepEqual(valueKept, ['global_variable', 'macro']);
    const typeKept = narrowByRole(hits, 'type').map((h) => h.kind).sort();
    assert.deepEqual(typeKept, ['macro', 'struct']);
    // unknown role → unchanged
    assert.equal(narrowByRole(hits, '').length, 3);
  });

  // 7) worker -> SQLite integration (uses the built dist/worker.js)
  const tmpDb = path.join(os.tmpdir(), `sintra-test-${process.pid}-${Date.now()}.db`);
  const pool1 = new WorkerPool(
    path.join(root, 'dist', 'worker.js'),
    tmpDb,
    {
      runtimeWasmPath: path.join(root, 'dist', 'tree-sitter.wasm'),
      grammarPaths: {
        c: path.join(root, 'dist', 'grammars', 'tree-sitter-c.wasm'),
        cpp: path.join(root, 'dist', 'grammars', 'tree-sitter-cpp.wasm'),
      },
    },
    undefined,
    1
  );
  await pool1.indexAll([path.join(fixtures, 'sample.c')]);
  await pool1.dispose();
  const rdb = openDb(tmpDb, { readonly: true });
  check('worker: indexed sample.c (main definition present)', () =>
    assert.ok(findDefinitions(rdb, 'main').some((s) => s.kind === 'function')));
  check('worker: indexed sample.c (main calls helper)', () =>
    assert.ok(findCallees(rdb, 'main').some((c) => c.callee === 'helper')));
  rdb.close();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(tmpDb + ext, { force: true });
  }

  // 8) worker pool: parallel parse + concurrent writers into one DB
  const poolDb = path.join(os.tmpdir(), `sintra-pool-${process.pid}-${Date.now()}.db`);
  const assets = {
    runtimeWasmPath: path.join(root, 'dist', 'tree-sitter.wasm'),
    grammarPaths: {
      c: path.join(root, 'dist', 'grammars', 'tree-sitter-c.wasm'),
      cpp: path.join(root, 'dist', 'grammars', 'tree-sitter-cpp.wasm'),
    },
  };
  const pool = new WorkerPool(path.join(root, 'dist', 'worker.js'), poolDb, assets, undefined, 4);
  let lastProgress = { done: 0, total: 0 };
  pool.onProgress = (p) => {
    lastProgress = p;
  };
  const poolFiles = [path.join(fixtures, 'sample.c'), path.join(fixtures, 'broken.c')];
  await pool.indexAll(poolFiles);
  await pool.dispose();
  check('pool: progress total equals file count', () =>
    assert.equal(lastProgress.total, poolFiles.length));
  check('pool: progress reaches done == total', () =>
    assert.equal(lastProgress.done, lastProgress.total));
  const pdb = openDb(poolDb, { readonly: true });
  check('pool: indexed sample.c (main definition present)', () =>
    assert.ok(findDefinitions(pdb, 'main').some((s) => s.kind === 'function')));
  check('pool: both files recorded', () =>
    assert.equal(getFileMeta(pdb).size, poolFiles.length));
  pdb.close();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(poolDb + ext, { force: true });
  }

  // 8b) incremental bulk (rebuildIndexes: false): the include/exclude fast path.
  //     A small change must reuse the existing index — keep the name indexes LIVE
  //     (so inserts maintain them) instead of dropping + rebuilding the whole
  //     table — and still index the new file AND resolve its members' parent_id.
  const incDb = path.join(os.tmpdir(), `sintra-inc-${process.pid}-${Date.now()}.db`);
  const fileA = path.join(os.tmpdir(), `sintra-incA-${process.pid}-${Date.now()}.c`);
  const fileB = path.join(os.tmpdir(), `sintra-incB-${process.pid}-${Date.now()}.c`);
  fs.writeFileSync(fileA, 'struct point { int x; int y; };\n');
  fs.writeFileSync(fileB, 'struct line { int head; int tail; };\n');
  const incPool = new WorkerPool(path.join(root, 'dist', 'worker.js'), incDb, assets, undefined, 2);
  await incPool.indexAll([fileA]); // full (rebuild) build of the base index
  await incPool.indexAll([fileB], { rebuildIndexes: false }); // live-index add
  await incPool.dispose();
  const incReadDb = openDb(incDb, { readonly: true });
  check('incremental(rebuildIndexes:false): prior file A kept', () =>
    assert.ok(findDefinitions(incReadDb, 'point', ['struct']).length > 0));
  check('incremental(rebuildIndexes:false): new file B indexed', () =>
    assert.ok(findDefinitions(incReadDb, 'line', ['struct']).length > 0));
  check('incremental(rebuildIndexes:false): new file B field parent_id resolved', () => {
    const lineId = findDefinitions(incReadDb, 'line', ['struct'])[0]?.id;
    const head = findDefinitions(incReadDb, 'head', ['field']).find((h) => h.scope === 'line');
    assert.ok(head && head.parentId === lineId, 'field head should link to struct line');
  });
  check('incremental(rebuildIndexes:false): prior file A field parent_id intact', () => {
    const x = findDefinitions(incReadDb, 'x', ['field']).find((h) => h.scope === 'point');
    assert.ok(x && x.parentId != null, 'field x should still link to struct point');
  });
  incReadDb.close();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(incDb + ext, { force: true });
  }
  fs.rmSync(fileA, { force: true });
  fs.rmSync(fileB, { force: true });

  // 9) schema versioning: a mismatched user_version wipes and rebuilds the DB
  check('schema: version encodes the extension semver', () =>
    assert.equal(schemaVersionFor('0.0.1'), 1));
  check('schema: version encodes major/minor/patch', () =>
    assert.equal(schemaVersionFor('1.2.3'), 1_002_003));
  const V = schemaVersionFor('0.0.1');
  const verDb = path.join(os.tmpdir(), `sintra-ver-${process.pid}-${Date.now()}.db`);
  const fresh = ensureSchema(verDb, V);
  check('schema: fresh DB not flagged recreated', () => assert.equal(fresh.recreated, false));
  const vdb = openDb(verDb);
  createWriter(vdb).apply(idx, 1000);
  check('schema: data present before version change', () =>
    assert.ok(countSymbolsForFile(vdb, 'sample.c') > 0));
  vdb.exec('PRAGMA user_version = 999'); // simulate a different extension version
  vdb.close();
  const rebuilt = ensureSchema(verDb, V);
  check('schema: version mismatch recreates', () => assert.equal(rebuilt.recreated, true));
  const vrdb = openDb(verDb, { readonly: true });
  check('schema: rebuilt DB is empty', () =>
    assert.equal(countSymbolsForFile(vrdb, 'sample.c'), 0));
  vrdb.close();
  check('schema: matching version keeps DB', () =>
    assert.equal(ensureSchema(verDb, V).recreated, false));
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(verDb + ext, { force: true });
  }

  // 10) attribute-macro misparse recovery: tree-sitter can't preprocess, so
  //     macros like __init / __exit / __cold that expand to GCC __attribute__
  //     cause function_definition nodes to lose their declarator. The extractor
  //     must still identify the function name and track the enclosing scope for
  //     calls inside these functions.
  const attrCases: { label: string; src: string; funcName: string; callee: string }[] = [
    {
      label: '__init between type and name',
      src: 'void __init vfs_caches_init_early(void) { inode_init_early(); }',
      funcName: 'vfs_caches_init_early',
      callee: 'inode_init_early',
    },
    {
      label: '__exit between type and name',
      src: 'void __exit cleanup_module(void) { remove_proc_entry(); }',
      funcName: 'cleanup_module',
      callee: 'remove_proc_entry',
    },
    {
      label: '__cold between type and name',
      src: 'int __cold notifier_call_chain(void) { nr_to_call(); }',
      funcName: 'notifier_call_chain',
      callee: 'nr_to_call',
    },
    {
      label: '__weak between type and name',
      src: 'void __weak arch_cpu_idle(void) { local_irq_enable(); }',
      funcName: 'arch_cpu_idle',
      callee: 'local_irq_enable',
    },
    {
      label: 'static + __init',
      src: 'static void __init start_kernel(void) { setup_arch(); }',
      funcName: 'start_kernel',
      callee: 'setup_arch',
    },
    {
      label: 'pointer return + __init',
      src: 'struct worker_ctl *__init idle_thread_create(void) { fork_idle(); }',
      funcName: 'idle_thread_create',
      callee: 'fork_idle',
    },
    {
      label: 'asmlinkage before type',
      src: 'asmlinkage void do_IRQ(void) { handle_irq(); }',
      funcName: 'do_IRQ',
      callee: 'handle_irq',
    },
    {
      label: 'multiple macros (asmlinkage __visible void __init)',
      src: 'asmlinkage __visible void __init start_kernel(void) { setup_arch(); }',
      funcName: 'start_kernel',
      callee: 'setup_arch',
    },
    {
      label: '__noinline __cold',
      src: 'void __noinline __cold handle_error(void) { dump_stack(); }',
      funcName: 'handle_error',
      callee: 'dump_stack',
    },
    {
      label: 'native __attribute__ (control — already works)',
      src: 'void __attribute__((cold)) my_func(void) { helper(); }',
      funcName: 'my_func',
      callee: 'helper',
    },
    {
      label: 'normal function (control — already works)',
      src: 'int normal_function(int a) { helper(); return a; }',
      funcName: 'normal_function',
      callee: 'helper',
    },
  ];
  for (const { label, src, funcName, callee } of attrCases) {
    const fi = await indexFile('attr.c', src, 'c');
    check(`attr-macro: ${label} — function '${funcName}' recognized`, () =>
      assert.ok(
        fi.symbols.some((s) => s.name === funcName && s.kind === 'function'),
        `expected function symbol '${funcName}'`,
      ));
    check(`attr-macro: ${label} — call from '${funcName}' to '${callee}'`, () =>
      assert.ok(
        fi.calls.some((c) => c.caller === funcName && c.callee === callee),
        `expected call edge ${funcName} -> ${callee}, got callers: [${fi.calls.map((c) => c.caller).join(', ')}]`,
      ));
  }

  // 11) recursive call-graph traversal (Relations "Calls" / "Called by").
  //     a -> b -> {c, a}, and c -> c. The tree expands lazily; a node is a
  //     terminal when its name reappears among its ancestors (a cycle).
  const recurSrc = [
    'void a(void) { b(); }',
    'void b(void) { c(); a(); }',
    'void c(void) { c(); }',
    '',
  ].join('\n');
  const fiRec = await indexFile('recur.c', recurSrc, 'c');
  const rcdb = openDb(':memory:');
  createWriter(rcdb).apply(fiRec, 1);

  const aCallees = callChildren(rcdb, 'callees', 'a', []);
  check('callgraph: a calls b (direct callee)', () =>
    assert.deepEqual(aCallees.map((n) => n.name), ['b']));

  const bCallees = callChildren(rcdb, 'callees', 'b', ['a']);
  check('callgraph: under a→b, callee a is flagged as a cycle back to the root', () => {
    const a = bCallees.find((n) => n.name === 'a');
    const c = bCallees.find((n) => n.name === 'c');
    assert.ok(a?.recursive, 'a should be a recursive (cycle) terminal');
    assert.equal(c?.recursive, false, 'c is not yet in the ancestor chain');
  });

  const cSelf = callChildren(rcdb, 'callees', 'c', []);
  check('callgraph: direct self-recursion c→c is a cycle terminal', () =>
    assert.ok(cSelf.find((n) => n.name === 'c')?.recursive));

  const aCallers = callChildren(rcdb, 'callers', 'a', ['c', 'b']);
  check('callgraph: caller chain detects the cycle back to an ancestor', () =>
    assert.ok(aCallers.find((n) => n.name === 'b')?.recursive));

  check('callgraph: hasCallChildren distinguishes leaf vs branch', () => {
    assert.ok(hasCallChildren(rcdb, 'callees', 'a'));
    assert.ok(hasCallChildren(rcdb, 'callees', 'c')); // c calls itself
  });
  rcdb.close();

  // 12) IndexGate: the deferral barrier that lets navigation queries wait out an
  //     in-flight reindex. Idle resolves immediately; busy blocks until end() or a
  //     timeout; timeout<=0 never blocks.
  const gate = new IndexGate();
  check('gate: idle initially', () => assert.equal(gate.busy, false));
  gate.begin();
  check('gate: busy after begin()', () => assert.equal(gate.busy, true));
  let idleResolved = false;
  const idleWait = gate.whenIdle(1000).then(() => {
    idleResolved = true;
  });
  await delay(20);
  check('gate: whenIdle pending while busy', () => assert.equal(idleResolved, false));
  gate.end();
  await idleWait;
  check('gate: whenIdle resolves after end()', () => assert.equal(idleResolved, true));
  check('gate: idle again after end()', () => assert.equal(gate.busy, false));
  // Timeout path: still busy, but whenIdle gives up after the timeout.
  gate.begin();
  const t0 = Date.now();
  await gate.whenIdle(30);
  check('gate: whenIdle times out while still busy', () =>
    assert.ok(Date.now() - t0 >= 25 && gate.busy));
  // timeoutMs <= 0 disables deferral even when busy.
  let zeroResolved = false;
  await Promise.race([
    gate.whenIdle(0).then(() => {
      zeroResolved = true;
    }),
    delay(50),
  ]);
  check('gate: whenIdle(0) resolves immediately even when busy', () =>
    assert.equal(zeroResolved, true));
  gate.end();
  // onChange fires on the 0->1 and 1->0 transitions only.
  const transitions: boolean[] = [];
  const g2 = new IndexGate();
  g2.onChange = (busy) => transitions.push(busy);
  g2.begin();
  g2.begin();
  g2.end();
  g2.end();
  check('gate: onChange fires once true then once false', () =>
    assert.deepEqual(transitions, [true, false]));
  // track() wraps begin/end around a promise.
  let trackedBusy = false;
  const g3 = new IndexGate();
  const tracked = g3.track(delay(10).then(() => (trackedBusy = g3.busy)));
  check('gate: track() marks busy synchronously', () => assert.equal(g3.busy, true));
  await tracked;
  check('gate: track() was busy during the op and idle after', () =>
    assert.ok(trackedBusy && !g3.busy));

  // 13) refGroups: group references by file (Find-All-References style) and render
  //     a code-line snippet per occurrence.
  const mkRef = (file: string, line: number, col: number): RefHit => ({
    name: 'foo',
    file,
    line,
    col,
    enclosingFunc: null,
    owner: '',
    objChain: '',
    source: 'ts',
  });
  const groups = groupReferencesByFile([
    mkRef('b.c', 5, 2),
    mkRef('a.c', 10, 0),
    mkRef('a.c', 3, 4),
    mkRef('a.c', 3, 1),
  ]);
  check('refGroups: groups sorted by file path', () =>
    assert.deepEqual(groups.map((g) => g.file), ['a.c', 'b.c']));
  check('refGroups: refs within a file sorted by (line, col)', () =>
    assert.deepEqual(
      groups[0].refs.map((r) => [r.line, r.col]),
      [[3, 1], [3, 4], [10, 0]],
    ));
  check('refGroups: each source file is one group', () =>
    assert.equal(groups.find((g) => g.file === 'a.c')?.refs.length, 3));
  const lines = ['int main(void) {', '  foo(bar);  ', '}'];
  check('refGroups: snippetLabel trims the source line', () =>
    assert.equal(snippetLabel(lines, { line: 1, col: 2 }), 'foo(bar);'));
  check('refGroups: snippetLabel falls back when out of range', () =>
    assert.equal(snippetLabel(lines, { line: 9, col: 0 }), 'line 10'));

  // 14) computeIndexPlan: the pure incremental decision extracted from
  //     extension.ts. A new/changed file is queued to index; an unchanged file
  //     (same mtime, or same content hash) is skipped; a file that left the
  //     current set (excluded or deleted) is queued to remove. This is what
  //     makes an include/exclude change incremental rather than a full rebuild.
  {
    const prev = new Map<string, { mtime: number; hash: string }>([
      ['a.c', { mtime: 100, hash: 'ha' }],
      ['b.c', { mtime: 100, hash: 'hb' }],
      ['gone.c', { mtime: 100, hash: 'hg' }],
    ]);
    const mtimes: Record<string, number> = { 'a.c': 100, 'b.c': 200, 'new.c': 50, 'gone.c': 100 };
    const mtimeOf = (f: string): number => mtimes[f] ?? -1;

    const plan = computeIndexPlan(['a.c', 'b.c', 'new.c'], prev, mtimeOf);
    check('plan: new + mtime-changed files are queued to index', () =>
      assert.deepEqual(plan.toIndex.slice().sort(), ['b.c', 'new.c']));
    check('plan: an unchanged file (same mtime) is skipped', () =>
      assert.ok(!plan.toIndex.includes('a.c') && plan.unchanged === 1));
    check('plan: a file no longer in the set is queued to remove', () =>
      assert.deepEqual(plan.toRemove, ['gone.c']));

    // Removing an exclude pattern re-admits its files: a newly-present file is
    // absent from prev → indexed; nothing is wrongly removed.
    const reAdmit = computeIndexPlan(['a.c', 'b.c', 'gone.c', 'new.c'], prev, mtimeOf);
    check('plan: removing an exclude re-admits the file (it gets indexed, none removed)', () =>
      assert.ok(reAdmit.toIndex.includes('new.c') && reAdmit.toRemove.length === 0));

    // forceAll re-indexes everything present AND still drops vanished files.
    const full = computeIndexPlan(['a.c', 'b.c'], prev, mtimeOf, { forceAll: true });
    check('plan: forceAll re-indexes all current files and removes the vanished one', () => {
      assert.deepEqual(full.toIndex.slice().sort(), ['a.c', 'b.c']);
      assert.deepEqual(full.toRemove, ['gone.c']);
    });

    // hashOf: a touched-but-identical file (mtime moved, content unchanged) is
    // skipped instead of being needlessly re-parsed.
    const hashes: Record<string, string> = { 'b.c': 'hb' }; // b.c content unchanged
    const hashed = computeIndexPlan(['a.c', 'b.c'], prev, mtimeOf, { hashOf: (f) => hashes[f] ?? null });
    check('plan: hashOf skips a touched-but-identical file (mtime moved, same hash)', () =>
      assert.ok(!hashed.toIndex.includes('b.c') && hashed.unchanged === 2));
  }

  console.log(`\n${passed} checks passed.`);
  } finally {
    disposeParsers();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
