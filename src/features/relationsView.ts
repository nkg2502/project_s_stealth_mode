import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { Host } from '../core/host';
import { findLocal } from '../store/db';
import type { RefHit } from '../store/db';
import { declarationsAt, definitionsAt, referencesAt, scopeAt } from './resolve';
import type { MemberCtx, Scope } from './resolve';
import { callRelations } from './callGraph';
import type { CallDirection, CallTreeNode } from './callGraph';
import { groupReferencesByFile, snippetLabel } from './refGroups';
import { resolveTypeInfo } from './typeInfo';
import type { TypeInfo } from './typeInfo';
import { resolveSymbolInfo } from './symbolInfo';
import type { SymbolInfo } from './symbolInfo';

// Source Insight-style Relations view. Follows the cursor (debounced) and shows
// Symbol / Definition / Declaration / Called by / Calls / Reference for the
// symbol under the cursor, each resolved via a SQLite point query. Resolution is
// scope-aware: on a parameter/local, Definition and Reference are scoped to the
// enclosing function instead of matching every same-named global.

/** The symbol under the cursor, with enough context to resolve its scope. */
export interface CurrentSymbol {
  name: string;
  file: string;
  line: number;
  col: number;
  /** true when reached via `obj.` / `obj->` — for member-access resolution. */
  isMemberAccess?: boolean;
  /** Base object of the member access (`node->head` → `node`). */
  objectName?: string;
  /** Full base chain root-first (`node->head.x` cursor on `x` → `['node','head']`). */
  memberChain?: string[];
  /** Argument count when the symbol is a call `name(args)` — disambiguates by arity. */
  callArity?: number;
}

type Category = 'Symbol' | 'Type' | 'Definition' | 'Declaration' | 'Called by' | 'Calls' | 'References';
const CATEGORIES: Category[] = ['Symbol', 'Type', 'Definition', 'Declaration', 'Called by', 'Calls', 'References'];

// Per-category visibility setting key suffix (`cBlitz.codeInsight.show.<key>`).
const CONFIG_KEY: Record<Category, string> = {
  Symbol: 'symbol',
  Type: 'type',
  Definition: 'definition',
  Declaration: 'declaration',
  'Called by': 'calledBy',
  Calls: 'calls',
  References: 'references',
};

interface CategoryNode {
  kind: 'category';
  category: Category;
  symbol: CurrentSymbol;
}
interface LeafNode {
  kind: 'leaf';
  label: string;
  description?: string;
  file?: string;
  line?: number;
  col?: number;
  /** Optional codicon id (e.g. 'sync' for the indexing indicator). */
  icon?: string;
  tooltip?: string;
}
// A file group under the "References" category — like VS Code's Find All
// References, occurrences are grouped per file and expand into snippet rows.
interface RefFileNode {
  kind: 'refFile';
  file: string;
  refs: RefHit[];
}
// A node in a recursive Calls / Called-by tree. Expands lazily into its own
// callees/callers; a `recursive` node is a terminal (a cycle back to an ancestor).
interface CallNode {
  kind: 'call';
  direction: CallDirection;
  name: string;
  description?: string;
  file: string;
  line: number;
  col: number;
  ancestors: string[];
  recursive: boolean;
}
type RNode = CategoryNode | LeafNode | CallNode | RefFileNode;

function basename(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

export class RelationsProvider implements vscode.TreeDataProvider<RNode> {
  private readonly emitter = new vscode.EventEmitter<RNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private current: CurrentSymbol | undefined;
  private pinned = false;
  private indexing = false;
  // While a full/bulk scan runs, the name indexes are dropped (drop/create bulk
  // strategy) and the writer holds the DB, so a host-side point query degrades to
  // a multi-million-row full scan that blocks the (synchronous) host thread for up
  // to busy_timeout. We therefore pause ALL Code Insight DB reads during a bulk
  // scan and show a placeholder; reads resume automatically when it finishes.
  private suspendReads = false;
  private keywordName: string | undefined;
  private scopeMemo = new Map<string, Scope>();
  // Type-row info per symbol, memoized (used by both the category header and its
  // children). Key: `${symbol.file}:${symbol.line}:${symbol.col}`. The stored
  // value may be undefined (symbol has no declared type) — that's a real result.
  private typeMemo = new Map<string, TypeInfo | undefined>();
  // Rich "Symbol" summary per symbol, memoized (used by the category header and its
  // detail children). Key: `${symbol.file}:${symbol.line}:${symbol.col}`.
  private symbolInfoMemo = new Map<string, SymbolInfo | undefined>();
  // Cache key: `${category}:${symbol.file}:${symbol.line}:${symbol.col}`
  private cache = new Map<string, RNode[]>();
  // Source lines per file, read lazily when a "References" file group expands.
  private fileLines = new Map<string, string[]>();

  constructor(private readonly host: Host) {}

  setCurrent(symbol: CurrentSymbol | undefined): void {
    // Key on position, not just name: resolution is now position-dependent (scope,
    // and member-access narrowing differ between two same-named occurrences), so
    // moving to a different occurrence must refresh. Moving within one word keeps
    // the same start position, so there is no extra churn.
    const key = (s?: CurrentSymbol): string => (s ? `${s.file}\0${s.line}\0${s.col}\0${s.name}` : '');
    if (this.pinned || key(symbol) === key(this.current)) {
      return; // pinned: stop following the cursor; same position+name: unchanged
    }
    this.current = symbol;
    this.keywordName = undefined;
    this.scopeMemo.clear();
    this.typeMemo.clear();
    this.symbolInfoMemo.clear();
    this.cache.clear();
    this.fileLines.clear();
    this.emitter.fire(undefined);
  }

  /** Mark the cursor as sitting on a C/C++ keyword (not a user-defined symbol). */
  setKeyword(name: string): void {
    if (this.pinned) {
      return;
    }
    if (this.keywordName === name) {
      return; // same keyword, nothing changed
    }
    this.current = undefined;
    this.keywordName = name;
    this.scopeMemo.clear();
    this.typeMemo.clear();
    this.symbolInfoMemo.clear();
    this.cache.clear();
    this.fileLines.clear();
    this.emitter.fire(undefined);
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    void vscode.commands.executeCommand('setContext', 'cBlitz.relationsPinned', pinned);
  }

  /**
   * Toggle the "Indexing…" header row (driven by the bulk/incremental index).
   * `suspendReads` (set for a bulk scan) additionally pauses all DB queries — see
   * `suspendReads` field — so the view does no work while the index is rebuilding.
   */
  setIndexing(busy: boolean, suspendReads = false): void {
    if (this.indexing === busy && this.suspendReads === suspendReads) {
      return;
    }
    this.indexing = busy;
    this.suspendReads = suspendReads;
    this.emitter.fire(undefined); // re-render the root only; keep the per-symbol cache
  }

  refresh(): void {
    this.scopeMemo.clear();
    this.typeMemo.clear();
    this.symbolInfoMemo.clear();
    this.cache.clear();
    this.fileLines.clear();
    this.emitter.fire(undefined);
  }

  getTreeItem(node: RNode): vscode.TreeItem {
    if (node.kind === 'category') {
      const children = this.childrenFor(node.category, node.symbol);
      const item = new vscode.TreeItem(node.category, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `cat:${node.category}:${node.symbol.file}:${node.symbol.line}:${node.symbol.col}`;
      if (node.category === 'Symbol') {
        // The Symbol summary names the symbol on the category row itself and
        // expands into its detail rows (Kind / Type or Signature / Storage /
        // locations). Always expanded — it is the headline info for the cursor.
        const info = this.symbolInfoFor(node.symbol);
        item.description = info?.name ?? node.symbol.name;
        item.iconPath = new vscode.ThemeIcon('symbol-misc');
        item.collapsibleState =
          children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
      } else if (node.category === 'Type') {
        // The Type row shows the declared type text itself (not a count). A single
        // click jumps straight to the type's definition (the underlying struct);
        // it only expands when there is more than one target. A primitive like
        // `uint32_t` has no definition, so the row is a non-jumping leaf.
        const info = this.typeInfoFor(node.symbol);
        item.description = info?.text ?? '';
        item.iconPath = new vscode.ThemeIcon('symbol-type-parameter');
        const def = info?.defs[0];
        if (def) {
          item.command = {
            command: 'cBlitz.openLocation',
            title: 'Open',
            arguments: [def.file, def.line, def.col],
          };
        }
        item.collapsibleState =
          children.length > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      } else {
        // References children are per-file groups; show the total occurrence count.
        const count =
          node.category === 'References'
            ? children.reduce((n, c) => n + (c.kind === 'refFile' ? c.refs.length : 0), 0)
            : children.length;
        item.description = String(count);
      }
      item.contextValue = 'category';
      return item;
    }
    if (node.kind === 'refFile') {
      const item = new vscode.TreeItem(basename(node.file), vscode.TreeItemCollapsibleState.Collapsed);
      
      let dir = vscode.workspace.asRelativePath(node.file);
      const slash = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
      dir = slash >= 0 ? dir.slice(0, slash) : '';
      
      const count = node.refs.length;
      item.description = `${count} ${count === 1 ? 'match' : 'matches'} in ${dir || '.'}`;
      item.resourceUri = vscode.Uri.file(node.file);
      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = node.file;
      item.contextValue = 'refFile';
      return item;
    }
    if (node.kind === 'call') {
      const symbol: CurrentSymbol = { name: node.name, file: node.file, line: node.line, col: node.col };
      const categories = this.visibleCategories(symbol);
      const expandable = categories.length > 0;
      const item = new vscode.TreeItem(
        node.name,
        expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.description = node.recursive ? `${node.description} ↻` : node.description;
      if (node.recursive) {
        item.tooltip = 'Recursion — this call already appears higher in this branch';
      }
      item.command = {
        command: 'cBlitz.openLocation',
        title: 'Open',
        arguments: [node.file, node.line, node.col],
      };
      item.resourceUri = vscode.Uri.file(node.file);
      item.iconPath = new vscode.ThemeIcon('symbol-function', new vscode.ThemeColor('symbolIcon.functionForeground'));
      item.contextValue = 'call';
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    if (node.tooltip) {
      item.tooltip = node.tooltip;
    }
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon);
    }
    if (node.file !== undefined && node.line !== undefined) {
      item.command = {
        command: 'cBlitz.openLocation',
        title: 'Open',
        arguments: [node.file, node.line, node.col ?? 0],
      };
    }
    return item;
  }

  getChildren(node?: RNode): RNode[] | Promise<RNode[]> {
    if (!node) {
      // During a bulk scan, do zero DB work — a point query would full-scan the
      // unindexed tables and freeze the host thread. Show only a paused notice.
      if (this.suspendReads) {
        return [{
          kind: 'leaf',
          label: 'Indexing… Code Insight paused',
          icon: 'sync',
          tooltip: 'Paused during the full workspace scan to keep indexing fast; resumes automatically when the scan finishes.',
        }];
      }
      // A non-interactive "Indexing…" header while an incremental index runs.
      const head: RNode[] = this.indexing
        ? [{ kind: 'leaf', label: 'Indexing…', icon: 'sync' }]
        : [];
      if (this.keywordName) {
        return [...head, { kind: 'leaf', label: `'${this.keywordName}' is a C/C++ keyword` }];
      }
      if (!this.current) {
        return [...head, { kind: 'leaf', label: 'Place the cursor on a C/C++ symbol' }];
      }
      const db = this.host.getDb();
      if (!db) {
        return [...head, { kind: 'leaf', label: 'Index not ready yet…' }];
      }
      // The "Symbol" category (always first, never hidden) carries the headline
      // summary — name, humanized kind, declared type / signature, storage, and
      // jump-able definition/declaration locations — replacing the old single-line
      // header. It resolves the symbol like F12 (role + member narrowing + the
      // self-guard) so it describes the symbol the cursor denotes, not every
      // same-named one. The remaining categories follow.
      const categories = this.visibleCategories(this.current);
      if (categories.length === 0) {
        // Every category's show toggle is off — nothing to render but the head.
        return [...head, { kind: 'leaf', label: `No matches` }];
      }
      return [
        ...head,
        ...categories.map((category): RNode => ({ kind: 'category', category, symbol: this.current! }))
      ];
    }
    if (node.kind === 'category') {
      return this.childrenFor(node.category, node.symbol);
    }
    if (node.kind === 'refFile') {
      // Lazily read the file and render one snippet row per occurrence.
      return this.refFileChildren(node);
    }
    if (node.kind === 'call') {
      const symbol: CurrentSymbol = { name: node.name, file: node.file, line: node.line, col: node.col };
      const categories = this.visibleCategories(symbol);
      return categories.map((category): RNode => ({ kind: 'category', category, symbol }));
    }
    return [];
  }

  /** Read `node.file` once (cached) and map its references to snippet rows. */
  private async refFileChildren(node: RefFileNode): Promise<RNode[]> {
    const lines = await this.readLines(node.file);
    return node.refs.map((r) => ({
      kind: 'leaf',
      label: snippetLabel(lines, r),
      description: `Ln ${r.line + 1}${r.enclosingFunc ? ` · ${r.enclosingFunc}` : ''}`,
      file: r.file,
      line: r.line,
      col: r.col,
    }));
  }

  private async readLines(file: string): Promise<string[]> {
    const cached = this.fileLines.get(file);
    if (cached) {
      return cached;
    }
    let lines: string[] = [];
    try {
      lines = (await fs.promises.readFile(file, 'utf8')).split(/\r\n|\r|\n/);
    } catch {
      lines = []; // file missing/unreadable — snippetLabel falls back to "line N"
    }
    this.fileLines.set(file, lines);
    return lines;
  }

  /**
   * Categories enabled via `cBlitz.codeInsight.show.*` (all default on), minus
   * any empty ones when `cBlitz.codeInsight.hideEmptyCategories` is set.
   */
  private visibleCategories(symbol: CurrentSymbol): Category[] {
    const cfg = vscode.workspace.getConfiguration('cBlitz');
    const hideEmpty = cfg.get<boolean>('codeInsight.hideEmptyCategories', true);
    return CATEGORIES.filter((c) => {
      if (!cfg.get<boolean>(`codeInsight.show.${CONFIG_KEY[c]}`, true)) {
        return false;
      }
      // The Symbol summary always says something useful (the kind, or "not found"),
      // so it is never dropped by hideEmptyCategories.
      if (c === 'Symbol') {
        return true;
      }
      if (!hideEmpty) {
        return true;
      }
      // Type is "empty" only when the symbol has no declared type at all — a
      // primitive (no jump target, hence no children) must still show its text.
      if (c === 'Type') {
        return this.typeInfoFor(symbol) !== undefined;
      }
      return this.childrenFor(c, symbol).length > 0;
    });
  }

  private childrenFor(category: Category, symbol: CurrentSymbol): RNode[] {
    const key = `${category}:${symbol.file}:${symbol.line}:${symbol.col}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.computeChildren(category, symbol);
      this.cache.set(key, cached);
    }
    return cached;
  }

  /** The rich Symbol summary for a symbol (memoized; undefined only when no DB). */
  private symbolInfoFor(symbol: CurrentSymbol): SymbolInfo | undefined {
    const key = `${symbol.file}:${symbol.line}:${symbol.col}`;
    if (this.symbolInfoMemo.has(key)) {
      return this.symbolInfoMemo.get(key);
    }
    const db = this.host.getDb();
    const info = db ? resolveSymbolInfo(db, symbol) : undefined;
    this.symbolInfoMemo.set(key, info);
    return info;
  }

  /** The declared-type info for a symbol (memoized; undefined = no declared type). */
  private typeInfoFor(symbol: CurrentSymbol): TypeInfo | undefined {
    const key = `${symbol.file}:${symbol.line}:${symbol.col}`;
    if (this.typeMemo.has(key)) {
      return this.typeMemo.get(key);
    }
    const db = this.host.getDb();
    const info = db ? resolveTypeInfo(db, symbol) : undefined;
    this.typeMemo.set(key, info);
    return info;
  }

  private getScope(symbol: CurrentSymbol): Scope {
    const key = `${symbol.file}:${symbol.name}:${symbol.line}:${symbol.col}`;
    let scope = this.scopeMemo.get(key);
    if (!scope) {
      const db = this.host.getDb();
      scope = db ? scopeAt(db, symbol.file, symbol.name, symbol.line, symbol.col) : { isLocal: false, func: null, role: '', owner: '', objChain: '' };
      this.scopeMemo.set(key, scope);
    }
    return scope;
  }

  private computeChildren(category: Category, ctx: CurrentSymbol): RNode[] {
    const db = this.host.getDb();
    if (!db) {
      return [];
    }
    const name = ctx.name;
    const at = (h: { file: string; line: number; col: number; kind?: string }): LeafNode => ({
      kind: 'leaf',
      label: `${basename(h.file)}:${h.line + 1}`,
      description: h.kind,
      file: h.file,
      line: h.line,
      col: h.col,
    });
    const scope = this.getScope(ctx);
    switch (category) {
      case 'Symbol': {
        // Detail rows for the headline summary. A row with a location (Defined/
        // Declared in) carries a jump target; the rest are plain label · value.
        const info = this.symbolInfoFor(ctx);
        return (info?.rows ?? []).map((r): LeafNode => ({
          kind: 'leaf',
          label: r.label,
          description: r.value,
          file: r.file,
          line: r.line,
          col: r.col,
        }));
      }
      case 'Type': {
        // The declared type's definition(s) as jump targets. The type text is
        // shown on the category row itself (getTreeItem); a primitive has no
        // jump target, so this is empty and the row stays a leaf.
        const info = this.typeInfoFor(ctx);
        return (info?.defs ?? []).map((d) => at(d));
      }
      case 'Definition':
        // On a parameter/local, the "definition" is its declaration in scope.
        if (scope.isLocal && scope.func) {
          return findLocal(db, name, ctx.file, scope.func).map((l) => at({ ...l, kind: l.kind }));
        }
        // Resolve structurally, like F12: the cursor token's role restricts the
        // kinds (a `field` use never lists a same-named goto label) and a member
        // access narrows to the field of the object's actual type — not every
        // same-named field. (Bare name match was the bug behind both reports.)
        return definitionsAt(db, name, scope.role, ctx.file, memberCtx(ctx, scope), ctx.isMemberAccess ?? false, ctx.callArity).map((h) => at(h));
      case 'Declaration':
        if (scope.isLocal) {
          return []; // a local/parameter has no separate declaration
        }
        return declarationsAt(db, name, scope.role, ctx.file, memberCtx(ctx, scope), ctx.isMemberAccess ?? false, ctx.callArity).map((h) => at(h));
      case 'Called by':
        // Recursive caller tree: direct callers first, each expandable into its
        // own callers. Cycles terminate (see callGraph). Scope-gated: a local
        // variable is not a function, so it never adopts a same-named global
        // function's callers (the `u64 bitmap;` vs `bitmap(...)` bug).
        return callRelations(db, 'callers', name, scope.isLocal).map((n) => toCallNode('callers', n));
      case 'Calls':
        // Recursive callee tree: direct callees first, each expandable into its
        // own callees. Scope-gated like "Called by".
        return callRelations(db, 'callees', name, scope.isLocal).map((n) => toCallNode('callees', n));
      case 'References': {
        // On a parameter/local, only its in-function uses; otherwise global
        // references (which already exclude same-named locals). For a field token,
        // owner-narrowed so `obj->head` lists only that struct's field, not every
        // same-named field. Grouped per file; snippets read lazily on expand.
        const refs = referencesAt(db, name, scope.role, ctx.file, memberCtx(ctx, scope), scope.isLocal, scope.func);
        return groupReferencesByFile(refs).map((g) => ({
          kind: 'refFile',
          file: g.file,
          refs: g.refs,
        }));
      }
    }
  }
}

/** Member-access context for the shared resolver, from the cursor symbol + scope. */
function memberCtx(ctx: CurrentSymbol, scope: Scope): MemberCtx {
  return { objectName: ctx.objectName, memberChain: ctx.memberChain, enclosingFunc: scope.func, owner: scope.owner, objChain: scope.objChain };
}

function toCallNode(direction: CallDirection, n: CallTreeNode): CallNode {
  return {
    kind: 'call',
    direction,
    name: n.name,
    description: `${basename(n.file)}:${n.line + 1}`,
    file: n.file,
    line: n.line,
    col: n.col,
    ancestors: n.ancestors,
    recursive: n.recursive,
  };
}
