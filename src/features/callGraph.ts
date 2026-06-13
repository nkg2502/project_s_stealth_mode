// Recursive call-graph traversal for the Relations view's "Calls" / "Called by"
// trees. Pure (no vscode dependency) so it is headless-testable: it only reads
// the call edges via the store's findCallees / findCallers point queries.
//
// Each level is computed lazily (one query per expanded node). A node is a
// terminal (non-expandable) leaf when its function name already appears among
// its ancestors — that's a cycle (e.g. direct or mutual recursion) — or when it
// is the synthetic "file scope" caller, which has no function to recurse into.

import { findCallees, findCallers } from '../store/db';
import type { CallHit, openDb } from '../store/db';

type DB = ReturnType<typeof openDb>;

export type CallDirection = 'callees' | 'callers';

/** Synthetic name for a call made at file scope (no enclosing function). */
export const FILE_SCOPE = '(file scope)';

export interface CallTreeNode {
  /** The function this node represents. */
  name: string;
  /** Call-site location to navigate to (where the edge occurs). */
  file: string;
  line: number;
  col: number;
  /** Function names from the root down to (and including) this node's parent. */
  ancestors: string[];
  /** A terminal leaf: a cycle back to an ancestor, or the file-scope caller. */
  recursive: boolean;
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/** The function name an edge points at, in the chosen direction. */
function nameOf(direction: CallDirection, c: CallHit): string {
  return direction === 'callees' ? c.callee : (c.caller ?? FILE_SCOPE);
}

/** Direct neighbours of `name` (callees or callers), de-duplicated by name. */
function neighbours(db: DB, direction: CallDirection, name: string): CallHit[] {
  const rows = direction === 'callees' ? findCallees(db, name) : findCallers(db, name);
  return dedupeBy(rows, (c) => nameOf(direction, c));
}

/**
 * One level of the recursive call tree: the children of `parent` (a function
 * name) given the `parentAncestors` chain that led to it. Child nodes carry the
 * extended ancestor chain so the next expansion can detect cycles.
 */
export function callChildren(
  db: DB,
  direction: CallDirection,
  parent: string,
  parentAncestors: string[],
): CallTreeNode[] {
  const ancestors = [...parentAncestors, parent];
  return neighbours(db, direction, parent).map((c) => {
    const name = nameOf(direction, c);
    // Terminal when the name loops back to an ancestor (a cycle: direct or
    // mutual recursion) or is the file-scope caller (no function to recurse).
    const recursive = name === FILE_SCOPE || ancestors.includes(name);
    return { name, file: c.file, line: c.line, col: c.col, ancestors, recursive };
  });
}

/** Whether `name` has any neighbours in this direction (decides expandability). */
export function hasCallChildren(db: DB, direction: CallDirection, name: string): boolean {
  return neighbours(db, direction, name).length > 0;
}

/**
 * Top-level call-tree children for a Code Insight symbol, scope-aware. A
 * scope-local (parameter / function-body variable) is **not** a function and
 * must never adopt the global call edges of a same-named function — the call
 * graph is keyed by bare name only, so a local `u64 bitmap;` would otherwise list
 * the callers/callees of an unrelated global `bitmap(...)`. A local therefore has
 * no call relations; everything else resolves through the global call graph.
 */
export function callRelations(
  db: DB,
  direction: CallDirection,
  name: string,
  isLocal: boolean,
): CallTreeNode[] {
  if (isLocal) {
    return [];
  }
  return callChildren(db, direction, name, []);
}
