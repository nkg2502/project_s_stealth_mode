// Structural token-role resolution, the principled core of Go-to-Definition.
//
// tree-sitter already tells us what each identifier *is* by its node type — a
// value (`identifier`), a type name (`type_identifier`), a struct member
// (`field_identifier`), a goto label (`statement_identifier`), or a C++
// namespace (`namespace_identifier`). Persisting that role on every ref lets
// resolution route a token to only the symbol kinds it can legitimately denote,
// instead of guessing from surrounding cursor text. This is what makes
// `struct folio *folio` resolve correctly at any scope: the first `folio` is a
// `type` token (→ the struct), the second is a `value` token (→ the variable),
// independent of whether a same-named local happens to exist.
//
// Dependency-free (only the SymbolKind type) so the indexer/store tests exercise
// it headlessly.

import type { RefRole, SymbolKind } from './types';

/** Map a tree-sitter identifier node type to its resolution role. */
export function roleForNodeType(nodeType: string): RefRole {
  switch (nodeType) {
    case 'type_identifier':
      return 'type';
    case 'field_identifier':
      return 'field';
    case 'statement_identifier':
      return 'label';
    case 'namespace_identifier':
      return 'namespace';
    case 'identifier':
    default:
      return 'value';
  }
}

// The symbol kinds each role can legitimately resolve to. A `macro` can stand
// for anything (the preprocessor erases roles), so it is admissible under every
// role — we never want a macro definition hidden by role filtering.
const ROLE_KINDS: Record<RefRole, ReadonlySet<SymbolKind>> = {
  value: new Set<SymbolKind>([
    'function',
    'prototype',
    'global_variable',
    'enumerator',
    'method',
    'macro',
  ]),
  type: new Set<SymbolKind>(['struct', 'union', 'enum', 'class', 'typedef', 'macro']),
  field: new Set<SymbolKind>(['field', 'macro']),
  label: new Set<SymbolKind>(['label']),
  namespace: new Set<SymbolKind>(['namespace', 'class', 'macro']),
};

const ROLES: ReadonlySet<string> = new Set(Object.keys(ROLE_KINDS));

/** A known structural role (not the grep `''` sentinel / undefined). */
export function isRefRole(role: string | undefined | null): role is RefRole {
  return role != null && ROLES.has(role);
}

/** Symbol kinds admissible for a role (empty for an unknown role). */
export function kindsForRole(role: string | undefined | null): SymbolKind[] {
  return isRefRole(role) ? [...ROLE_KINDS[role]] : [];
}

/**
 * Keep only the hits whose kind the role admits. Used to filter an already-fetched
 * list (the role's `kindsForRole` is also pushed down into the SQL `kinds` filter
 * where possible). Unknown role → unchanged.
 */
export function narrowByRole<T extends { kind: SymbolKind }>(hits: T[], role: string | undefined | null): T[] {
  if (!isRefRole(role)) {
    return hits;
  }
  const allowed = ROLE_KINDS[role];
  return hits.filter((h) => allowed.has(h.kind));
}
