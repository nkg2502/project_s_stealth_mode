// Pure (vscode-free) resolver for the Code Insight "Symbol" category, sibling to
// typeInfo.ts / callGraph.ts / refGroups.ts. Given the symbol under the cursor it
// returns a rich summary — the humanized kind, the declared type or function
// signature, the storage class, and jump-able definition/declaration locations —
// all as point queries over SQLite. Kept dependency-free so it is headless-testable
// and the vscode-facing RelationsProvider can render the rows without a round-trip.

import { findLocal, refAt } from '../store/db';
import type { openDb, LocalHit, SymbolHit } from '../store/db';
import { resolvedSymbolsAt } from './symbolResolve';
import type { MemberCtx } from './symbolResolve';

type DB = ReturnType<typeof openDb>;

/** One detail line under the "Symbol" category (label · value, optional jump). */
export interface SymbolDetailRow {
  /** Field name shown as the row label (`Kind`, `Type`, `Signature`, …). */
  label: string;
  /** The value displayed next to the label. */
  value: string;
  /** Jump target for location rows (`Defined in` / `Declared in`). */
  file?: string;
  line?: number;
  col?: number;
}

export interface SymbolInfo {
  name: string;
  /** Humanized, deduped kind(s) for the category row description (e.g. `global variable`). */
  kindLabel: string;
  /** Detail rows shown when the "Symbol" category expands. */
  rows: SymbolDetailRow[];
  /** false when the cursor word resolves to no indexed symbol. */
  found: boolean;
}

/** The symbol-under-cursor descriptor (mirrors resolveTypeInfo's input). */
interface SymbolUnderCursor {
  name: string;
  file: string;
  line: number;
  col: number;
  /** Reached via `obj.`/`obj->` — for member-access field narrowing. */
  isMemberAccess?: boolean;
  objectName?: string;
  memberChain?: string[];
  callArity?: number;
}

// Human-readable labels for the internal SymbolKind / LocalRow kind values.
const KIND_LABELS: Record<string, string> = {
  function: 'function',
  prototype: 'function prototype',
  global_variable: 'global variable',
  typedef: 'typedef',
  struct: 'struct',
  union: 'union',
  enum: 'enum',
  enumerator: 'enumerator',
  macro: 'macro',
  label: 'label',
  class: 'class',
  namespace: 'namespace',
  method: 'method',
  field: 'field',
  parameter: 'parameter',
  local_variable: 'local variable',
};

function humanizeKind(k: string): string {
  return KIND_LABELS[k] ?? k.replace(/_/g, ' ');
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function locLabel(d: { file: string; line: number }): string {
  return `${basename(d.file)}:${d.line + 1}`;
}

/** Dedupe locations by file+line+col (a symbol can be reported once per row). */
function dedupeLocs<T extends { file: string; line: number; col: number }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = `${it.file}\0${it.line}\0${it.col}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

const FUNCTION_KINDS: ReadonlySet<string> = new Set(['function', 'prototype', 'method']);

/**
 * A rich summary of the symbol at a position, for the Code Insight "Symbol" row.
 * A parameter/local reads from the `locals` table (scoped to its function); a
 * global/function/field is resolved exactly like F12 (role-filtered, member-narrowed,
 * with the self-guard) so the summary describes the symbol the cursor denotes — not
 * the first same-named symbol in the DB. `found` is false when nothing resolves.
 */
export function resolveSymbolInfo(db: DB, symbol: SymbolUnderCursor): SymbolInfo {
  const { name, file, line, col } = symbol;
  const ref = refAt(db, file, name, line, col);

  // A parameter/local resolves within its enclosing function only.
  if (ref?.isLocal && ref.enclosingFunc) {
    return localInfo(name, findLocal(db, name, file, ref.enclosingFunc));
  }

  // tree-sitter (or grep, role='') : resolve like F12 so the summary reads off the
  // symbol the cursor actually denotes.
  const member: MemberCtx = {
    objectName: symbol.objectName,
    memberChain: symbol.memberChain,
    enclosingFunc: ref?.enclosingFunc ?? null,
    owner: ref?.owner ?? '',
    objChain: ref?.objChain ?? '',
  };
  const hits = resolvedSymbolsAt(
    db,
    name,
    ref?.role ?? '',
    file,
    line,
    member,
    symbol.isMemberAccess ?? false,
    symbol.callArity,
  );
  return symbolHitInfo(name, hits);
}

function notFound(name: string): SymbolInfo {
  return { name, kindLabel: 'not found', rows: [{ label: 'Kind', value: 'not found' }], found: false };
}

function symbolHitInfo(name: string, hits: SymbolHit[]): SymbolInfo {
  if (hits.length === 0) {
    return notFound(name);
  }
  const kindLabel = [...new Set(hits.map((h) => h.kind))].map(humanizeKind).join(', ');
  const rows: SymbolDetailRow[] = [{ label: 'Kind', value: kindLabel }];

  // A function shows its full signature (storage + return type + declarator); a
  // typed variable/field shows its declared type text and storage class instead.
  const fn = hits.find((h) => FUNCTION_KINDS.has(h.kind) && (h.signature || h.returnType));
  if (fn) {
    const sig = [fn.storage, fn.returnType, fn.signature].filter(Boolean).join(' ');
    if (sig) {
      rows.push({ label: 'Signature', value: sig });
    }
  } else {
    // The declared type is shown by the dedicated "Type" category (which also jumps
    // to the type's definition), so it is intentionally NOT repeated here to avoid a
    // duplicate row — only the storage class, which the Type category doesn't cover.
    const stored = hits.find((h) => h.storage);
    if (stored?.storage) {
      rows.push({ label: 'Storage', value: stored.storage });
    }
  }

  for (const d of dedupeLocs(hits.filter((h) => h.isDefinition))) {
    rows.push({ label: 'Defined in', value: locLabel(d), file: d.file, line: d.line, col: d.col });
  }
  for (const d of dedupeLocs(hits.filter((h) => !h.isDefinition))) {
    rows.push({ label: 'Declared in', value: locLabel(d), file: d.file, line: d.line, col: d.col });
  }
  return { name, kindLabel, rows, found: true };
}

function localInfo(name: string, locals: LocalHit[]): SymbolInfo {
  if (locals.length === 0) {
    return notFound(name);
  }
  const kindLabel = [...new Set(locals.map((l) => l.kind))].map(humanizeKind).join(', ');
  const rows: SymbolDetailRow[] = [{ label: 'Kind', value: kindLabel }];
  // The declared type is shown by the dedicated "Type" category (it resolves locals
  // too), so it is not repeated here — avoids the duplicate Type row.
  for (const d of dedupeLocs(locals)) {
    rows.push({ label: 'Declared in', value: locLabel(d), file: d.file, line: d.line, col: d.col });
  }
  return { name, kindLabel, rows, found: true };
}
