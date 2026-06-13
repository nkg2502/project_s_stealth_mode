// fzf-style fuzzy matcher (modified Smith-Waterman) used to rank the F10 search
// candidates fetched from SQLite (store/db.ts:searchSymbolNames). A pattern
// matches a target when it is a case-insensitive
// subsequence of the target; the score rewards contiguous runs and word-boundary
// / camelCase hits and penalises gaps, so tight prefix/boundary matches naturally
// outrank long scattered ones without any "magic" coverage tiers.
//
//   SCORE_MATCH       = 16 per matched char
//   GAP_START / EXT   = -3 / -1 per gap char
//   bonuses: boundary (8), camelCase/number (7), consecutive (6)
//   the first matched char's boundary bonus is doubled (fzf bonusFirstChar)
//
// Pure (no vscode / no SQLite) so it is headless-testable.

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 6;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

export interface FuzzyMatchResult {
  /** Higher is better. Can be negative for weak (deep / scattered) matches. */
  score: number;
}

function isAlphaNum(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}
function isLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}
function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Word-boundary / camelCase bonus for matching at text position `j`. */
function charBonus(text: string, j: number): number {
  if (j === 0) {
    return BONUS_BOUNDARY;
  }
  const prev = text[j - 1];
  const cur = text[j];
  if (!isAlphaNum(prev)) {
    return BONUS_BOUNDARY; // prev is _, :, ., space, etc.
  }
  if (isLower(prev) && isUpper(cur)) {
    return BONUS_CAMEL;
  }
  if (!isDigit(prev) && isDigit(cur)) {
    return BONUS_CAMEL;
  }
  return 0;
}

function gapPenalty(len: number): number {
  if (len <= 0) {
    return 0;
  }
  return GAP_START + (len - 1) * GAP_EXTENSION;
}

/**
 * Returns a score object if `pattern` is a (case-insensitive) subsequence of
 * `target`, otherwise null. Empty pattern matches everything with score 0.
 */
export function fuzzyMatch(pattern: string, target: string): FuzzyMatchResult | null {
  if (pattern.length === 0) {
    return { score: 0 };
  }
  if (pattern.length > target.length) {
    return null;
  }
  const p = pattern.toLowerCase();
  const t = target.toLowerCase();
  const m = p.length;
  const n = t.length;

  // dp[j] = best score for the current pattern char matched at text index j.
  let prev: number[] = new Array(n).fill(-Infinity);
  // First pattern char.
  let anyFirst = false;
  for (let j = 0; j < n; j++) {
    if (t[j] === p[0]) {
      const bonus = charBonus(target, j) * BONUS_FIRST_CHAR_MULTIPLIER;
      prev[j] = SCORE_MATCH + bonus + gapPenalty(j); // penalise leading offset
      anyFirst = true;
    }
  }
  if (!anyFirst) {
    return null;
  }

  for (let i = 1; i < m; i++) {
    const cur: number[] = new Array(n).fill(-Infinity);
    // bestBelow tracks the best dp[i-1][k] + carried gap penalty for k < j.
    let any = false;
    for (let j = i; j < n; j++) {
      if (t[j] !== p[i]) {
        continue;
      }
      let best = -Infinity;
      for (let k = i - 1; k < j; k++) {
        const fromPrev = prev[k];
        if (fromPrev === -Infinity) {
          continue;
        }
        const consecutive = k === j - 1;
        const bonus = consecutive
          ? Math.max(charBonus(target, j), BONUS_CONSECUTIVE)
          : charBonus(target, j);
        const step = consecutive ? bonus : gapPenalty(j - 1 - k) + bonus;
        const candidate = fromPrev + SCORE_MATCH + step;
        if (candidate > best) {
          best = candidate;
        }
      }
      if (best > -Infinity) {
        cur[j] = best;
        any = true;
      }
    }
    if (!any) {
      return null;
    }
    prev = cur;
  }

  let score = -Infinity;
  for (let j = 0; j < n; j++) {
    if (prev[j] > score) {
      score = prev[j];
    }
  }
  if (score === -Infinity) {
    return null;
  }
  return { score };
}

export interface FuzzyHit<T> {
  item: T;
  score: number;
}

/**
 * Score every item by `fuzzyMatch(pattern, item.name)`, drop non-matches, and
 * sort by score (desc), breaking ties by shorter name first. An empty pattern
 * returns no results (the picker shows nothing until you type).
 */
export function fuzzyFilterSymbols<T extends { name: string }>(
  items: readonly T[],
  pattern: string,
  maxResults?: number,
): FuzzyHit<T>[] {
  if (!pattern) {
    return [];
  }
  const hits: FuzzyHit<T>[] = [];
  for (const item of items) {
    const r = fuzzyMatch(pattern, item.name);
    if (r) {
      hits.push({ item, score: r.score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);
  if (maxResults !== undefined && maxResults >= 0) {
    return hits.slice(0, maxResults);
  }
  return hits;
}
