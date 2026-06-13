// gitignore-style exclusion matching for the indexer's file walk. Patterns are
// glob expressions (`*` does not cross `/`, `**` does, `?` is one non-`/` char);
// `.gitignore` files are parsed into ordered rules where a later negated (`!`)
// rule can re-include a path. Compiled regexes are cached per pattern.
//
// Semantics are gitignore's, NOT a whitelist: every path is included by default,
// each `exclude` rule subtracts, and each `include` rule (negated) is an
// EXCEPTION that re-admits a path a prior exclude removed (rules in order, last
// match wins). An `include` alone is therefore not a whitelist — a path matching
// no rule is kept. So removing an exclude pattern re-admits its files.

export interface ExclusionRule {
  pattern: string;
  negated: boolean;
}

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate a glob into an anchored RegExp source. */
function globToRegExpSource(pattern: string): string {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') {
          out += '(?:.*/)?'; // `**/` matches zero or more leading directories
          i++;
        } else {
          out += '.*'; // `**` matches anything, including `/`
        }
      } else {
        out += '[^/]*'; // `*` matches anything except `/`
        i++;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else {
      out += escapeRegexChar(c);
      i++;
    }
  }
  return out + '$';
}

export class ExclusionEngine {
  private rules: ExclusionRule[] = [];
  private regexCache = new Map<string, RegExp>();

  get ruleCount(): number {
    return this.rules.length;
  }

  setRules(rules: ExclusionRule[]): void {
    this.rules = rules;
    this.regexCache.clear();
  }

  setIncludeExclude(includes: string[], excludes: string[]): void {
    const rules: ExclusionRule[] = [];
    // 1. Exclude rules take effect first
    for (const p of excludes) {
      rules.push({ pattern: p, negated: false });
    }
    // 2. Include rules override excludes (higher priority)
    for (const p of includes) {
      rules.push({ pattern: p, negated: true });
    }
    this.setRules(rules);
  }

  private regexFor(pattern: string): RegExp {
    let re = this.regexCache.get(pattern);
    if (!re) {
      re = new RegExp(globToRegExpSource(pattern));
      this.regexCache.set(pattern, re);
    }
    return re;
  }

  /** Does `relativePath` match `glob`? (Path separators are normalised first.) */
  matchesGlob(relativePath: string, glob: string): boolean {
    const norm = relativePath.replace(/\\/g, '/');
    return this.regexFor(glob).test(norm);
  }

  /**
   * Apply the rules in order; the last matching rule wins, so a trailing
   * negated rule re-includes a path excluded by an earlier rule.
   */
  isExcludedRelativePath(relativePath: string): boolean {
    return this.isExcludedForPathForms([relativePath]);
  }

  /**
   * Decide exclusion when a single file can be named by several equivalent path
   * forms (e.g. the workspace-relative path AND a workspace-folder-name-prefixed
   * variant so a pattern like `**​/linux-src/**` can match the root folder name).
   *
   * Crucially this evaluates the rule list **once**, treating a rule as matching
   * if it matches *any* form. Composing two separate `isExcludedRelativePath`
   * calls with OR is wrong: an include like `src/**` matches the bare `src/foo.c`
   * form but not the `proj/src/foo.c` variant, so the OR would over-exclude. The
   * last-matching-rule-wins logic must see the unified match decision.
   */
  isExcludedForPathForms(forms: string[]): boolean {
    const norms = forms.map((f) => f.replace(/\\/g, '/'));
    // gitignore semantics: included by default; an exclude rule subtracts, a
    // later include (negated) rule re-admits. (NOT a whitelist — a path matching
    // no rule stays included.)
    let excluded = false;
    for (const rule of this.rules) {
      const re = this.regexFor(rule.pattern);
      if (norms.some((n) => re.test(n))) {
        excluded = !rule.negated;
      }
    }
    return excluded;
  }

  /**
   * Exclusion for a path relative to a workspace folder. Tests both `rel` and a
   * `folderName/rel` variant so patterns may reference the workspace folder name
   * itself. Either separator is accepted.
   */
  isExcludedInFolder(rel: string, folderName?: string): boolean {
    const norm = rel.replace(/\\/g, '/');
    const forms = [norm];
    if (folderName) {
      forms.push(norm === '' ? folderName : `${folderName}/${norm}`);
    }
    return this.isExcludedForPathForms(forms);
  }

  /** Parse a single `.gitignore` line into 0+ rules. */
  static parseGitignoreLine(line: string): ExclusionRule[] {
    let raw = line.trim();
    if (raw === '' || raw.startsWith('#')) {
      return [];
    }
    let negated = false;
    if (raw.startsWith('!')) {
      negated = true;
      raw = raw.slice(1);
    }
    const rooted = raw.startsWith('/');
    if (rooted) {
      raw = raw.slice(1);
    }
    const dirOnly = raw.endsWith('/');
    if (dirOnly) {
      raw = raw.slice(0, -1);
    }
    if (raw === '') {
      return [];
    }
    const core = dirOnly ? `${raw}/**` : raw;
    const rules: ExclusionRule[] = [{ pattern: core, negated }];
    // A non-rooted pattern matches at any depth, so add a `**/` variant.
    if (!rooted) {
      rules.push({ pattern: `**/${core}`, negated });
    }
    return rules;
  }

  /** Parse a whole `.gitignore` file's contents into ordered rules. */
  static parseGitignoreContent(content: string): ExclusionRule[] {
    const rules: ExclusionRule[] = [];
    for (const line of content.split(/\r?\n/)) {
      rules.push(...ExclusionEngine.parseGitignoreLine(line));
    }
    return rules;
  }
}
