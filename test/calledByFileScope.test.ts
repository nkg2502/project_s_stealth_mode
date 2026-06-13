/**
 * Regression: a call inside a function must never be attributed to "(file scope)".
 *
 * A call's caller is the enclosing function at the call site. On the tree-sitter
 * path, `extract.ts` pushes onto its function stack only inside a
 * `function_definition` node. On very large, macro-heavy bodies (e.g. a computed-
 * goto bytecode interpreter with hundreds of macro-generated labels) tree-sitter
 * can close that node early and re-sync the body's tail as top-level statements,
 * so a call in the body re-syncs at file scope and gets a null caller — the
 * "(file scope)" symptom. The lexical recovery post-pass
 * (`indexer/enclosingFunc.ts`, applied in `extract.ts`) brace-matches the body in
 * the raw text and re-attributes such file-scope calls to their function.
 *
 * That early-close only manifests on a huge real body and cannot be reproduced in
 * a small snippet (this grammar parses GNU extensions — computed gotos, range
 * designators, statement-expressions — cleanly). So this self-contained test uses
 * an interpreter-style body to guard the OBSERVABLE invariant: the call is
 * attributed to its enclosing function (never null), on the tree-sitter path. The
 * brace-matching recovery itself is unit-tested directly and deterministically in
 * `enclosingFunc.test.ts` (`buildFuncRanges` / `enclosingFuncAt`).
 *
 * Run: npx tsc -p tsconfig.test.json && node --test out/test/calledByFileScope.test.js
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { setupLiveParser } from './liveTestSetup';
import { indexFile } from '../src/indexer/indexFile';
import { getParser } from '../src/indexer/parser';
import { extractFromTree } from '../src/indexer/extract';
import type { FileIndex } from '../src/core/types';

// An interpreter-style function (computed-goto dispatch + a statement-expression).
const CODE = [
  'static unsigned short pack16(unsigned short v) { return v; }',
  'unsigned long interp_exec(unsigned char *pc, unsigned long *regs)',
  '{',
  '\tstatic void * const jt[256] = { [0 ... 255] = &&L_def, [7] = &&L_st, };',
  '\tgoto *jt[*pc];',
  'L_st:',
  '\tregs[0] = ({ unsigned short t = pack16(regs[1]); (unsigned long)t; });',
  '\tgoto *jt[*++pc];',
  'L_def:',
  '\treturn regs[0];',
  '}',
  '',
].join('\n');

const FILE = '/interp.c';

describe('Called by: a call in an interpreter body resolves to its function (not file scope)', () => {
  let idx: FileIndex;
  let errorRatio = NaN;
  let callInsideFuncNode = true;

  before(async () => {
    await setupLiveParser();
    idx = await indexFile(FILE, CODE, 'c');

    // Independently recover the ERROR-byte ratio the fallback decision uses, and
    // whether the call still sits inside the function_definition AST node (when it
    // does not, the lexical recovery post-pass is what attributes the call).
    const parser = await getParser('c');
    const tree = parser.parse(CODE);
    if (tree) {
      try {
        errorRatio = extractFromTree(tree, FILE, 'c').errorRatio;
        const callRow = CODE.split('\n').findIndex((l) => l.includes('pack16(regs'));
        const fdefs: any[] = [];
        const walk = (n: any) => {
          if (!n) return;
          if (n.type === 'function_definition') fdefs.push(n);
          for (let i = 0; i < n.childCount; i++) walk(n.child(i));
        };
        walk(tree.rootNode);
        callInsideFuncNode = fdefs.some(
          (n) => n.startPosition.row <= callRow && n.endPosition.row >= callRow,
        );
      } finally {
        tree.delete();
      }
    }
  });

  it('reports the diagnostic facts', () => {
    const fn = idx.symbols.find((s) => s.name === 'interp_exec' && s.kind === 'function');
    const calls = idx.calls.filter((c) => c.callee === 'pack16');

    console.error('--- diagnosis ---');
    console.error('parsedBy   :', idx.parsedBy);
    console.error('errorRatio :', errorRatio.toFixed(4), '(grep fallback when > 0.25)');
    console.error('interp_exec indexed as function?', !!fn);
    console.error('call inside the function_definition node?', callInsideFuncNode,
      '(false => the lexical recovery is what attributes it)');
    console.error('-----------------');

    assert.equal(idx.parsedBy, 'ts', 'must stay on the tree-sitter path (not the grep fallback)');
    assert.ok(fn, 'interp_exec must be indexed as a function');
    assert.ok(calls.length > 0, 'pack16 call edge must exist');
  });

  it('attributes the pack16 call to interp_exec, not "(file scope)"', () => {
    const call = idx.calls.find((c) => c.callee === 'pack16');
    assert.ok(call, 'pack16 call edge must exist');
    assert.equal(
      call!.caller,
      'interp_exec',
      `expected caller "interp_exec" but got ${JSON.stringify(call!.caller)} (this is the "(file scope)" symptom)`,
    );
  });
});
