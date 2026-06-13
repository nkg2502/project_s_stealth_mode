import * as vscode from 'vscode';
import type { Host } from '../core/host';
import { findDeclarations, findDefinitions, findLocal, refAt } from '../store/db';
import type { openDb } from '../store/db';
import { narrowCallTarget } from './callContext';
import { tagKindBefore } from './typeTag';
import type { RefRole } from '../core/types';
import { isRefRole } from '../core/refRole';
import type { DocumentLike, PositionLike } from './memberAccess';
import { narrowByMemberAccess, symbolContextAt } from './memberAccess';
import { declarationsAt, definitionsAt, referencesAt, scopeAt, toHit } from './symbolResolve';
import type { DefHit, MemberCtx } from './symbolResolve';

// The pure, vscode-free resolution helpers (scopeAt / definitionsAt /
// declarationsAt / referencesAt and their narrowing) now live in
// `symbolResolve.ts` so headless / vscode-free consumers (typeInfo.ts) can reuse
// the *exact* resolution F12 uses. They are re-exported here so existing importers
// (relationsView, the providers, tests) keep their `./resolve` import path.
export { declarationsAt, definitionsAt, referencesAt, resolvedSymbolsAt, scopeAt } from './symbolResolve';
export type { DefHit, MemberCtx, Scope } from './symbolResolve';

type DB = ReturnType<typeof openDb>;

/**
 * Briefly wait out an in-flight reindex so a query reads fresh results, bounded
 * by `cBlitz.indexing.deferQueriesMs` (0 disables). Resolves immediately when
 * nothing is indexing, so there's no latency in the common case.
 */
export function awaitFreshIndex(host: Host): Promise<void> {
  const ms = vscode.workspace.getConfiguration('cBlitz').get<number>('indexing.deferQueriesMs', 1500);
  return host.indexing.whenIdle(ms);
}

// Shared Go-to-Definition resolution for both the dedicated command and the
// DefinitionProvider. Scope first: if the word is a parameter / local variable
// of the function the cursor sits in, resolve to that declaration. Otherwise
// fall back to the global index (definitions, then declarations — which now
// include struct/union fields).

export interface Resolved {
  word: string;
  hits: DefHit[];
  /**
   * No hits, but the cursor sits on an undefined ALL_CAPS macro in a `#if`
   * guard — a config macro simply not defined in this build. We deliberately
   * *block* a jump (the provider returns `[]`) instead of abstaining (`null`),
   * so nothing navigates to an unrelated same-named symbol elsewhere.
   */
  blocked?: boolean;
}

/** Undefined ALL_CAPS macro on a preprocessor guard line — block the jump. */
function isMacroGuardBlock(lineText: string, word: string): boolean {
  return (
    /^\s*#\s*(ifdef|ifndef|if|elif|undef|define)\b/.test(lineText) &&
    /^[A-Z][A-Z0-9_]+$/.test(word)
  );
}

export function resolveDefinition(
  db: DB | undefined,
  document: DocumentLike,
  position: PositionLike,
): Resolved | undefined {
  // Cursor context: word (empty for a hard keyword), member access, scope.
  const ctx = symbolContextAt(document, position);
  if (!ctx.word || !ctx.range) {
    return undefined; // keyword / no word — abstain
  }
  const word = ctx.word;
  if (!db) {
    return { word, hits: [] };
  }
  const file = document.uri.fsPath;
  const startLine = ctx.range.start.line;
  const startCol = ctx.range.start.character;
  const lineText = document.lineAt(startLine).text;
  const before = lineText.slice(0, startCol);
  const after = document.lineAt(ctx.range.end.line).text.slice(ctx.range.end.character);

  const ref = refAt(db, file, word, startLine, startCol);

  // 1) scope-local: a *value* occurrence bound to a parameter/local of its
  // function. The is_local flag is itself role-derived (only a value token can
  // bind to a local), so a same-named type tag / field on the same line is never
  // hijacked by the local — that distinction is the whole point.
  if (ref?.enclosingFunc && ref.isLocal) {
    const locals = findLocal(db, word, file, ref.enclosingFunc);
    if (locals.length) {
      return {
        word,
        hits: locals.map((l) => ({ file: l.file, line: l.line, col: l.col, kind: l.kind, name: word })),
      };
    }
  }

  // 2) global resolution. With a known token role (tree-sitter), route purely by
  // STRUCTURE — a value never resolves to a type tag/field, a type only to a tag,
  // a field only to a member. This subsumes the call-target / member-access /
  // type-keyword text heuristics, which are kept only for the grep fallback where
  // there is no AST role.
  const role = ref?.role;
  const member: MemberCtx = {
    objectName: ctx.objectName,
    memberChain: ctx.memberChain,
    enclosingFunc: ref?.enclosingFunc ?? null,
    owner: ref?.owner,
    objChain: ref?.objChain,
  };
  // Structural routing applies only to a real AST role from tree-sitter. A grep row
  // may now carry role='field' (its member-access heuristic), but grep has no AST —
  // keep it on the text-heuristic path so grep Go-to-Definition is unchanged.
  const hits = ref?.source !== 'grep' && isRefRole(role)
    ? resolveByRole(db, word, role, file, startLine, member, ctx.callArity)
    : resolveByText(db, word, before, after, ctx.isMemberAccess, file, startLine);

  if (hits.length === 0) {
    return { word, hits: [], blocked: isMacroGuardBlock(lineText, word) };
  }
  return { word, hits };
}

/**
 * Structural resolution: restrict to the symbol kinds the token's role admits
 * (pushed into the SQL `kinds` filter), preferring definitions, then a same-line
 * self declaration, then declarations. For a `field` role reached via `obj->`,
 * the candidates are further narrowed to the field owned by `obj`'s actual type.
 */
function resolveByRole(
  db: DB,
  word: string,
  role: RefRole,
  file: string,
  startLine: number,
  member: MemberCtx,
  callArity?: number,
): DefHit[] {
  const selfAt = (rows: { file: string; line: number }[]): boolean =>
    rows.some((h) => h.file === file && h.line === startLine);

  const defs = definitionsAt(db, word, role, file, member, false, callArity);
  if (selfAt(defs)) {
    return defs.filter((h) => h.file === file && h.line === startLine).map(toHit);
  }
  if (defs.length > 0) {
    return defs.map(toHit);
  }
  const decls = declarationsAt(db, word, role, file, member, false, callArity);
  if (selfAt(decls)) {
    return decls.filter((h) => h.file === file && h.line === startLine).map(toHit);
  }
  return decls.map(toHit);
}

/**
 * Name-based fallback for grep rows / positions with no recorded role: the
 * elaborated type-tag keyword, then global defs/decls narrowed by the
 * call-target and member-access cursor-text heuristics, with the self-guard.
 */
function resolveByText(
  db: DB,
  word: string,
  before: string,
  after: string,
  isMemberAccess: boolean | undefined,
  file: string,
  startLine: number,
): DefHit[] {
  const tagKinds = tagKindBefore(before);
  if (tagKinds) {
    let tagHits = findDefinitions(db, word, tagKinds);
    if (tagHits.length === 0) {
      tagHits = findDeclarations(db, word, tagKinds);
    }
    return tagHits.map(toHit);
  }

  let pool = findDefinitions(db, word);
  let triedDecls = false;
  if (pool.length === 0) {
    pool = findDeclarations(db, word);
    triedDecls = true;
  }
  const self = pool.filter((h) => h.file === file && h.line === startLine);
  if (self.length) {
    return self.map(toHit);
  }
  let hits = narrowByMemberAccess(narrowCallTarget(pool, before, after), isMemberAccess);
  if (hits.length === 0 && !triedDecls) {
    const decls = findDeclarations(db, word);
    const selfDecl = decls.filter((h) => h.file === file && h.line === startLine);
    if (selfDecl.length) {
      return selfDecl.map(toHit);
    }
    hits = narrowByMemberAccess(narrowCallTarget(decls, before, after), isMemberAccess);
  }
  return hits.map(toHit);
}

/** Resolve all references of the symbol at a position, scope-aware + owner-narrowed. */
export function resolveReferences(
  host: Host,
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.Location[] {
  const ctx = symbolContextAt(document, position);
  if (!ctx.word || !ctx.range) {
    return [];
  }
  const db = host.getDb();
  if (!db) {
    return [];
  }
  const file = document.uri.fsPath;
  const { func, isLocal, role, owner, objChain } = scopeAt(db, file, ctx.word, ctx.range.start.line, ctx.range.start.character);
  const member: MemberCtx = { objectName: ctx.objectName, memberChain: ctx.memberChain, enclosingFunc: func, owner, objChain };
  const hits = referencesAt(db, ctx.word, role, file, member, isLocal, func);
  return hits.map(
    (h) => new vscode.Location(vscode.Uri.file(h.file), new vscode.Position(h.line, Math.max(0, h.col))),
  );
}
