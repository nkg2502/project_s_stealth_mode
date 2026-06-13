// Pure, vscode-free incremental index planning. Given the set of files that
// currently pass include/exclude and the previously-indexed file metadata
// (mtime + content hash), decide which files to (re)index and which to drop.
// Extracted from extension.ts so the incremental decision is headless-testable.
//
// This is what makes an include/exclude change incremental: a newly-admitted
// file (e.g. after removing an exclude pattern) is absent from `prev`, so it is
// (re)indexed; a newly-excluded or deleted file is in `prev` but no longer in
// the current set, so it is removed. Files that are unchanged — same mtime, or
// the same content hash when hash verification is enabled — are skipped.

export interface PrevFileMeta {
  mtime: number;
  hash: string;
}

export interface IndexPlan {
  /** Files to parse + write (new, or changed since the last index). */
  toIndex: string[];
  /** Previously-indexed paths no longer in the current set (drop their rows). */
  toRemove: string[];
  /** Count of current files skipped as unchanged (for the scan log line). */
  unchanged: number;
}

export interface IndexPlanOptions {
  /** Re-index every current file regardless of prior state (a full rescan). */
  forceAll?: boolean;
  /**
   * Optional content-hash probe. When provided, a file whose mtime moved is
   * re-hashed; if the hash matches the stored one the file is treated as
   * unchanged (skips a needless re-parse of a touched-but-identical file, e.g.
   * after a `git checkout`). Return null/undefined when the file can't be read
   * (it is then treated as changed and re-indexed).
   */
  hashOf?: (file: string) => string | null | undefined;
}

/**
 * Compute the incremental plan. `currentFiles` is the post-include/exclude set;
 * `prev` is the DB's per-file meta; `mtimeOf` reads a file's current mtime.
 */
export function computeIndexPlan(
  currentFiles: Iterable<string>,
  prev: ReadonlyMap<string, PrevFileMeta>,
  mtimeOf: (file: string) => number,
  options: IndexPlanOptions = {},
): IndexPlan {
  const { forceAll = false, hashOf } = options;
  const toIndex: string[] = [];
  const currentSet = new Set<string>();
  let unchanged = 0;

  for (const file of currentFiles) {
    currentSet.add(file);
    const prior = prev.get(file);
    if (forceAll || !prior) {
      toIndex.push(file); // a full rescan, or a file we've never indexed
      continue;
    }
    if (prior.mtime === mtimeOf(file)) {
      unchanged++; // untouched since last index
      continue;
    }
    // mtime moved — confirm an actual content change before paying for a parse.
    if (hashOf) {
      const h = hashOf(file);
      if (h != null && h === prior.hash) {
        unchanged++;
        continue;
      }
    }
    toIndex.push(file);
  }

  const toRemove: string[] = [];
  for (const path of prev.keys()) {
    if (!currentSet.has(path)) {
      toRemove.push(path); // excluded since last index, or deleted on disk
    }
  }

  return { toIndex, toRemove, unchanged };
}
