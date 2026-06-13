// Query parsing for the F10 fuzzy symbol picker. Supports a leading single-letter
// kind prefix and a text-match mode marker (`'` exact, `^` prefix); anything else
// is a fuzzy match. The prefixes collapse the 14 searchable `SymbolKind`s into a
// handful of intuitive buckets:
//   f: functions (function + prototype)   v: global variables
//   t: types (struct/union/enum/enumerator/class/typedef)
//   m: members (struct field + C++ method) d: macros
//   l: goto labels                         n: C++ namespaces
// Parameters/locals never reach the symbols table, so they are not searchable.
// A C++ scope qualifier like `s::iterator` (double colon) is deliberately NOT
// treated as a kind prefix.
//
// Pure (no vscode / no SQLite) so it is headless-testable; the live picker
// (features/fuzzySearch.ts) feeds it the raw query, fetches matching candidates
// from SQLite (searchSymbolNames) using the parsed kinds, and ranks them.

import type { SymbolKind } from '../core/types';

export type MatchMode = 'fuzzy' | 'exact' | 'prefix';

export interface ParsedQuery {
  /** Kind filter, or undefined for "any kind". */
  kinds: SymbolKind[] | undefined;
  mode: MatchMode;
  term: string;
}

/** Single-letter kind prefixes mapped to the concrete live kinds they cover. */
const KIND_PREFIX: Record<string, SymbolKind[]> = {
  f: ['function', 'prototype'],
  v: ['global_variable'],
  t: ['struct', 'union', 'enum', 'enumerator', 'class', 'typedef'],
  m: ['field', 'method'],
  d: ['macro'],
  l: ['label'],
  n: ['namespace'],
};

export function parseQuery(raw: string): ParsedQuery {
  let s = raw;
  let kinds: SymbolKind[] | undefined;

  // A known kind prefix is a single letter + ':' NOT followed by another ':'
  // (so the C++ scope operator `f::bar` / `s::iterator` is left as plain text).
  const m = /^([fvtmdln]):(?!:)/.exec(s);
  if (m) {
    kinds = KIND_PREFIX[m[1]];
    s = s.slice(m[0].length);
  }

  // A space right after the prefix is ignored ("l: again" == "l:again").
  s = s.replace(/^\s+/, '');

  let mode: MatchMode = 'fuzzy';
  if (s.startsWith("'")) {
    mode = 'exact';
    s = s.slice(1);
  } else if (s.startsWith('^')) {
    mode = 'prefix';
    s = s.slice(1);
  }

  return { kinds, mode, term: s };
}

/**
 * Literal (non-fuzzy) filter: `exact` matches the whole name case-insensitively,
 * `prefix` matches names starting with the term. Results are ordered by name
 * length (shortest first) so the closest match leads.
 */
export function literalFilter<T extends { name: string }>(
  symbols: readonly T[],
  term: string,
  mode: 'exact' | 'prefix',
  max?: number,
): T[] {
  const t = term.toLowerCase();
  const res = symbols.filter((s) => {
    const n = s.name.toLowerCase();
    return mode === 'exact' ? n === t : n.startsWith(t);
  });
  res.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return max !== undefined ? res.slice(0, max) : res;
}
