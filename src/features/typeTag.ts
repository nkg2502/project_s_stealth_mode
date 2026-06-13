// Pure (vscode-free) heuristic that recognises a struct/union/enum/class *tag*
// used as a type, e.g. `struct inode *p;`. When the word under the cursor is
// immediately preceded by one of these keywords it is an aggregate tag, so
// Go-to-Definition must resolve to the aggregate's definition — never to every
// same-named struct *field* (the noise this module exists to suppress).
//
// Kept dependency-free so the indexer/store tests can exercise it headlessly.

import type { SymbolKind } from '../core/types';

/** The elaborated-type keywords that introduce an aggregate tag. */
const TAG_KEYWORDS: Record<string, SymbolKind[]> = {
  // In C++ `struct` and `class` are interchangeable as elaborated type
  // specifiers (`struct Foo` may name a `class Foo`), so accept either kind.
  struct: ['struct', 'class'],
  class: ['class', 'struct'],
  union: ['union'],
  enum: ['enum'],
};

/**
 * If the text immediately before the cursor word is a `struct` / `union` /
 * `enum` / `class` keyword, return the symbol kind(s) the word must resolve to;
 * otherwise `undefined` (no restriction — resolve as before).
 *
 * `textBeforeWord` is the line content from column 0 up to the start of the word.
 */
export function tagKindBefore(textBeforeWord: string): SymbolKind[] | undefined {
  // The last identifier token on the line before the word, requiring at least
  // one separating space/tab (so `struct ` matches but `my_struct` does not).
  const m = /(^|[^\w])(struct|class|union|enum)\s+$/.exec(textBeforeWord);
  if (!m) {
    return undefined;
  }
  return TAG_KEYWORDS[m[2]];
}
