// Lexical enclosing-function recovery (pure, no vscode/tree-sitter dependency).
//
// tree-sitter can close a `function_definition` node EARLY when a body it can't
// parse cleanly — a GNU computed-goto interpreter (`goto *jumptable[…]`, `&&label`,
// `[0 ... 255]` designators, macro-generated jump labels, e.g. `___bpf_prog_run`
// in kernel/bpf/core.c) — makes it re-sync the body's tail as TOP-LEVEL statements
// (bare `labeled_statement`s / `switch`es). The C grammar accepts those, so they
// aren't even ERROR nodes (error ratio stays low, no grep fallback), yet every
// call/ref in that tail gets a `null` enclosing function and shows up under
// "(file scope)".
//
// The fix: the function's *brace* boundary in the raw text is reliable even when
// the AST node's end isn't. We brace-match each function's body — anchored at the
// AST's reliable function-header line — and re-attribute any call/ref the walk
// left at file scope to the function whose braces textually enclose it. This only
// FILLS nulls; a caller the AST already resolved is always kept (it is more
// precise about nesting). Braces inside comments/strings are ignored via the
// cross-line code mask.

import { maskCodeLines } from './grepScan';

/** A function-definition header location the AST reported reliably. */
export interface FuncAnchor {
  name: string;
  /** 0-based row of the function name token. */
  line: number;
  /** 0-based column of the function name token. */
  col: number;
}

/** A function's textual body span, `[startLine, endLine]` inclusive (0-based). */
export interface FuncRange {
  name: string;
  startLine: number;
  endLine: number;
}

/** How far past a header we look for the body's opening brace (multi-line sigs). */
const MAX_HEADER_SPAN = 60;

/**
 * Build a textual body range for each function anchor by brace-matching from its
 * header through `text`. An anchor whose body brace can't be found, or whose
 * braces never balance (runs to EOF), is skipped rather than given a bogus range.
 */
export function buildFuncRanges(text: string, anchors: FuncAnchor[]): FuncRange[] {
  if (!anchors.length) {
    return [];
  }
  const lines = text.split('\n');
  const masks = maskCodeLines(lines);
  const ranges: FuncRange[] = [];

  for (const a of anchors) {
    if (a.line < 0 || a.line >= lines.length) {
      continue;
    }
    const open = findBodyOpenBrace(lines, masks, a);
    if (!open) {
      continue; // prototype, or no body within the header span
    }
    const endLine = matchCloseBrace(lines, masks, open);
    if (endLine < 0) {
      continue; // unbalanced — don't fabricate a range
    }
    ranges.push({ name: a.name, startLine: a.line, endLine });
  }
  return ranges;
}

/**
 * The enclosing function for `line`, or null if it sits in no function body. When
 * ranges nest (C++), the innermost (latest-starting) containing range wins.
 */
export function enclosingFuncAt(ranges: FuncRange[], line: number): string | null {
  let best: FuncRange | null = null;
  for (const r of ranges) {
    if (line >= r.startLine && line <= r.endLine && (!best || r.startLine > best.startLine)) {
      best = r;
    }
  }
  return best ? best.name : null;
}

/** First code `{` at paren-depth 0 at/after the header — the body's opening brace. */
function findBodyOpenBrace(
  lines: string[],
  masks: Uint8Array[],
  a: FuncAnchor,
): { line: number; col: number } | null {
  let paren = 0;
  const lastLine = Math.min(lines.length - 1, a.line + MAX_HEADER_SPAN);
  for (let li = a.line; li <= lastLine; li++) {
    const line = lines[li];
    const mask = masks[li];
    const startCol = li === a.line ? a.col : 0;
    for (let ci = startCol; ci < line.length; ci++) {
      if (mask[ci]) {
        continue; // comment / string / char literal
      }
      const ch = line[ci];
      if (ch === '(') {
        paren++;
      } else if (ch === ')') {
        if (paren > 0) {
          paren--;
        }
      } else if (paren === 0) {
        if (ch === '{') {
          return { line: li, col: ci };
        }
        if (ch === ';') {
          return null; // prototype / declaration — no body
        }
      }
    }
  }
  return null;
}

/** Row of the `}` that closes the body opened at `open`, or -1 if unbalanced. */
function matchCloseBrace(
  lines: string[],
  masks: Uint8Array[],
  open: { line: number; col: number },
): number {
  let depth = 0;
  for (let li = open.line; li < lines.length; li++) {
    const line = lines[li];
    const mask = masks[li];
    const startCol = li === open.line ? open.col : 0;
    for (let ci = startCol; ci < line.length; ci++) {
      if (mask[ci]) {
        continue;
      }
      const ch = line[ci];
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return li;
        }
      }
    }
  }
  return -1;
}
