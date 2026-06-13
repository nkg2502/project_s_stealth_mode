// Pure (vscode-free) cursor-context heuristic, sibling to typeTag.ts. A bare
// `name(...)` invocation can only be a function / macro / function-pointer — it
// can NEVER be a struct *field*, because reaching a field requires `obj.` /
// `obj->`. So when the cursor word is immediately followed by `(` and is not a
// member access, Go-to-Definition must drop same-named `field` results —
// otherwise F12 on a call like `spin_lock(&x)` lists every struct member also
// named `spin_lock` (the noise this module exists to suppress).
//
// This is the symmetric counterpart to typeTag.ts: that one narrows on the
// keyword *before* the word (`struct X`), this one on the `(` *after* it.
//
// Kept dependency-free so the store/indexer tests can exercise it headlessly.

import type { SymbolKind } from '../core/types';

/**
 * True when the word at the cursor is invoked as a call (`name(`) and is NOT a
 * member access (`obj.name(` / `obj->name(`). `textBeforeWord` is the line from
 * column 0 up to the start of the word; `textAfterWord` is the line from the end
 * of the word onward. A space between the word and the paren is allowed.
 */
export function isCallTarget(textBeforeWord: string, textAfterWord: string): boolean {
  if (!/^\s*\(/.test(textAfterWord)) {
    return false; // not invoked as a call
  }
  // A member access (`obj.` / `obj->`) right before the word means this *could*
  // legitimately be a function-pointer field call — keep field results then.
  return !/(\.|->)\s*$/.test(textBeforeWord);
}

/**
 * Drop same-named struct `field` hits when the cursor word is a bare call target
 * (see isCallTarget). Returns the input unchanged when it isn't a call target,
 * and never hides a valid target: if every hit is a field, all are kept.
 */
export function narrowCallTarget<T extends { kind: SymbolKind }>(
  hits: T[],
  textBeforeWord: string,
  textAfterWord: string,
): T[] {
  if (!isCallTarget(textBeforeWord, textAfterWord)) {
    return hits;
  }
  const nonFields = hits.filter((h) => h.kind !== 'field');
  return nonFields.length ? nonFields : hits;
}
