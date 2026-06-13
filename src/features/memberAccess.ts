// Pure (vscode-free) member-access cursor heuristics, sibling to callContext.ts
// and typeTag.ts. Two concerns live here:
//
//   1. symbolContextAt — read the word under the cursor plus the surrounding
//      syntax: is it a member access (`obj.field` / `ptr->field`), what is the
//      base object name, and is it scope-qualified (`Foo::word`). Hard keywords
//      resolve to nothing (an empty word) so navigation never jumps on `struct`,
//      `if`, `#ifdef`, etc.
//   2. narrowByMemberAccess — once definitions are gathered, a member access
//      prefers struct `field`/`member` hits (you reached it via `obj.`/`obj->`),
//      while a bare usage prefers non-members (a variable/function wins over a
//      same-named field). Never hides the only available kind.
//
// Kept dependency-free (only the keyword set) so the store/indexer tests can
// exercise it headlessly, and so features/resolve.ts can share it without a
// vscode round-trip. This is the live counterpart of the old, unwired
// providers/definitionProvider.ts (`SymbolHopperDefinitionProvider`).

import { C_CPP_KEYWORDS } from '../indexer/defaults';

export interface PositionLike {
  line: number;
  character: number;
}
export interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}
export interface DocumentLike {
  uri: { fsPath: string };
  lineAt(line: number): { text: string };
  getWordRangeAtPosition(position: PositionLike, regex: RegExp): RangeLike | undefined;
  getText(range?: RangeLike): string;
}

/** What the cursor sits on, plus the syntactic context around it. */
export interface SymbolContext {
  /** The identifier under the cursor; empty for a keyword / no word. */
  word: string;
  /** Word range in the document (absent when there is no word). */
  range?: RangeLike;
  /** Scope qualifier when the word is part of `Scope::word` / `word::Target`. */
  scope?: string;
  /** true when the word is reached via `obj.` / `obj->`. */
  isMemberAccess?: boolean;
  /** Base object of the member access (`arr[0]`→`arr`, `(*p)`→`p`). */
  objectName?: string;
  /**
   * Full base chain from the root object to the immediate parent, for multi-hop
   * member access: `outer->rtf.field` (cursor on `field`) → `['outer', 'rtf']`.
   * `['a']` for a single hop `a->field`. The root is a local/parameter; the rest
   * are field-typed sub-objects walked hop by hop during resolution.
   */
  memberChain?: string[];
  /**
   * Number of arguments at the call site when the word is immediately followed by
   * `(args)` on the same line (`foo(a, b)` → 2; empty `()` → 0). `undefined` when
   * not a call or the parentheses don't close on this line. Disambiguates
   * same-named functions by arity.
   */
  callArity?: number;
}

// Same identifier shape as features/nav.ts. Non-global so VS Code's real
// getWordRangeAtPosition accepts it directly (a global flag is stripped/ignored);
// the test mocks add the `g` flag themselves when they scan with exec().
const WORD_RE = /[A-Za-z_]\w*/;

/** Struct/aggregate member kinds — what `obj.x` / `ptr->x` can reach. */
export const MEMBER_KINDS: ReadonlySet<string> = new Set(['field', 'member']);

/**
 * Read the word at `position` plus its member-access / scope context. Returns an
 * empty word (and no range) when the cursor is on a hard keyword or no word —
 * the signal for callers to resolve to nothing rather than jump.
 */
export function symbolContextAt(doc: DocumentLike, position: PositionLike): SymbolContext {
  const lineText = doc.lineAt(position.line).text;
  const range = doc.getWordRangeAtPosition(position, WORD_RE);
  if (!range) {
    return { word: '' };
  }
  const word = doc.getText(range);
  if (!word || C_CPP_KEYWORDS.has(word)) {
    return { word: '' };
  }
  const wordStart = range.start.character;
  const wordEnd = range.end.character;
  const before = lineText.substring(0, wordStart);
  // Argument count when the word is the callee of `word(args)` on this line.
  const callArity = countCallArgs(lineText.slice(wordEnd));

  // member access: obj. / ptr-> / obj . field (spaces allowed)
  const op = /(\.|->)\s*$/.exec(before);
  if (op) {
    const prefix = before.slice(0, op.index);
    const memberChain = extractMemberChain(prefix);
    const objectName = memberChain.length ? memberChain[memberChain.length - 1] : extractObjectName(prefix);
    return { word, range, isMemberAccess: true, objectName, memberChain, callArity };
  }
  // scope: Foo::word  (cursor on the member)
  if (wordStart >= 2 && lineText.substring(wordStart - 2, wordStart) === '::') {
    const sm = lineText.substring(0, wordStart - 2).match(/([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)$/);
    if (sm) {
      return { word, range, scope: sm[1], callArity };
    }
  }
  // scope: word::Target  (cursor on the scope part)
  if (lineText.substring(wordEnd, wordEnd + 2) === '::') {
    const tm = lineText.substring(wordEnd + 2).match(/^[A-Za-z_]\w*/);
    if (tm) {
      return { word: tm[0], range, scope: word };
    }
  }
  return { word, range, callArity };
}

/**
 * Count the top-level, comma-separated arguments of a call when `s` begins (after
 * optional whitespace) with `(`. Nested `()[]{}` and string/char literals are
 * skipped, so `(f(x, y), z)` → 2 and `(a, "x, y")` → 2. `()` → 0. Returns
 * `undefined` when `s` is not a call or the parentheses never close (a multi-line
 * argument list — we give up rather than guess).
 */
export function countCallArgs(s: string): number | undefined {
  let i = 0;
  while (i < s.length && /\s/.test(s[i])) {
    i++;
  }
  if (s[i] !== '(') {
    return undefined;
  }
  i++; // consume '('
  let depth = 1;
  let sawArg = false;
  let args = 0;
  let str: string | null = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (c === '\\') {
        i++;
      } else if (c === str) {
        str = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      str = c;
      sawArg = true;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      sawArg = true;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return sawArg ? args + 1 : 0; // closing the call's own '('
      }
      sawArg = true;
    } else if (c === ',' && depth === 1) {
      args++;
    } else if (!/\s/.test(c)) {
      sawArg = true;
    }
  }
  return undefined; // never closed on this line
}

/**
 * A member access (`obj.x` / `ptr->x`) can only denote a struct member — or, in
 * macro-heavy code, a `macro`. So it is restricted to those kinds and every
 * structurally-impossible candidate (a goto `label`, a function, a type tag, …) is
 * dropped, *even when no member is indexed*: a wrong jump (e.g. to an unrelated
 * `x:` label elsewhere) is worse than no jump. This mirrors role-based resolution's
 * `kindsForRole('field') = {field, macro}` for the grep/text fallback, where the
 * cursor token has no AST role. A bare usage instead prefers non-members
 * (variable/function wins over a same-named field) but never hides the only kind.
 */
export function narrowByMemberAccess<T extends { kind: string }>(
  hits: T[],
  isMemberAccess?: boolean,
): T[] {
  if (isMemberAccess) {
    return hits.filter((h) => MEMBER_KINDS.has(h.kind) || h.kind === 'macro');
  }
  const nonMembers = hits.filter((h) => !MEMBER_KINDS.has(h.kind));
  return nonMembers.length ? nonMembers : hits;
}

/** Base object of a member-access expression: `arr[0]`→`arr`, `(*p)`→`p`. */
export function extractObjectName(objExpr: string): string | undefined {
  let s = objExpr.trim();
  const paren = /\(\s*\*?\s*([A-Za-z_]\w*)\s*\)\s*$/.exec(s);
  if (paren) {
    return paren[1];
  }
  s = s.replace(/\[[^\]]*\]\s*$/, ''); // drop a trailing subscript
  const id = /([A-Za-z_]\w*)\s*$/.exec(s);
  return id ? id[1] : undefined;
}

/**
 * Parse the base chain of a member-access expression (everything before the
 * trailing `.`/`->`) into its object identifiers, root first:
 * `outer->rtf` → `['outer', 'rtf']`, `a` → `['a']`. Walks right-to-left peeling
 * one object token (with optional `[..]` / `(*..)`) then a `.`/`->` separator;
 * stops at the first non-chain boundary (so `foo(x).y` yields just `['x']`-ish
 * best-effort). Returns `[]` when no object is found.
 */
export function extractMemberChain(prefix: string): string[] {
  const chain: string[] = [];
  let s = prefix;
  for (;;) {
    const obj = extractObjectName(s);
    if (!obj) {
      break;
    }
    chain.unshift(obj);
    const cut = s.lastIndexOf(obj);
    if (cut < 0) {
      break;
    }
    s = s.slice(0, cut).replace(/[\s(*]+$/, '');
    const sep = /(\.|->)\s*$/.exec(s);
    if (!sep) {
      break;
    }
    s = s.slice(0, sep.index);
  }
  return chain;
}
