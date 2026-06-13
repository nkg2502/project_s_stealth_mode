/**
 * Tests for the Symbol Fuzzy Find query syntax:
 *   - kind prefixes (f:, s:, l:, ...)
 *   - text-match modes ('exact, ^prefix)
 *   - literalFilter behavior
 * 
 * The provider module imports 'vscode', so we patch module._load to return a
 * stub before requiring it (same pattern as edgeCases.test.ts).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { SymbolKind } from '../src/core/types';
import { literalFilter, parseQuery } from '../src/features/fuzzyQuery';

// Live F10 query parsing/filtering (features/fuzzyQuery). It has no vscode
// dependency, so it is imported directly; `loadProvider` is kept as a thin shim
// so the original test bodies read unchanged.
function loadProvider(): { parseQuery: typeof parseQuery; literalFilter: typeof literalFilter } {
    return { parseQuery, literalFilter };
}

interface NameLike { name: string; kind: SymbolKind; }
function sym(name: string, kind: SymbolKind = 'function'): NameLike {
    return { name, kind };
}

describe('FuzzyFind query: parseQuery kind prefixes', () => {
    const { parseQuery } = loadProvider();

    it('f: maps to function and prototype', () => {
        const q = parseQuery('f:SVC');
        assert.deepEqual(q.kinds, ['function', 'prototype']);
        assert.equal(q.term, 'SVC');
        assert.equal(q.mode, 'fuzzy');
    });

    it('t: maps to the unified type group (struct/union/enum/enumerator/class/typedef)', () => {
        const q = parseQuery('t:Spec');
        assert.deepEqual(q.kinds, ['struct', 'union', 'enum', 'enumerator', 'class', 'typedef']);
        assert.equal(q.term, 'Spec');
    });

    it('v: maps to global_variable only (fields are m:)', () => {
        const q = parseQuery('v:foo');
        assert.deepEqual(q.kinds, ['global_variable']);
        assert.equal(q.term, 'foo');
    });

    it('m: maps to struct field and C++ method', () => {
        const q = parseQuery('m:head');
        assert.deepEqual(q.kinds, ['field', 'method']);
        assert.equal(q.term, 'head');
    });

    it('n: maps to namespace', () => {
        const q = parseQuery('n:detail');
        assert.deepEqual(q.kinds, ['namespace']);
        assert.equal(q.term, 'detail');
    });

    it('c:, e:, s:, u: are no longer kind prefixes', () => {
        for (const p of ['c', 'e', 's', 'u']) {
            assert.equal(parseQuery(`${p}:Spec`).kinds, undefined);
            assert.equal(parseQuery(`${p}:Spec`).term, `${p}:Spec`);
        }
    });

    it('g: (enumerator) is no longer a kind prefix', () => {
        const q = parseQuery('g:foo');
        assert.equal(q.kinds, undefined);
        assert.equal(q.term, 'g:foo');
    });

    it('space after the prefix is ignored ("l: again" == "l:again")', () => {
        const a = parseQuery('l:again');
        const b = parseQuery('l: again');
        assert.deepEqual(b.kinds, ['label']);
        assert.equal(b.term, 'again');
        assert.equal(b.mode, a.mode);
    });

    it('space before exact-mode quote is ignored ("l: \'again")', () => {
        const q = parseQuery("l: 'again");
        assert.deepEqual(q.kinds, ['label']);
        assert.equal(q.mode, 'exact');
        assert.equal(q.term, 'again');
    });

    it('l: maps to label', () => {
        const q = parseQuery('l:err');
        assert.deepEqual(q.kinds, ['label']);
        assert.equal(q.term, 'err');
    });

    it('d: maps to macro', () => {
        const q = parseQuery('d:COR');
        assert.deepEqual(q.kinds, ['macro']);
    });

    it('unknown prefix is treated as plain text', () => {
        const q = parseQuery('z:foo');
        assert.equal(q.kinds, undefined);
        assert.equal(q.term, 'z:foo');
    });

    it('no prefix yields no kind filter', () => {
        const q = parseQuery('SVC_Init');
        assert.equal(q.kinds, undefined);
        assert.equal(q.term, 'SVC_Init');
    });

    it('C++ scope qualifier (single letter + ::) is not a kind prefix', () => {
        const q = parseQuery('s::iterator');
        assert.equal(q.kinds, undefined);
        assert.equal(q.term, 's::iterator');
    });

    it('double-colon after known prefix letter is treated as text', () => {
        const q = parseQuery('f::bar');
        assert.equal(q.kinds, undefined);
        assert.equal(q.term, 'f::bar');
    });
});

describe('FuzzyFind query: parseQuery text modes', () => {
    const { parseQuery } = loadProvider();

    it('\' enables exact mode', () => {
        const q = parseQuery("'SVC_Init");
        assert.equal(q.mode, 'exact');
        assert.equal(q.term, 'SVC_Init');
    });

    it('^ enables prefix mode', () => {
        const q = parseQuery("^SVC");
        assert.equal(q.mode, 'prefix');
        assert.equal(q.term, 'SVC');
    });

    it('kind prefix combines with exact mode', () => {
        const q = parseQuery("f:'SVC_Init");
        assert.deepEqual(q.kinds, ['function', 'prototype']);
        assert.equal(q.mode, 'exact');
        assert.equal(q.term, 'SVC_Init');
    });

    it('kind prefix combines with prefix mode', () => {
        const q = parseQuery("l:^err");
        assert.deepEqual(q.kinds, ['label']);
        assert.equal(q.mode, 'prefix');
        assert.equal(q.term, 'err');
    });
});

describe('FuzzyFind query: literalFilter', () => {
    const { literalFilter } = loadProvider();

    const symbols: NameLike[] = [
        sym('SVC_Init', 'function'),
        sym('SVC_InitScaleRatios', 'function'),
        sym('SVC_init', 'global_variable'),
        sym('error_exit', 'label'),
        sym('retry', 'label'),
    ];

    it('exact mode is case-insensitive and matches whole name', () => {
        const r = literalFilter(symbols, 'svc_init', 'exact');
        const names = r.map(s => s.name).sort();
        assert.deepEqual(names, ['SVC_Init', 'SVC_init']);
    });

    it('exact mode does not match partial names', () => {
        const r = literalFilter(symbols, 'SVC', 'exact');
        assert.equal(r.length, 0);
    });

    it('prefix mode matches names starting with term', () => {
        const r = literalFilter(symbols, 'SVC', 'prefix');
        assert.equal(r.length, 3);
        // sorted by length: SVC_Init (8), SVC_init (8), SVC_InitScaleRatios (19)
        assert.equal(r[r.length - 1].name, 'SVC_InitScaleRatios');
    });

    it('prefix mode is case-insensitive', () => {
        const r = literalFilter(symbols, 'err', 'prefix');
        assert.deepEqual(r.map(s => s.name), ['error_exit']);
    });
});
