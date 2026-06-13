// Text-level helpers for the grep fallback. The companion module
// `regexScanner.ts` (`scanWithRegex`) extracts symbol/ref/call rows when
// tree-sitter fails; these helpers do the finer-grained text classification that
// the fallback and reference scan rely on without a parse:
//   - classify which bytes of a line are *code* (mask 0) vs inside a comment or
//     string/char literal (mask 1), so a word search skips false positives in
//     comments and strings (block comments span lines; string/char literals do not);
//   - find whole-word, code-only occurrences of a name (`grepWordInContent`);
//   - decide whether a line looks like a function *definition* (`looksLikeFuncDef`)
//     when tree-sitter loses a function.
// Escaped quotes are handled by backslash-run parity (a lone `\` escapes the
// next char, so consecutive backslashes pair off).

export interface GrepHit {
  line: number;
  col: number;
}

interface MaskResult {
  mask: Uint8Array;
  /** Whether the line ends still inside an unterminated block comment. */
  inBlockComment: boolean;
}

/** Mask a single line, optionally starting inside a block comment. */
function maskLine(line: string, startInBlock: boolean): MaskResult {
  const n = line.length;
  const mask = new Uint8Array(n);
  type S = 'code' | 'block' | 'dq' | 'sq';
  let state: S = startInBlock ? 'block' : 'code';
  let i = 0;
  while (i < n) {
    const c = line[i];
    const c2 = i + 1 < n ? line[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        // line comment: everything to end of line is comment
        for (let k = i; k < n; k++) {
          mask[k] = 1;
        }
        break;
      } else if (c === '/' && c2 === '*') {
        mask[i] = 1;
        mask[i + 1] = 1;
        state = 'block';
        i += 2;
      } else if (c === '"') {
        mask[i] = 1;
        state = 'dq';
        i++;
      } else if (c === "'") {
        mask[i] = 1;
        state = 'sq';
        i++;
      } else {
        mask[i] = 0;
        i++;
      }
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        mask[i] = 1;
        mask[i + 1] = 1;
        state = 'code';
        i += 2;
      } else {
        mask[i] = 1;
        i++;
      }
    } else {
      // inside a string ('dq') or char ('sq') literal
      const quote = state === 'dq' ? '"' : "'";
      mask[i] = 1;
      if (c === '\\') {
        // backslash escapes the next char (parity: \\ pairs off, \" stays open)
        if (i + 1 < n) {
          mask[i + 1] = 1;
        }
        i += 2;
      } else if (c === quote) {
        state = 'code';
        i++;
      } else {
        i++;
      }
    }
  }
  return { mask, inBlockComment: state === 'block' };
}

/** Per-byte code/non-code mask for one line (0 = code, 1 = comment/string). */
export function buildCodeMask(line: string): Uint8Array {
  return maskLine(line, false).mask;
}

/**
 * Per-byte code masks for every line, tracking block comments across line
 * boundaries (a `/* … *\/` spanning multiple lines masks each line correctly).
 * Use this — not per-line `buildCodeMask` — when brace/word matching must ignore
 * braces or identifiers sitting inside a multi-line block comment.
 */
export function maskCodeLines(lines: string[]): Uint8Array[] {
  const masks: Uint8Array[] = [];
  let inBlock = false;
  for (const line of lines) {
    const { mask, inBlockComment } = maskLine(line, inBlock);
    masks.push(mask);
    inBlock = inBlockComment;
  }
  return masks;
}

/**
 * Is the whole line a comment (line `//`, block `/* … `, or a `*` continuation
 * line)? Heuristic, used to cheaply skip obvious comment lines.
 */
export function isCommentOrStringLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/** Is the character at `col` inside a comment or string/char literal? */
export function isInsideCommentOrString(line: string, col: number): boolean {
  const mask = buildCodeMask(line);
  return col >= 0 && col < mask.length && mask[col] === 1;
}

function escapeRegex(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FUNC_REJECT_KEYWORDS = new Set([
  'return', 'if', 'while', 'for', 'switch', 'case', 'goto', 'sizeof', 'typeof',
  'else', 'do', 'break', 'continue',
]);

/**
 * Heuristic: does line `lineIdx` look like a *definition* of function
 * `targetName` (vs a prototype, call site, `#define`, function pointer, extern
 * decl, …)? Used by the grep fallback when tree-sitter loses a function. The
 * caller handles word boundaries, so substring matching is intentional. The
 * brace must appear within ~5 lines of the header.
 */
export function looksLikeFuncDef(lines: string[], lineIdx: number, targetName: string): boolean {
  if (lineIdx < 0 || lineIdx >= lines.length) {
    return false;
  }
  const line = lines[lineIdx];
  if (line == null) {
    return false;
  }
  if (/^\s*#\s*define\b/.test(line)) {
    return false; // function-like macro / #define body
  }
  const esc = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s*\\(`).exec(line);
  if (!m) {
    return false;
  }
  const before = line.slice(0, m.index).trim();
  if (!funcReturnTypePrecedes(before, lines, lineIdx)) {
    return false;
  }
  return funcBracedBodyFollows(lines, lineIdx, m.index + m[0].length - 1);
}

function funcReturnTypePrecedes(before: string, lines: string[], lineIdx: number): boolean {
  if (before !== '') {
    const last = before[before.length - 1];
    if (last === '*' || last === '&') {
      return true; // pointer/ref return type
    }
    if (/[A-Za-z0-9_]/.test(last)) {
      const lw = /([A-Za-z_]\w*)$/.exec(before);
      return !(lw && FUNC_REJECT_KEYWORDS.has(lw[1]));
    }
    return false; // preceded by '(' '=' ',' ')' or an operator → a call, not a def
  }
  // Empty before: the return type may be on the previous (non-empty) line.
  for (let i = lineIdx - 1; i >= 0; i--) {
    const p = lines[i].trim();
    if (p === '') {
      continue;
    }
    if (/[(){};]/.test(p)) {
      return false;
    }
    return /^[A-Za-z_][\w\s*&:]*$/.test(p);
  }
  return false;
}

function funcBracedBodyFollows(lines: string[], lineIdx: number, openCol: number): boolean {
  const maxLine = Math.min(lines.length - 1, lineIdx + 4);
  let depth = 0;
  let close: { line: number; col: number } | null = null;
  for (let li = lineIdx; li <= maxLine && !close; li++) {
    const text = lines[li];
    const start = li === lineIdx ? openCol : 0;
    for (let ci = start; ci < text.length; ci++) {
      if (text[ci] === '(') {
        depth++;
      } else if (text[ci] === ')') {
        depth--;
        if (depth === 0) {
          close = { line: li, col: ci };
          break;
        }
      }
    }
  }
  if (!close) {
    return false;
  }
  let rest = '';
  for (let li = close.line; li <= maxLine; li++) {
    rest += `${lines[li].slice(li === close.line ? close.col + 1 : 0)}\n`;
  }
  rest = rest
    .replace(/__attribute__\s*\(\([\s\S]*?\)\)/g, ' ')
    .replace(/__\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return rest.startsWith('{');
}

/**
 * Find whole-word, code-only occurrences of `word` in multi-line `content`.
 * Skips matches inside comments and string/char literals (block comments are
 * tracked across lines). Returns 0-based {line, col} positions.
 */
export function grepWordInContent(content: string, word: string): GrepHit[] {
  if (!word) {
    return [];
  }
  const hits: GrepHit[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(word)}(?![A-Za-z0-9_])`, 'g');
  const lines = content.split('\n');
  const masks = maskCodeLines(lines);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const mask = masks[ln];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (mask[m.index] === 0) {
        hits.push({ line: ln, col: m.index });
      }
    }
  }
  return hits;
}
