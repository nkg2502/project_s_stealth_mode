// C and C++ reserved keywords. Used to suppress Relations-view lookups and
// indexing for language keywords (they are never user-defined symbols).

const C_KEYWORDS = [
  // C89/C90
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if',
  'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static',
  'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  // C99
  'inline', 'restrict', '_Bool', '_Complex', '_Imaginary',
  // C11
  '_Alignas', '_Alignof', '_Atomic', '_Generic', '_Noreturn', '_Static_assert', '_Thread_local',
  // C23
  'alignas', 'alignof', 'bool', 'constexpr', 'false', 'nullptr', 'static_assert',
  'thread_local', 'true', 'typeof', 'typeof_unqual', '_BitInt',
  '_Decimal32', '_Decimal64', '_Decimal128',
] as const;

const CPP_KEYWORDS = [
  // C++ additions (beyond what C already defines)
  'and', 'and_eq', 'asm', 'bitand', 'bitor',
  'catch', 'char8_t', 'char16_t', 'char32_t', 'class', 'compl', 'concept',
  'consteval', 'constinit', 'const_cast', 'co_await', 'co_return', 'co_yield',
  'decltype', 'delete', 'dynamic_cast', 'explicit', 'export',
  'friend', 'mutable', 'namespace', 'new', 'noexcept',
  'not', 'not_eq', 'operator', 'or', 'or_eq',
  'private', 'protected', 'public',
  'reinterpret_cast', 'requires',
  'static_cast', 'template', 'this', 'throw', 'try',
  'typeid', 'typename', 'using', 'virtual', 'wchar_t',
  'xor', 'xor_eq',
] as const;

/**
 * Combined set of all C and C++ reserved keywords. This is the BASE set; the
 * navigation/indexing layer extends it with standard literal macros (NULL/TRUE/
 * FALSE/EOF) and std types in `defaults.ts` (`isHardKeyword`) — use that for
 * "treat as a keyword" decisions, not this raw set.
 */
export const C_CPP_KEYWORDS: ReadonlySet<string> = new Set<string>([
  ...C_KEYWORDS,
  ...CPP_KEYWORDS,
]);
