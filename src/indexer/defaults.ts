// Keyword classification used to suppress navigation/indexing of language
// tokens. Two tiers:
//   - HARD keywords are never user symbols (real C/C++ keywords + the standard
//     literal macros NULL / TRUE / FALSE / EOF). They are always blocked.
//   - SOFT keywords are Windows/firmware type macros (BOOL, VOID, UINT, …) that
//     LOOK like keywords but are often user-defined typedefs/macros. They are
//     NOT blocked: F12 lets the index decide (jump if a definition exists).

import { C_CPP_KEYWORDS as BASE_KEYWORDS } from './keywords';

/** Hard-blocked tokens: real keywords + standard literal macros + std types. */
export const C_CPP_KEYWORDS: ReadonlySet<string> = new Set<string>([
  ...BASE_KEYWORDS,
  'NULL', 'TRUE', 'FALSE', 'EOF',
  // preprocessor directive words (skip navigation on #ifdef NAME etc.)
  'define', 'include', 'ifdef', 'ifndef', 'endif', 'elif', 'undef', 'pragma', 'defined',
  // fixed-width / std types — not user symbols to navigate
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t', 'wchar_t',
  'char16_t', 'char32_t',
  // context-sensitive C++ identifiers treated as keywords here
  'override', 'final',
]);

/**
 * Soft keywords — uppercase Windows/firmware type macros that pass through to
 * the index (which decides whether a definition exists) instead of being
 * hard-blocked like real keywords.
 */
export const C_CPP_SOFT_KEYWORDS: ReadonlySet<string> = new Set<string>([
  // Windows-style
  'BOOL', 'BOOLEAN', 'VOID', 'BYTE', 'WORD', 'DWORD', 'QWORD',
  'CHAR', 'UCHAR', 'SHORT', 'USHORT', 'LONG', 'ULONG',
  'INT', 'UINT', 'FLOAT', 'DOUBLE',
  'WCHAR', 'TCHAR', 'HANDLE', 'LPVOID', 'LPSTR', 'LPCSTR',
  // Fixed-width firmware typedefs
  'INT8', 'INT16', 'INT32', 'INT64',
  'UINT8', 'UINT16', 'UINT32', 'UINT64',
  'U8', 'U16', 'U32', 'U64', 'S8', 'S16', 'S32', 'S64',
]);

/** True if `word` is a hard-blocked keyword/literal macro. */
export function isHardKeyword(word: string): boolean {
  return C_CPP_KEYWORDS.has(word);
}

/** True if `word` is a soft (firmware/Windows type-macro) keyword. */
export function isSoftKeyword(word: string): boolean {
  return C_CPP_SOFT_KEYWORDS.has(word);
}
