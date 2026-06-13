/**
 * Unit tests for the lexical enclosing-function recovery (`indexer/enclosingFunc.ts`).
 * Pure text/brace logic — no parser, no store. See calledByFileScope.test.ts for
 * the end-to-end reproduction against a real computed-goto interpreter.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFuncRanges, enclosingFuncAt } from '../src/indexer/enclosingFunc';

describe('buildFuncRanges / enclosingFuncAt', () => {
  it('brace-matches a simple body (kernel-style brace on its own line)', () => {
    const text = ['static int foo(int x)', '{', '\treturn x;', '}', ''].join('\n');
    const ranges = buildFuncRanges(text, [{ name: 'foo', line: 0, col: 11 }]);
    assert.deepEqual(ranges, [{ name: 'foo', startLine: 0, endLine: 3 }]);
    assert.equal(enclosingFuncAt(ranges, 2), 'foo'); // the `return` line
    assert.equal(enclosingFuncAt(ranges, 4), null); // past the body
  });

  it('spans nested braces, including a struct initializer in the body', () => {
    const text = [
      'int run(void)',         // 0
      '{',                     // 1
      '\tstatic const x[] = {', // 2  (inner brace)
      '\t\t1, 2, 3,',           // 3
      '\t};',                  // 4  (inner close)
      '\thelper();',            // 5  <- the real bug zone
      '}',                     // 6
      '',
    ].join('\n');
    const ranges = buildFuncRanges(text, [{ name: 'run', line: 0, col: 4 }]);
    assert.deepEqual(ranges, [{ name: 'run', startLine: 0, endLine: 6 }]);
    assert.equal(enclosingFuncAt(ranges, 5), 'run', 'a call after an inner initializer is still inside run');
  });

  it('ignores braces inside comments and string/char literals', () => {
    const text = [
      'void f(void)',              // 0
      '{',                         // 1
      '\t/* a stray } in a comment */', // 2
      '\tputs("} not a brace {");',     // 3
      "\tchar c = '}';",                // 4
      '\tg();',                          // 5
      '}',                               // 6
      '',
    ].join('\n');
    const ranges = buildFuncRanges(text, [{ name: 'f', line: 0, col: 5 }]);
    assert.deepEqual(ranges, [{ name: 'f', startLine: 0, endLine: 6 }],
      'a comment/string brace must not prematurely close the body');
  });

  it('handles a multi-line parameter list before the body brace', () => {
    const text = [
      'int many(int a,', // 0
      '         int b,', // 1
      '         int c)', // 2
      '{',               // 3
      '\treturn a;',     // 4
      '}',               // 5
      '',
    ].join('\n');
    const ranges = buildFuncRanges(text, [{ name: 'many', line: 0, col: 4 }]);
    assert.deepEqual(ranges, [{ name: 'many', startLine: 0, endLine: 5 }]);
  });

  it('skips a prototype (semicolon before any body brace)', () => {
    const text = 'int proto(int a, int b);\n';
    assert.deepEqual(buildFuncRanges(text, [{ name: 'proto', line: 0, col: 4 }]), []);
  });

  it('skips an unbalanced body rather than fabricating a range to EOF', () => {
    const text = 'void bad(void)\n{\n\tx();\n'; // no closing brace
    assert.deepEqual(buildFuncRanges(text, [{ name: 'bad', line: 0, col: 5 }]), []);
  });

  it('does not place a between-functions (file-scope) line in any range', () => {
    const text = [
      'int a(void)', '{', '\treturn 1;', '}',  // 0..3
      'int g = init();',                         // 4  <- genuine file scope
      'int b(void)', '{', '\treturn 2;', '}',  // 5..8
      '',
    ].join('\n');
    const ranges = buildFuncRanges(text, [
      { name: 'a', line: 0, col: 4 },
      { name: 'b', line: 5, col: 4 },
    ]);
    assert.equal(enclosingFuncAt(ranges, 4), null, 'a file-scope initializer call belongs to no function');
    assert.equal(enclosingFuncAt(ranges, 2), 'a');
    assert.equal(enclosingFuncAt(ranges, 7), 'b');
  });

  it('returns [] for no anchors', () => {
    assert.deepEqual(buildFuncRanges('int x;\n', []), []);
  });
});
