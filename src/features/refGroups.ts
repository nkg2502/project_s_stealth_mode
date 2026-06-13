// Group symbol references by file and render a code-line snippet per occurrence —
// the data shaping behind the Code Insight "References" category, modelled on
// VS Code's "Find All References". Pure (no vscode), so it is headless-testable.

import type { RefHit } from '../store/db';

export interface RefFileGroup {
  file: string;
  refs: RefHit[];
}

/**
 * Group references by their file, sorting groups by path and each group's
 * occurrences by (line, col) so the tree renders in reading order.
 */
export function groupReferencesByFile(refs: RefHit[]): RefFileGroup[] {
  const byFile = new Map<string, RefHit[]>();
  for (const r of refs) {
    const bucket = byFile.get(r.file);
    if (bucket) {
      bucket.push(r);
    } else {
      byFile.set(r.file, [r]);
    }
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, group]) => ({
      file,
      refs: group.sort((a, b) => a.line - b.line || a.col - b.col),
    }));
}

/**
 * The source line at a reference, trimmed for display. Falls back to a `line N`
 * label when the file's contents don't cover the line (e.g. file changed/missing).
 */
export function snippetLabel(lines: string[], ref: { line: number; col: number }): string {
  const text = lines[ref.line];
  const trimmed = text?.trim();
  return trimmed ? trimmed : `line ${ref.line + 1}`;
}
