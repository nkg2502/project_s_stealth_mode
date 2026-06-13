// Shared contract between the indexer (extract.ts / regexScanner.ts), the
// worker, and the SQLite store. Kept free of any vscode dependency so the
// indexer can be unit-tested headlessly.

export type SymbolKind =
  | 'function' // function definition (has a body)
  | 'prototype' // function declaration / prototype
  | 'global_variable' // global/file-scope variable
  | 'typedef'
  | 'struct'
  | 'union'
  | 'enum'
  | 'enumerator' // enum constant
  | 'macro' // #define
  | 'label' // goto label
  | 'class' // C++
  | 'namespace' // C++
  | 'method' // C++
  | 'field' // struct/union member
  | 'parameter'; // function parameter (scope-local)

/** How a file's rows were produced. */
export type SourceKind = 'ts' | 'grep';

/**
 * Syntactic role of an identifier occurrence, taken straight from the tree-sitter
 * node type. This is the structural fact that lets resolution route a token to
 * the right kind of symbol — a `value` use never resolves to a struct tag, a
 * `type` use never to a variable, a `field` use only to a member. `''` means the
 * role is unknown (grep fallback has no AST), so name-based heuristics apply.
 */
export type RefRole = 'value' | 'type' | 'field' | 'label' | 'namespace';

export type Lang = 'c' | 'cpp';

/** A symbol definition or declaration. Positions are 0-based. */
export interface SymbolRow {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** true = definition, false = declaration/prototype. */
  isDefinition: boolean;
  source: SourceKind;
  /**
   * For a `field`/`member` symbol, the tag of the aggregate that owns it
   * (`struct rcu_state {…}` → `rcu_state`). Lets `obj->field` member access be
   * narrowed to the field of the object's actual type. Empty/undefined otherwise.
   */
  scope?: string;
  /**
   * Declared aggregate tag of the symbol's *own* type (`struct Inner_s rtf` →
   * `Inner_s`, pointer stripped; scalars → undefined). Recorded for `field`
   * symbols (to walk a chain `outer->rtf.x` hop by hop) and for `global_variable`
   * symbols (so a member access through a global object `gObj.x` is type-narrowed
   * like a local). Mirrors `LocalRow.dataType`. Empty/undefined otherwise.
   */
  dataType?: string;
  /**
   * The full declared type *text* of a `global_variable`/`field` for display in
   * the Code Insight "Type" row (`uint32_t`, `struct rcu_state`, `MyNS::Config`;
   * whitespace-collapsed, pointer/qualifiers from the specifier kept, declarator
   * `*` not). Unlike `dataType` (the bare aggregate tag, for narrowing) this keeps
   * primitives and the namespace. Empty/undefined for non-variable symbols.
   */
  declType?: string;
  /**
   * For a `function`/`prototype`/`method`, its signature — the `function_declarator`
   * text, i.e. `name(paramType param, …)` (whitespace-collapsed). Empty otherwise.
   * This is the basis for future arity / parameter-type disambiguation.
   */
  signature?: string;
  /**
   * For a `function`/`prototype`/`method`, the return-type *text* (the type
   * specifier; a pointer/qualifier carried on the declarator is not included).
   * Empty for non-functions.
   */
  returnType?: string;
  /**
   * Storage-class / function specifiers on the declaration (`static`, `extern`,
   * `inline`, `register`, `typedef`, `auto`), space-joined in source order.
   * Captured for functions/prototypes and variables. Empty when none.
   */
  storage?: string;
  /**
   * For a `function`/`prototype`/`method`, the number of fixed parameters
   * (`(void)` → 0). Left `undefined` for a non-function and for an unspecified
   * `()` parameter list (which constrains nothing), so it is never used to exclude.
   */
  arity?: number;
  /**
   * For a `function`/`prototype`/`method`, the per-parameter type list,
   * comma-joined (`int,char`), with a trailing `...` when variadic. The basis for
   * arity / parameter-type disambiguation of same-named functions. Empty otherwise.
   */
  paramTypes?: string;
}

/** An identifier usage (for the "Reference" relation). */
export interface RefRow {
  name: string;
  file: string;
  line: number;
  col: number;
  /** Name of the enclosing function, if known. */
  enclosingFunc: string | null;
  /**
   * true if this occurrence binds to a parameter/local of `enclosingFunc`
   * (tree-sitter only). Such refs are excluded from a *global* symbol's
   * references and only surface when resolving that local within its function.
   */
  isLocal: boolean;
  /**
   * Syntactic role of this occurrence (tree-sitter node type). `''` for grep
   * rows, which have no AST. Drives structural definition routing in resolve.ts.
   */
  role: RefRole | '';
  /**
   * For a `field` occurrence, the tag of the aggregate that owns the field being
   * referenced — the enclosing struct for a declaration (`int head;`), or the
   * resolved type of the object for a use (`obj->head` → type of `obj`). Lets a
   * field's references be narrowed to the field of one struct (not every same-named
   * field). Best-effort, same-file only at extraction; `''`/undefined when unknown
   * (then the ref is never excluded). Empty for non-field occurrences.
   */
  owner?: string;
  /**
   * For a `field` *use* (`obj->head`, `a->b.head`), the object base chain root-first
   * (`['obj']`, `['a','b']`), space-joined. Lets References re-derive the owner from
   * the object's REAL type against the full DB at query time when the index-time
   * (same-file) `owner` came up empty (a cross-file object). Empty otherwise.
   */
  objChain?: string;
  source: SourceKind;
}

/** A call site (callee invoked from caller). Powers "Calls" / "Called by". */
export interface CallRow {
  caller: string | null;
  callee: string;
  file: string;
  line: number;
  col: number;
  source: SourceKind;
}

/**
 * A scope-local declaration (function parameter or local variable). Kept out of
 * the global `symbols` table so it never pollutes fuzzy search or cross-file
 * definition lookups; resolved only within its enclosing function.
 */
export interface LocalRow {
  name: string;
  kind: 'local_variable' | 'parameter';
  file: string;
  /** Enclosing function name (the scope this local belongs to). */
  func: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /**
   * Best-effort declared aggregate tag of this local/parameter, normalized to a
   * bare name (`struct rcu_state *rsp` → `rcu_state`, `rcu_state_t *rsp` →
   * `rcu_state_t`). Drives type-based member narrowing. Empty when not an
   * aggregate-typed declaration.
   */
  dataType?: string;
  /**
   * The full declared type *text* (`uint32_t`, `struct rcu_state`, `MyNS::Config`)
   * for the Code Insight "Type" row — see `SymbolRow.declType`. Empty/undefined
   * when no type specifier was found.
   */
  declType?: string;
}

/**
 * `typedef <named aggregate> Alias;` recorded as `name → target` (`rcu_state_t →
 * rcu_state_s`) so member narrowing can map a typedef'd object type back to the
 * struct tag that owns the field.
 */
export interface TypedefAlias {
  name: string;
  target: string;
}

/** Everything extracted from a single file. */
export interface FileIndex {
  file: string;
  /** Content hash used for incremental invalidation. */
  hash: string;
  parsedBy: SourceKind;
  symbols: SymbolRow[];
  refs: RefRow[];
  calls: CallRow[];
  locals: LocalRow[];
  /** `typedef` aliases of named aggregates (for member narrowing). */
  aliases: TypedefAlias[];
}
