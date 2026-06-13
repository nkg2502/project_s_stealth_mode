import type { CallRow, Lang, RefRow, SymbolKind, SymbolRow } from '../core/types';

// Fallback scanner used when tree-sitter fails or is low-confidence. Produces
// the same row shape as extract.ts (source = 'grep'). Comments MUST be removed
// textually first (tree-sitter isn't filtering them on this path); string/char
// literals are preserved and line numbers are kept stable.

export interface ScanResult {
  symbols: SymbolRow[];
  refs: RefRow[];
  calls: CallRow[];
}

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return',
  'goto', 'break', 'continue', 'sizeof', 'typedef', 'struct', 'union', 'enum',
  'const', 'static', 'extern', 'volatile', 'register', 'unsigned', 'signed',
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'inline',
  'restrict', '_Bool', 'typeof', 'asm', 'auto', 'register',
  // C++
  'class', 'namespace', 'template', 'typename', 'public', 'private',
  'protected', 'virtual', 'override', 'final', 'new', 'delete', 'this',
  'operator', 'using', 'friend', 'explicit', 'mutable', 'constexpr',
  'nullptr', 'true', 'false', 'try', 'catch', 'throw',
]);

/** Replace comment bytes with spaces, preserving length, newlines, and literals. */
export function stripComments(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  type S = 'code' | 'line' | 'block' | 'dq' | 'sq';
  let state: S = 'code';
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        state = 'line';
      } else if (c === '/' && c2 === '*') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        state = 'block';
      } else if (c === '"') {
        state = 'dq';
        i++;
      } else if (c === "'") {
        state = 'sq';
        i++;
      } else {
        i++;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
      } else {
        out[i] = ' ';
      }
      i++;
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        state = 'code';
      } else {
        if (c !== '\n') {
          out[i] = ' ';
        }
        i++;
      }
    } else if (state === 'dq') {
      if (c === '\\') {
        i += 2;
      } else {
        if (c === '"') {
          state = 'code';
        }
        i++;
      }
    } else {
      // sq
      if (c === '\\') {
        i += 2;
      } else {
        if (c === "'") {
          state = 'code';
        }
        i++;
      }
    }
  }
  return out.join('');
}

const RE_DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)/;
const RE_TYPEDEF = /^\s*typedef\b.*?\b([A-Za-z_]\w*)\s*;\s*$/;
const RE_TAG = /\b(struct|union|enum)\s+([A-Za-z_]\w*)(?!\s*\*|\s+[A-Za-z_])/g;
const RE_FUNC_DEF = /^[A-Za-z_][\w\s*&]*?\b([A-Za-z_]\w*)\s*\([^()]*\)\s*\{\s*$/;
const RE_FUNC_PROTO = /^[A-Za-z_][\w\s*&]*?\b([A-Za-z_]\w*)\s*\([^()]*\)\s*;\s*$/;
// A file-scope function-POINTER declaration `[storage] ret (*name)(params…` — the
// name lives inside the `(*…)` group (so RE_FUNC_PROTO, which forbids nested parens,
// never matches it) and the param list may wrap to later lines (so we don't anchor a
// closing `);`). Column-0 anchored like the func regexes, so an indented struct
// member isn't mistaken for a global. A `typedef` line is excluded by the caller.
const RE_FUNC_PTR_DECL = /^[A-Za-z_][\w\s*&]*?\(\s*\*+\s*([A-Za-z_]\w*)\s*\)\s*\(/;
const RE_LABEL = /^\s*([A-Za-z_]\w*)\s*:(?![:=])/;
const RE_CALL = /\b([A-Za-z_]\w*)\s*\(/g;
const RE_IDENT = /\b([A-Za-z_]\w*)\b/g;

export function scanWithRegex(text: string, file: string, _lang: Lang): ScanResult {
  const stripped = stripComments(text);
  const lines = stripped.split('\n');
  const symbols: SymbolRow[] = [];
  const refs: RefRow[] = [];
  const calls: CallRow[] = [];

  const push = (
    name: string,
    kind: SymbolKind,
    line: number,
    col: number,
    isDefinition: boolean,
  ): void => {
    symbols.push({
      name,
      kind,
      file,
      line,
      col,
      endLine: line,
      endCol: col + name.length,
      isDefinition,
      source: 'grep',
    });
  };

  let braceDepth = 0;
  let currentFunc: string | null = null;

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];

    let m = RE_DEFINE.exec(line);
    if (m) {
      push(m[1], 'macro', ln, line.indexOf(m[1]), true);
    }

    m = RE_TYPEDEF.exec(line);
    if (m && !KEYWORDS.has(m[1])) {
      push(m[1], 'typedef', ln, line.lastIndexOf(m[1]), true);
    }

    RE_TAG.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = RE_TAG.exec(line))) {
      const kind = (t[1] === 'struct' ? 'struct' : t[1] === 'union' ? 'union' : 'enum') as SymbolKind;
      push(t[2], kind, ln, line.indexOf(t[2], t.index), true);
    }

    const def = RE_FUNC_DEF.exec(line);
    const fptr = !def && !/^\s*typedef\b/.test(line) ? RE_FUNC_PTR_DECL.exec(line) : null;
    if (def && !KEYWORDS.has(def[1])) {
      const col = line.indexOf(def[1]);
      push(def[1], 'function', ln, col, true);
      if (braceDepth === 0) {
        currentFunc = def[1];
      }
    } else if (fptr && !KEYWORDS.has(fptr[1])) {
      // A function-pointer global (`[extern] ret (*name)(params)`) is a VARIABLE — a
      // declaration when `extern`, otherwise a tentative definition.
      push(fptr[1], 'global_variable', ln, line.indexOf(fptr[1]), !/\bextern\b/.test(line));
    } else {
      const proto = RE_FUNC_PROTO.exec(line);
      if (proto && !KEYWORDS.has(proto[1])) {
        push(proto[1], 'prototype', ln, line.indexOf(proto[1]), false);
      }
    }

    const lab = RE_LABEL.exec(line);
    if (lab && !KEYWORDS.has(lab[1])) {
      push(lab[1], 'label', ln, line.indexOf(lab[1]), true);
    }

    // best-effort calls and refs
    RE_CALL.lastIndex = 0;
    let cm: RegExpExecArray | null;
    const calleesOnLine = new Set<number>();
    while ((cm = RE_CALL.exec(line))) {
      if (!KEYWORDS.has(cm[1])) {
        calleesOnLine.add(cm.index);
        calls.push({
          caller: currentFunc,
          callee: cm[1],
          file,
          line: ln,
          col: cm.index,
          source: 'grep',
        });
      }
    }

    RE_IDENT.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = RE_IDENT.exec(line))) {
      if (!KEYWORDS.has(im[1])) {
        // A member/designator access (`obj->x`, `obj.x`, `{ .x = … }`) is the one
        // thing the grep scanner can classify structurally: tag it role='field' so a
        // field's references can require an exact field role (and a value's references
        // can exclude member accesses). Everything else stays role='' — ambiguous, so
        // resolution keeps using the text heuristics and References keeps it best-effort.
        const pre = line.slice(0, im.index).replace(/\s+$/, '');
        const isMember = pre.endsWith('->') || (pre.endsWith('.') && !pre.endsWith('..'));
        refs.push({
          name: im[1],
          file,
          line: ln,
          col: im.index,
          enclosingFunc: currentFunc,
          isLocal: false, // grep has no scope analysis — name-based only
          role: isMember ? 'field' : '', // '' = no AST role → text-heuristic resolution
          source: 'grep',
        });
      }
    }

    // update brace depth using the (comment-stripped) line
    for (const ch of line) {
      if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        if (braceDepth === 0) {
          currentFunc = null;
        }
      }
    }
  }

  return { symbols, refs, calls };
}
