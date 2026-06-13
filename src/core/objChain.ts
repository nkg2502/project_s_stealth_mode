// Object-base chain root markers, shared by the indexer (extract.ts) and the
// query-time resolver (features/symbolResolve.ts) so they agree on one encoding.
//
// A field use's object base is normally a chain of plain names (`a->b.f` →
// `['a','b']`) whose root type comes from a local/param/global declaration. Two
// other bases state (or imply) the root type WITHOUT a name to look up:
//   - a cast `((struct X *)p)->f` — the type is syntactically present.
//   - a call `get_obj()->f`       — the type is the callee's return type.
// We encode these as the chain ROOT using a sigil token that is illegal in a C
// identifier (`@`, `:`) and space-free, so it survives the space-join/split that
// `refs.obj_chain` uses and never collides with a real member name:
//   - `@type:<TAG>`  — the root type is the known aggregate tag `TAG`.
//   - `@call:<name>` — the root type is the return type of the callee `name`.
// Later hops (`get_obj()->a.f` → `['@call:get_obj','a']`) walk normally.

const CAST_PREFIX = '@type:';
const CALL_PREFIX = '@call:';
// An anonymous aggregate (`struct { … } x;`) has no tag, so its field owner and any
// variable's element type both resolved to '' — indistinguishable from a genuinely
// unresolved owner, which the reference filter keeps best-effort. We give it a
// synthetic, deterministic identity from its declaration site instead: the field
// declaration's owner and the variable's element type both derive from the SAME
// struct_specifier node, so they agree, while staying distinct from every named
// aggregate and from a different file/site's anonymous struct. The sigil keeps it
// out of the identifier namespace; it is internal-only and hidden from all display.
const ANON_PREFIX = '@anon:';

/** Synthetic owning-aggregate tag for an anonymous aggregate declared at this site. */
export function anonAggregateTag(file: string, row: number, col: number): string {
  return `${ANON_PREFIX}${file}:${row}:${col}`;
}

/** True for an internal synthetic tag (`@anon:`/`@type:`/`@call:`) — never displayed. */
export function isSyntheticTag(tag: string | undefined): boolean {
  return !!tag && (tag.startsWith(ANON_PREFIX) || tag.startsWith(CAST_PREFIX) || tag.startsWith(CALL_PREFIX));
}

/** A tag safe to show the user: a synthetic sigil tag becomes '' (hidden). */
export function displayTag(tag: string | undefined): string {
  return tag && !isSyntheticTag(tag) ? tag : '';
}

/** The chain-root marker for a cast base whose aggregate tag is `tag`. */
export function castRootMarker(tag: string): string {
  return CAST_PREFIX + tag;
}

/** The chain-root marker for a call base whose callee is named `callee`. */
export function callRootMarker(callee: string): string {
  return CALL_PREFIX + callee;
}

export type RootMarker = { kind: 'type'; value: string } | { kind: 'call'; value: string };

/** Parse a chain element into its root marker, or undefined for a plain name. */
export function parseRootMarker(elem: string): RootMarker | undefined {
  if (elem.startsWith(CAST_PREFIX)) {
    return { kind: 'type', value: elem.slice(CAST_PREFIX.length) };
  }
  if (elem.startsWith(CALL_PREFIX)) {
    return { kind: 'call', value: elem.slice(CALL_PREFIX.length) };
  }
  return undefined;
}

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'void', 'bool', '_Bool', 'char', 'short', 'int', 'long', 'float', 'double',
  'signed', 'unsigned', 'wchar_t', 'char16_t', 'char32_t', 'auto',
]);

/** The last `::`-scoped component of a name (`MyNS::Config` → `Config`). */
function lastScopeComponent(name: string): string {
  const parts = name.split('::');
  return parts[parts.length - 1];
}

/**
 * The aggregate tag named by a type-specifier *text* — the text sibling of
 * extract.ts's Node-based `aggregateTagFromType`, for a return type captured as a
 * string. Strips pointer/reference/cv tokens and template args; an elaborated
 * `struct/union/enum/class X` → `X`; a qualified `A::B::C` → `C`; a template
 * `std::vector<int>` → `vector`; a pure primitive (`int`, `unsigned long`) →
 * undefined (not an aggregate, so never a field owner).
 */
export function aggregateTagFromTypeText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  let s = text.trim();
  if (!s) {
    return undefined;
  }
  // Strip template arguments: `vector<int>` → `vector`, `map<a,b>` → `map`.
  const lt = s.indexOf('<');
  if (lt >= 0) {
    s = s.slice(0, lt);
  }
  // Pointer/reference stars become separators; drop cv-qualifiers.
  s = s.replace(/[*&]/g, ' ');
  const tokens = s.split(/\s+/).filter((t) => t && t !== 'const' && t !== 'volatile');
  if (tokens.length === 0) {
    return undefined;
  }
  // Elaborated `struct/union/enum/class X` → the token after the keyword.
  const TAG_KEYWORDS: ReadonlySet<string> = new Set(['struct', 'union', 'enum', 'class']);
  for (let i = 0; i < tokens.length; i++) {
    if (TAG_KEYWORDS.has(tokens[i])) {
      const next = tokens[i + 1];
      return next ? lastScopeComponent(next) : undefined;
    }
  }
  // Otherwise the rightmost token names the type (a typedef / qualified name); a
  // combination of only primitive keywords (`unsigned int`) is not an aggregate.
  if (tokens.every((t) => PRIMITIVE_TYPES.has(t))) {
    return undefined;
  }
  const last = lastScopeComponent(tokens[tokens.length - 1]);
  return PRIMITIVE_TYPES.has(last) ? undefined : last;
}
