// Pure (vscode-free) symbol-resolution helpers shared by the F12 command
// (features/resolve.ts), the Code Insight view (relationsView.ts), and the
// "Type" row resolver (typeInfo.ts). Kept dependency-free of vscode so it is
// headless-testable and so vscode-free consumers (typeInfo.ts) can reuse the
// *exact* resolution F12 uses instead of re-deriving a parallel, name-only path.

import {
  findDeclarations,
  findDefinitions,
  findLocal,
  findLocalReferences,
  findReferences,
  refAt,
} from '../store/db';
import type { openDb, RefHit, SymbolHit } from '../store/db';
import { candidateTags } from './typeChain';
import { narrowByMemberAccess } from './memberAccess';
import type { RefRole } from '../core/types';
import { isRefRole, kindsForRole } from '../core/refRole';
import { aggregateTagFromTypeText, parseRootMarker } from '../core/objChain';

type DB = ReturnType<typeof openDb>;

export interface Scope {
  /** Enclosing function at the cursor (null at file scope). */
  func: string | null;
  /** The word binds to a parameter/local of `func`. */
  isLocal: boolean;
  /** Syntactic role of the cursor occurrence (`''` for grep rows / no ref). */
  role: RefRole | '';
  /**
   * Owning aggregate of the cursor occurrence when it is a `field` token — set by
   * the indexer for BOTH a field declaration (the enclosing struct) and a resolved
   * `obj->field` use (the object's type). `''` when unknown / not a field.
   */
  owner: string;
  /**
   * Object base chain of the cursor `field` use (space-joined, root-first; may carry
   * a `@type:`/`@call:` marker root) — the AST-accurate counterpart of the text
   * `memberChain`, used to narrow a use the index-time `owner` left unresolved (a
   * cross-file call/global). `''` for a declaration / non-field / grep row.
   */
  objChain: string;
}

export interface DefHit {
  file: string;
  line: number;
  col: number;
  kind: string;
  name: string;
}

/** Member-access context for `obj->field` (and chain `a->b.field`) type narrowing. */
export interface MemberCtx {
  objectName?: string;
  /** Full base chain root-first (`outer->rtf.field` → `['outer','rtf']`). */
  memberChain?: string[];
  enclosingFunc: string | null;
  /**
   * Authoritative owning aggregate of the cursor `field` token (from the ref row,
   * via the indexer). When set, field resolution narrows directly to this struct —
   * which is what makes a field DECLARATION cursor (no member access, no enclosing
   * function) narrow correctly. `narrowFieldsByType` (member-chain walk) is the
   * fallback when this is absent (e.g. a cross-file use the indexer couldn't type).
   */
  owner?: string;
  /**
   * The cursor field use's AST object chain (space-joined, with `@type:`/`@call:`
   * marker roots) from the ref row. Preferred over the text `memberChain` when set —
   * it resolves cast/call bases and cross-file roots the text parser can't. The text
   * fallback path remains for grep rows (no AST chain).
   */
  objChain?: string;
}

export const toHit = (h: { file: string; line: number; col: number; kind: string; name: string }): DefHit => ({
  file: h.file,
  line: h.line,
  col: h.col,
  kind: h.kind,
  name: h.name,
});

/**
 * Decide whether the word at a position is a scope-local or a global symbol.
 * Keyed on the `is_local` flag of the *ref occurrence at the cursor* (not merely
 * "a local of this name exists in the function") — so on
 * `struct folio *folio = …` the type tag `folio` (is_local=0) is treated as
 * global while the variable `folio` (is_local=1) binds to the local.
 */
export function scopeAt(db: DB, file: string, word: string, line: number, col: number): Scope {
  const ref = refAt(db, file, word, line, col);
  return {
    func: ref?.enclosingFunc ?? null,
    isLocal: ref?.isLocal ?? false,
    role: ref?.role ?? '',
    owner: ref?.owner ?? '',
    objChain: ref?.objChain ?? '',
  };
}

/**
 * Role-filtered, member-narrowed DEFINITIONS for a symbol occurrence — the exact
 * resolution F12 uses, exposed for the Code Insight "Definition"/"Type" rows so they
 * resolve structurally (a `field` use lists only members, never a same-named goto
 * label, and `obj->head` is narrowed to the field of `obj`'s actual type) instead of
 * by bare name. `declarationsAt` is the same over the declaration set. For an unknown
 * role (grep rows) the role filter is a no-op; a member access still drops
 * structurally-impossible kinds.
 */
export function definitionsAt(
  db: DB,
  name: string,
  role: RefRole | '',
  file: string,
  member: MemberCtx,
  isMemberAccess = false,
  callArity?: number,
): SymbolHit[] {
  const hits = narrowForMember(db, findDefinitions(db, name, kindsForRole(role)), role, member, file, isMemberAccess);
  return narrowByArity(hits, callArity);
}

export function declarationsAt(
  db: DB,
  name: string,
  role: RefRole | '',
  file: string,
  member: MemberCtx,
  isMemberAccess = false,
  callArity?: number,
): SymbolHit[] {
  const hits = narrowForMember(db, findDeclarations(db, name, kindsForRole(role)), role, member, file, isMemberAccess);
  return narrowByArity(hits, callArity);
}

/**
 * The symbol(s) the cursor denotes — definitions AND declarations together,
 * resolved like F12 (role-filtered, member-narrowed, with the self-guard) — for
 * the Code Insight header's kind list + function signature. NOT a bare name match:
 * a `field` token lists only the field under the cursor (this struct), never a
 * same-named global / label / a different struct's field. The self-guard prefers a
 * def/decl at the cursor's own file+line; otherwise the role/member-narrowed set
 * (e.g. a call site denotes the function defined elsewhere).
 */
export function resolvedSymbolsAt(
  db: DB,
  name: string,
  role: RefRole | '',
  file: string,
  line: number,
  member: MemberCtx,
  isMemberAccess = false,
  callArity?: number,
): SymbolHit[] {
  const all = [
    ...definitionsAt(db, name, role, file, member, isMemberAccess, callArity),
    ...declarationsAt(db, name, role, file, member, isMemberAccess, callArity),
  ];
  const here = all.filter((h) => h.file === file && h.line === line);
  return here.length ? here : all;
}

/**
 * Narrow already-kind-filtered hits by member access: a `field` use is narrowed to
 * the field owned by the object's actual type (`narrowFieldsByType`); a member
 * access with no AST role (grep) keeps only member kinds (`narrowByMemberAccess`).
 */
function narrowForMember(
  db: DB,
  hits: SymbolHit[],
  role: RefRole | '',
  member: MemberCtx,
  file: string,
  isMemberAccess: boolean,
): SymbolHit[] {
  if (role === 'field') {
    // The cursor ref's own owning aggregate (a field declaration, or a resolved
    // `obj->field` use) is authoritative — it narrows even at a declaration site,
    // where there is no enclosing function / member chain for `narrowFieldsByType`.
    if (member.owner) {
      const owned = fieldsOfType(db, hits, member.owner);
      if (owned.length) {
        return owned;
      }
    }
    return narrowFieldsByType(db, hits, member, file);
  }
  if (!isRefRole(role) && isMemberAccess) {
    return narrowByMemberAccess(hits, true);
  }
  return hits;
}

const FUNCTION_KINDS: ReadonlySet<string> = new Set(['function', 'prototype', 'method']);

/**
 * When the cursor token is a call with `callArity` arguments and several same-named
 * function candidates exist, keep only those whose parameter count matches (a
 * variadic function matches any count ≥ its fixed arity; a candidate with unknown
 * arity — grep rows / unspecified `()` — is never excluded). Non-function hits
 * (e.g. a macro) are preserved. Best-effort: if nothing matches, all are kept.
 */
function narrowByArity(hits: SymbolHit[], callArity?: number): SymbolHit[] {
  if (callArity == null) {
    return hits;
  }
  const fns = hits.filter((h) => FUNCTION_KINDS.has(h.kind));
  if (fns.length <= 1) {
    return hits; // nothing to disambiguate
  }
  const matched = fns.filter((h) => arityMatches(h, callArity));
  if (matched.length === 0 || matched.length === fns.length) {
    return hits; // no signal — keep all
  }
  const others = hits.filter((h) => !FUNCTION_KINDS.has(h.kind));
  return [...matched, ...others];
}

function arityMatches(h: SymbolHit, callArity: number): boolean {
  if (h.arity == null) {
    return true; // unknown arity (grep / unspecified `()`) — never exclude
  }
  return h.paramTypes.endsWith('...') ? callArity >= h.arity : callArity === h.arity;
}

/**
 * Declared aggregate tag of the chain-root object. A parameter/local of `func`
 * wins (it shadows a global); otherwise a file-scope/global variable of that name
 * supplies the type, so `gObj.field` narrows the same way `localObj.field` does.
 */
function objectTypeName(db: DB, objectName: string, file: string, func: string | null): string | undefined {
  const local = func ? findLocal(db, objectName, file, func).find((l) => l.dataType)?.dataType : undefined;
  if (local) {
    return local;
  }
  return findDefinitions(db, objectName, ['global_variable']).find((s) => s.dataType)?.dataType;
}

/**
 * Narrow `obj->field` (or a chain `a->b.field`) candidates — every same-named
 * field across all aggregates — to the field owned by the object's actual type.
 * Walks the member chain hop by hop: the root's type comes from its
 * local/parameter `dataType`; each intermediate field's type comes from that
 * field's own recorded `dataType`. Per hop the tag is matched most-to-least
 * authoritatively (direct tag → typedef alias `Foo_t`→`Foo_s` → `_t`→`_s`/`_e`/`_u`
 * suffix). Best-effort — if any hop can't be resolved (or nothing matches) every
 * candidate is kept, so a valid target is never hidden. (Needs declared types, so
 * tree-sitter path only; the grep fallback uses the kind-based heuristic.)
 */
function narrowFieldsByType(db: DB, fields: SymbolHit[], member: MemberCtx, file: string): SymbolHit[] {
  if (fields.length <= 1) {
    return fields;
  }
  // Prefer the stored AST object chain — it resolves cast/call marker roots and
  // cross-file roots (a global / a call return type in another file) that the text
  // `memberChain` can't, so a cursor on `get_pkt()->data2` or `((struct X*)p)->f`
  // narrows like References does. No enclosing function is required (a marker root /
  // a global needs none). The text path stays as the grep-row / no-AST fallback.
  if (member.objChain) {
    const owner = chainOwner(db, member.objChain, file, member.enclosingFunc ?? null);
    if (!owner) {
      return fields;
    }
    const narrowed = fieldsOfType(db, fields, owner);
    return narrowed.length ? narrowed : fields;
  }
  if (!member.enclosingFunc) {
    return fields;
  }
  const chain = member.memberChain?.length
    ? member.memberChain
    : member.objectName
      ? [member.objectName]
      : [];
  if (!chain.length) {
    return fields;
  }
  const owner = chainOwner(db, chain.join(' '), file, member.enclosingFunc);
  if (!owner) {
    return fields;
  }
  const narrowed = fieldsOfType(db, fields, owner);
  return narrowed.length ? narrowed : fields;
}

/**
 * The owning aggregate tag a space-joined object chain resolves to (root-first), or
 * undefined if any hop breaks. The root is a `@type:`/`@call:` marker or a plain
 * object name (`rootChainType`); each later hop is that field's own declared type
 * (`fieldTypeOf`). Shared by the cursor side (`narrowFieldsByType` /
 * `fieldOwnerTarget`) and the per-ref side (`effectiveRefOwner`) so they agree.
 */
function chainOwner(db: DB, objChain: string, file: string, func: string | null): string | undefined {
  const chain = objChain.split(' ');
  let t = rootChainType(db, chain[0], file, func);
  for (let i = 1; t && i < chain.length; i++) {
    t = fieldTypeOf(db, chain[i], t);
  }
  return t;
}

/** Subset of `fields` owned by `typeName` (direct tag → typedef alias chain → `_t` suffix). */
function fieldsOfType(db: DB, fields: SymbolHit[], typeName: string): SymbolHit[] {
  for (const tag of candidateTags(db, typeName)) {
    const owned = fields.filter((f) => f.scope === tag);
    if (owned.length) {
      return owned;
    }
  }
  return [];
}

/** Declared aggregate type tag of field `fieldName` owned by `ownerType` (next hop). */
function fieldTypeOf(db: DB, fieldName: string, ownerType: string): string | undefined {
  const owned = fieldsOfType(db, findDefinitions(db, fieldName, ['field']), ownerType);
  return owned.find((f) => f.dataType)?.dataType;
}

/**
 * References of the symbol at a position, scope-aware and — for a `field` token —
 * owner-narrowed: when the cursor field resolves to a single owning struct, drop
 * references that belong to a *different* struct's same-named field, so `obj->head`
 * no longer lists every `head` field across the codebase. Refs whose owner is
 * unknown (`''` — cross-file uses, grep rows) are always kept (best-effort, never
 * hides a real reference). Shared by the command, the ReferenceProvider, and the
 * Code Insight References row.
 */
export function referencesAt(
  db: DB,
  name: string,
  role: RefRole | '',
  file: string,
  member: MemberCtx,
  isLocal: boolean,
  func: string | null,
): RefHit[] {
  if (isLocal && func) {
    return findLocalReferences(db, name, file, func);
  }
  const refs = findReferences(db, name, isRefRole(role) ? role : undefined);
  if (role !== 'field') {
    return refs;
  }
  const target = fieldOwnerTarget(db, name, file, member);
  if (!target) {
    return refs; // the field is ambiguous / unresolved — don't risk hiding any
  }
  // Each candidate ref's effective owner: the index-time `owner` when set, else the
  // object's REAL type re-derived from its chain against the FULL DB (so a cross-file
  // object — a global typed in another file, an intermediate field from another header
  // — resolves where the same-file extraction pass couldn't). An owner that still can't
  // be resolved (`''`) is kept (best-effort, never hides a real reference).
  const cache = new Map<string, string>();
  return refs.filter((r) => {
    const owner = effectiveRefOwner(db, r, cache);
    return !owner || ownerMatches(db, owner, target);
  });
}

/**
 * The owning aggregate of a single field-use reference. Fast path: the index-time
 * `owner`. Otherwise walk the stored object chain against the full DB — the root's
 * type from its local/param/global, each hop's type from that field's `dataType` —
 * so a cross-file object resolves. Memoized per (file, enclosing function, chain).
 * Returns `''` when still unresolvable (a complex base, a macro, …).
 */
function effectiveRefOwner(db: DB, r: RefHit, cache: Map<string, string>): string {
  if (r.owner) {
    return r.owner;
  }
  if (!r.objChain) {
    return '';
  }
  const key = `${r.file}\0${r.enclosingFunc ?? ''}\0${r.objChain}`;
  const memo = cache.get(key);
  if (memo !== undefined) {
    return memo;
  }
  const owner = chainOwner(db, r.objChain, r.file, r.enclosingFunc) ?? '';
  cache.set(key, owner);
  return owner;
}

/**
 * The declared aggregate tag of a chain ROOT — a plain object name (via
 * `objectTypeName`), or a sigil marker: `@type:X` carries the tag outright, while
 * `@call:foo` resolves to the return type of a `function`/`prototype` named `foo`
 * anywhere in the DB (a prototype is `is_definition=0`, so query BOTH definitions
 * and declarations and take the first with a return type). Undefined when no
 * candidate has a usable return type.
 */
function rootChainType(db: DB, elem: string, file: string, func: string | null): string | undefined {
  const marker = parseRootMarker(elem);
  if (!marker) {
    return objectTypeName(db, elem, file, func);
  }
  if (marker.kind === 'type') {
    return marker.value;
  }
  const fns = [
    ...findDefinitions(db, marker.value, ['function', 'prototype']),
    ...findDeclarations(db, marker.value, ['function', 'prototype']),
  ];
  return aggregateTagFromTypeText(fns.find((s) => s.returnType)?.returnType);
}

/** The single owning aggregate of the field the cursor resolves to, else undefined. */
function fieldOwnerTarget(db: DB, name: string, file: string, member: MemberCtx): string | undefined {
  // The cursor ref's own owner (declaration site, or a resolved use) is authoritative.
  if (member.owner) {
    return member.owner;
  }
  // The cursor sits on a use the indexer couldn't type same-file (a cross-file
  // call/global) — re-derive its owner from the stored AST chain against the full DB.
  if (member.objChain) {
    const owner = chainOwner(db, member.objChain, file, member.enclosingFunc ?? null);
    if (owner) {
      return owner;
    }
  }
  const scopes = new Set(definitionsAt(db, name, 'field', file, member, true).map((d) => d.scope).filter(Boolean));
  return scopes.size === 1 ? [...scopes][0] : undefined;
}

/** Owner tags match if equal or bridged by a typedef chain (either direction). */
function ownerMatches(db: DB, owner: string, target: string): boolean {
  return (
    owner === target ||
    candidateTags(db, owner).includes(target) ||
    candidateTags(db, target).includes(owner)
  );
}
