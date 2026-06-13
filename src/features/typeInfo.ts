// Pure (vscode-free) resolver for the Code Insight "Type" row, sibling to
// callGraph.ts / refGroups.ts. Given the symbol under the cursor it returns the
// declared type to display plus jump targets (the named aggregate's definition),
// all as point queries over SQLite. Kept dependency-free so it is headless-testable
// and the vscode-facing RelationsProvider can render it without a round-trip.

import { findDefinitions, findLocal, findSymbols, refAt } from '../store/db';
import type { openDb, SymbolHit } from '../store/db';
import type { SymbolKind } from '../core/types';
import { candidateTags } from './typeChain';
import { definitionsAt } from './symbolResolve';
import type { MemberCtx } from './symbolResolve';
import { isSyntheticTag } from '../core/objChain';

type DB = ReturnType<typeof openDb>;

// What a declared type can resolve to (so the "Type" row jumps to the type, not a
// same-named value). `macro` is omitted: a macro is never the declared type here.
const TYPE_DEF_KINDS: readonly SymbolKind[] = ['struct', 'union', 'enum', 'class', 'typedef'];
// The concrete aggregate kinds — preferred over a `typedef` so the jump lands on
// the struct that actually defines the fields, not the alias name.
const AGGREGATE_KINDS: ReadonlySet<string> = new Set(['struct', 'union', 'enum', 'class']);

export interface TypeDef {
  file: string;
  line: number;
  col: number;
  kind: string;
  name: string;
}

export interface TypeInfo {
  /** Declared type text to display (`struct rcu_state`, `uint32_t`, `MyNS::Config`). */
  text: string;
  /** Bare aggregate tag of the type (`''` for a primitive) — what `defs` resolved from. */
  tag: string;
  /** Definition(s) of the named aggregate to jump to (struct/typedef/class/union/enum). */
  defs: TypeDef[];
}

/**
 * The declared type of the symbol at a position, for the Code Insight "Type" row.
 * A parameter/local reads from the `locals` table (scoped to its function); for a
 * global variable / field the type is read off the SAME symbol F12 resolves to —
 * role-filtered, member-narrowed (`definitionsAt`), with the self-guard — NOT the
 * first same-named symbol in the DB (a bare name match leaked the type of an
 * unrelated `data2` field/global into the row). The display `text` is the full
 * declared type (`declType`); `defs` resolves the bare aggregate `tag` to the
 * type's definition(s). Returns undefined when the symbol carries no declared type
 * (not a typed variable/field), so the caller hides the row.
 */
export function resolveTypeInfo(
  db: DB,
  symbol: {
    name: string;
    file: string;
    line: number;
    col: number;
    /** Reached via `obj.`/`obj->` — for member-access field narrowing. */
    isMemberAccess?: boolean;
    objectName?: string;
    memberChain?: string[];
    callArity?: number;
  },
): TypeInfo | undefined {
  const { name, file, line, col } = symbol;
  const ref = refAt(db, file, name, line, col);

  let declType = '';
  let tag = '';
  if (ref?.isLocal && ref.enclosingFunc) {
    const l = findLocal(db, name, file, ref.enclosingFunc).find((x) => x.declType || x.dataType);
    declType = l?.declType ?? '';
    tag = l?.dataType ?? '';
  } else if (ref) {
    // tree-sitter: resolve like F12 (role + member narrowing) so the Type row reads
    // the type off the symbol the cursor actually denotes. The self-guard prefers a
    // declaration under the cursor over a same-named one elsewhere.
    const member: MemberCtx = {
      objectName: symbol.objectName,
      memberChain: symbol.memberChain,
      enclosingFunc: ref.enclosingFunc,
      owner: ref.owner,
      objChain: ref.objChain,
    };
    const defs = definitionsAt(db, name, ref.role, file, member, symbol.isMemberAccess ?? false, symbol.callArity);
    const here = defs.filter((d) => d.file === file && d.line === line);
    const s = (here.length ? here : defs).find((x) => x.declType || x.dataType);
    declType = s?.declType ?? '';
    tag = s?.dataType ?? '';
  } else {
    // Grep fallback / no recorded ref — no AST role, so best-effort name match.
    const s = findSymbols(db, name).find(
      (x) => (x.kind === 'global_variable' || x.kind === 'field') && (x.declType || x.dataType),
    );
    declType = s?.declType ?? '';
    tag = s?.dataType ?? '';
  }

  // A synthetic anonymous-aggregate tag (`@anon:…`) is internal: it never names a
  // jump target and must not be shown, so drop it from `tag` (no defs) and fall back
  // to the raw `declType` text (`struct { … }`) for display.
  if (isSyntheticTag(tag)) {
    tag = '';
  }
  if (!declType && !tag) {
    return undefined; // not a typed variable/field — no Type row
  }
  return { text: declType || tag, tag, defs: tag ? resolveTypeDefs(db, tag) : [] };
}

/**
 * The definition(s) the declared type `tag` denotes, following typedef aliases to
 * the underlying aggregate: walk `candidateTags` (`A2_t → A_t → A_s`, cycle-guarded
 * + `_t` suffix) and return the first hop that has a concrete struct/union/enum/
 * class definition — so the Type row jumps to the actual struct, not the alias. If
 * no aggregate is reachable (a scalar typedef, an opaque/forward type), fall back
 * to the typedef definition(s) seen along the way so there is still a jump target.
 */
function resolveTypeDefs(db: DB, tag: string): TypeDef[] {
  const fallback: TypeDef[] = [];
  for (const cand of candidateTags(db, tag)) {
    const hits = findDefinitions(db, cand, TYPE_DEF_KINDS).map(toTypeDef);
    const aggregates = hits.filter((d) => AGGREGATE_KINDS.has(d.kind));
    if (aggregates.length) {
      return aggregates;
    }
    fallback.push(...hits);
  }
  return fallback;
}

function toTypeDef(h: SymbolHit): TypeDef {
  return { file: h.file, line: h.line, col: h.col, kind: h.kind, name: h.name };
}
