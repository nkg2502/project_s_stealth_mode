// Pure (vscode-free) typedef-alias chain walking, shared by member-narrowing
// (features/resolve.ts) and the Code Insight "Type" row (features/typeInfo.ts).
// Both need to map a declared type name to the aggregate tag(s) it ultimately
// denotes — following `typedef` aliases transitively — so the logic lives here
// once rather than being duplicated or pulling vscode in through resolve.ts.

import { findTypedefTarget } from '../store/db';
import type { openDb } from '../store/db';

type DB = ReturnType<typeof openDb>;

/** `_t` aggregate-tag suffix variants for a typedef name (`Foo_t` → Foo_s/_e/_u/Foo). */
export function suffixTags(typeName: string): string[] {
  const m = /^(.*)_([a-z])$/.exec(typeName);
  if (!m) {
    return [];
  }
  const base = m[1];
  return [`${base}_s`, `${base}_e`, `${base}_u`, base];
}

/**
 * Candidate owning tags for a declared type name, in priority order: the name
 * itself, then each typedef-alias hop walked transitively (`A2_t → A_t → A_s`,
 * cycle-guarded), then the `_t`→`_s/_e/_u` suffix variants of every hop as a last
 * resort. Lets a chain of typedefs resolve to the struct that actually owns the
 * field (member narrowing) or backs the type (the Type row's jump target).
 */
export function candidateTags(db: DB, typeName: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  let name: string | undefined = typeName;
  while (name && !seen.has(name)) {
    seen.add(name);
    tags.push(name);
    name = findTypedefTarget(db, name);
  }
  for (const hop of [...tags]) {
    for (const cand of suffixTags(hop)) {
      if (!seen.has(cand)) {
        seen.add(cand);
        tags.push(cand);
      }
    }
  }
  return tags;
}
