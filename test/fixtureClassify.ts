// Structural classification of the downloaded compiler-test fixtures, shared by the
// `compilerFixtures` test (the per-file verdict) and the `analyzeCompilerFixtures`
// analysis script. Pure text/heuristic helpers — no tree-sitter, no vscode.
//
// A fixture's ERROR nodes fall into four buckets:
//   expected  — a clang `-verify` / LIT negative test: the malformation is intentional.
//   knr       — obsolete K&R / implicit-int syntax we deliberately don't support.
//   recovered — a genuine tree-sitter gap (usually a near-standard GNU extension) where
//               the indexer still recovered every file-scope function symbol.
//   gap       — same, but a function symbol was dropped → a real defect to fix.
// The first two are recognised here; the last two are decided by comparing
// `fileScopeFunctionNames` against the index output.

// Clang `-verify` parser tests embed deliberately-malformed code marked with these
// directives; such a file's ERROR nodes are intentional. (`expected-no-diagnostics` is
// excluded on purpose — it marks a file that should parse cleanly, so an ERROR there is
// a genuine gap, not an expected one.)
export const EXPECTED_DIAG = /\bexpected-(error|warning|note|remark)\b/;

// A clang LIT `// RUN: not %clang …` line declares the file is expected to fail to
// compile — a negative / parser-limit stress test (e.g. a `-fbracket-depth` overflow
// torture case). Its ERROR nodes are intentional too, so treat it like `expected`.
export const CLANG_NEGATIVE_RUN = /\/\/\s*RUN:\s*not\s+%clang/;

// Keywords that can lead a declarator-shaped region without being a function name
// (control statements, type specifiers, GNU type keywords).
const KNR_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'do', 'return', 'sizeof', 'typedef', 'struct', 'union',
    'enum', 'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
    'const', 'volatile', 'static', 'extern', 'register', 'auto', 'inline', 'goto', 'else',
    'case', 'default', 'break', 'continue', '_Bool', 'bool', 'restrict', 'asm', '__asm',
    '__asm__', '__inline', '__inline__', '__extension__', 'typeof', '__typeof__', '_Complex',
    '__complex__', '__real__', '__imag__', '__const', '__restrict', '__attribute__',
]);

// Blank comments, string/char literals and preprocessor lines so their braces / parens /
// semicolons don't perturb the structural scans below.
export function blankForKnr(text: string): string {
    let s = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
                .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
    s = s.replace(/"(\\.|[^"\\\n])*"/g, (m) => `"${' '.repeat(Math.max(0, m.length - 2))}"`)
         .replace(/'(\\.|[^'\\\n])*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`);
    // Blank whole preprocessor directives, INCLUDING backslash line-continuations — a
    // multi-line `#define LIM2(x) LIM1(...) \ <newline> LIM1(...)` otherwise leaves its
    // macro-body `NAME(...)` tokens looking like function definitions. Newlines are kept
    // so line numbers / offsets are preserved.
    s = s.replace(/^[ \t]*#(?:.*\\\r?\n)*.*/gm, (m) => m.replace(/[^\n]/g, ' '));
    return s;
}

// --- K&R / pre-ANSI function-definition detector -------------------------------------
// K&R / implicit-int function definitions — a return-type-less `foo(a,b){…}` or
// old-style parameter declarations `foo(a,b) int a; {…}` — are genuinely obsolete C
// (implicit int was removed in C99). tree-sitter rightly cannot parse them, so we do
// NOT attempt recovery: we recognise the pattern and accept the ERROR nodes as correct.
// (GNU extensions / builtins are different — those are near-standard and ARE worth
// handling, so they stay UNEXPECTED until the indexer supports them.)

// Signal 1: K&R parameter declarations sit between `)` and `{` — ANSI never has a `;`
// there, so this is an unambiguous old-style definition.
const RE_KNR_PARAMS = /\)\s*(?:[A-Za-z_][\w *,\t\n]*?\s+\**[A-Za-z_][\w *,\t\[\]]*;\s*)+\{/;
// Signal 2: implicit-int definition — a file-scope `{` body whose header is
// `IDENT(params)` with no return type (the name is the statement's first token).
const RE_KNR_HEADER = /(?:^|[;}])\s*([A-Za-z_]\w*)\s*\([^{}]*\)\s*(?:[A-Za-z_][^{};]*;\s*)*$/;

export function looksLikeKnrImplicitInt(text: string): boolean {
    const s = blankForKnr(text);
    if (RE_KNR_PARAMS.test(s)) return true;
    let depth = 0;
    let blockStart = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '{') {
            if (depth === 0) {
                const m = RE_KNR_HEADER.exec(s.slice(blockStart, i));
                if (m && !KNR_KEYWORDS.has(m[1])) return true;
            }
            depth++;
        } else if (c === '}') {
            if (depth > 0) depth--;
            if (depth === 0) blockStart = i + 1;
        }
    }
    return false;
}

// --- File-scope function-definition extractor (the symbol-recovery yardstick) ---------
// The names a correct index must contain regardless of how tree-sitter recovers from an
// ERROR. Every file-scope `{` body whose header ends in `NAME(params)` (+ optional
// trailing attributes / asm) is a function definition; a type body (`struct X {`), an
// initializer (`… = {`) or a control statement has no such header and is skipped. This
// runs only on NON-K&R files, so the header carries no old-style param declarations —
// the region is reset at each top-level `;` so a preceding prototype (which ends in `;`,
// never a `{`) can't be mistaken for the definition that follows it.
const RE_FN_HEADER = /([A-Za-z_]\w*)\s*\([^{}]*\)\s*[^{};]*$/;

export function fileScopeFunctionNames(text: string): string[] {
    const s = blankForKnr(text);
    const names: string[] = [];
    let depth = 0;
    let blockStart = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '{') {
            if (depth === 0) {
                const region = s.slice(blockStart, i);
                if (!/=\s*$/.test(region)) {
                    const m = RE_FN_HEADER.exec(region);
                    if (m && !KNR_KEYWORDS.has(m[1])) names.push(m[1]);
                }
            }
            depth++;
        } else if (c === '}') {
            if (depth > 0) depth--;
            if (depth === 0) blockStart = i + 1;
        } else if (c === ';' && depth === 0) {
            blockStart = i + 1;
        }
    }
    return names;
}
