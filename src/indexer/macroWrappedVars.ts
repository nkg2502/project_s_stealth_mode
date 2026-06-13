import type { FileIndex, SymbolRow } from '../core/types';
import { stripComments } from './regexScanner';

// Declaration-wrapping section/attribute macros, e.g.
//   MVP_Plan_t SECTION_BSS(MVP_Plan, "FTL_DPS3_2_BSS");
// parse as a function prototype named after the MACRO (or as an ERROR node),
// hiding the real variable. This text post-pass recovers the wrapped variable
// and suppresses the bogus MACRO symbol — applied uniformly to the tree-sitter
// and grep results (the borderline parse lands on either path).
//
// The pattern is `TYPE ALL_CAPS_MACRO(var, ...);` with >= 2 args whose first
// unwraps to a non-keyword identifier. Requiring an ALL_CAPS wrapper, >= 2 args,
// and a non-keyword first arg keeps ordinary prototypes such as `void RESET(void);`
// (one keyword arg) or `int FOO(int a, int b);` (typed args don't unwrap) from
// being misread as wrapped variables, while still accepting a numeric section
// (`ALIGN_TO(buf, 64)`) that carries no string literal.

const MACRO_WRAP_RE = /^\s*([A-Za-z_]\w*(?:\s*\*+)?)\s+([A-Z][A-Z0-9_]+)\s*\((.*)\)\s*;\s*$/;

// C/C++ keywords that can appear as a bare first "argument" of a real prototype
// (`void RESET(void)`), which must NOT be taken as a wrapped variable name.
const KEYWORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  '_Bool', 'bool', 'const', 'volatile', 'struct', 'union', 'enum', 'static',
  'extern', 'register', 'auto', 'restrict', 'inline', 'typedef', 'return',
]);

/** Split on top-level commas (ignoring those nested in `()`/`[]`). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === ')' || ch === ']') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length) {
    parts.push(cur);
  }
  return parts;
}

/** Unwrap nested wrapping macros / array dimensions to the bare variable name. */
function unwrapVarName(arg: string): string | undefined {
  const a = arg.trim();
  const nested = /^([A-Z][A-Z0-9_]+)\s*\((.*)\)$/.exec(a);
  if (nested) {
    return unwrapVarName(splitTopLevel(nested[2])[0] ?? '');
  }
  if (/^[A-Za-z_]\w*(\s*\[[^\]]*\])?\s*$/.test(a)) {
    const m = /^([A-Za-z_]\w*)/.exec(a);
    return m ? m[1] : undefined;
  }
  return undefined;
}

export interface MacroWrappedVar {
  /** The recovered variable name (the macro's first argument, unwrapped). */
  name: string;
  line: number;
  col: number;
  /** The wrapping macro's name (the bogus symbol to suppress). */
  wrapper: string;
}

/**
 * Scan `text` for file-scope declaration-wrapping macros and return the wrapped
 * variables they hide. Only matches at brace depth 0 (true file scope), and only
 * for an ALL_CAPS wrapper with >= 2 args whose first unwraps to a non-keyword
 * identifier.
 */
export function scanMacroWrappedVars(text: string): MacroWrappedVar[] {
  const lines = stripComments(text).split('\n');
  const out: MacroWrappedVar[] = [];
  let depth = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (depth === 0) {
      const m = MACRO_WRAP_RE.exec(line);
      if (m) {
        const wrapper = m[2];
        const args = splitTopLevel(m[3]);
        if (args.length >= 2) {
          const name = unwrapVarName(args[0] ?? '');
          if (name && !KEYWORDS.has(name)) {
            const col = Math.max(0, line.indexOf(name, line.indexOf('(')));
            out.push({ name, line: ln, col, wrapper });
          }
        }
      }
    }
    for (const ch of line) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return out;
}

/**
 * Augment a FileIndex with macro-wrapped variables and drop the bogus
 * wrapper-macro symbol (and its spurious call edge) at each wrap site.
 */
export function applyMacroWrappedVars(fi: FileIndex, text: string): void {
  const found = scanMacroWrappedVars(text);
  if (found.length === 0) {
    return;
  }
  // Suppress the wrapper macro mis-indexed as a prototype/function at its line.
  const wrapperAt = new Set(found.map((f) => `${f.wrapper} ${f.line}`));
  fi.symbols = fi.symbols.filter(
    (s) => !(wrapperAt.has(`${s.name} ${s.line}`) && (s.kind === 'prototype' || s.kind === 'function')),
  );
  fi.calls = fi.calls.filter((c) => !wrapperAt.has(`${c.callee} ${c.line}`));

  const existingVars = new Set(
    fi.symbols.filter((s) => s.kind === 'global_variable').map((s) => s.name),
  );
  for (const v of found) {
    if (existingVars.has(v.name)) {
      continue;
    }
    const row: SymbolRow = {
      name: v.name,
      kind: 'global_variable',
      file: fi.file,
      line: v.line,
      col: v.col,
      endLine: v.line,
      endCol: v.col + v.name.length,
      isDefinition: true,
      source: fi.parsedBy,
    };
    fi.symbols.push(row);
    existingVars.add(v.name);
  }
}
