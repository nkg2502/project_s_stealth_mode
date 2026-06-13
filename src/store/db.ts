import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { FileIndex, RefRole, SourceKind, SymbolKind } from '../core/types';

// SQLite storage on Node's built-in `node:sqlite` (DatabaseSync) — no native
// dependency, so the same code runs identically in VS Code's Electron, on
// Remote-SSH, and under plain Node for the headless tests, with nothing to
// rebuild per runtime. The pool workers are the writers; the host opens
// read-only connections. Schema is inlined to avoid bundle path issues.

type DB = DatabaseSync;
type Row = Record<string, unknown>;

// The on-disk schema identity follows the EXTENSION version (stored in
// `PRAGMA user_version`): bump the version in package.json whenever the table
// layout or extraction semantics change and stale DBs rebuild automatically.
// `schemaVersionFor` encodes the semver into the integer user_version holds.
export function schemaVersionFor(extensionVersion: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(extensionVersion.trim());
  if (!m) {
    return 0;
  }
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

const DROP_SCHEMA = `
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS symbols;
DROP TABLE IF EXISTS refs;
DROP TABLE IF EXISTS calls;
DROP TABLE IF EXISTS locals;
DROP TABLE IF EXISTS typedef_aliases;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  path      TEXT UNIQUE NOT NULL,
  hash      TEXT NOT NULL,
  mtime     INTEGER NOT NULL,
  parsed_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  file_id       INTEGER NOT NULL,
  line          INTEGER NOT NULL,
  col           INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  end_col       INTEGER NOT NULL,
  is_definition INTEGER NOT NULL,
  source        TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT '',
  data_type     TEXT NOT NULL DEFAULT '',
  decl_type     TEXT NOT NULL DEFAULT '',
  signature     TEXT NOT NULL DEFAULT '',
  return_type   TEXT NOT NULL DEFAULT '',
  storage       TEXT NOT NULL DEFAULT '',
  parent_id     INTEGER,
  arity         INTEGER,
  param_types   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS refs (
  name           TEXT NOT NULL,
  file_id        INTEGER NOT NULL,
  line           INTEGER NOT NULL,
  col            INTEGER NOT NULL,
  enclosing_func TEXT,
  is_local       INTEGER NOT NULL,
  role           TEXT NOT NULL DEFAULT '',
  owner          TEXT NOT NULL DEFAULT '',
  obj_chain      TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  caller  TEXT,
  callee  TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  line    INTEGER NOT NULL,
  col     INTEGER NOT NULL,
  source  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locals (
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  file_id   INTEGER NOT NULL,
  func      TEXT NOT NULL,
  line      INTEGER NOT NULL,
  col       INTEGER NOT NULL,
  end_line  INTEGER NOT NULL,
  end_col   INTEGER NOT NULL,
  data_type TEXT NOT NULL DEFAULT '',
  decl_type TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS typedef_aliases (
  name    TEXT NOT NULL,
  target  TEXT NOT NULL,
  file_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_file    ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_calls_file   ON calls(file_id);
CREATE INDEX IF NOT EXISTS idx_locals_file   ON locals(file_id);
CREATE INDEX IF NOT EXISTS idx_aliases_file  ON typedef_aliases(file_id);
`;

export const DROP_INDEXES = `
DROP INDEX IF EXISTS idx_symbols_name;
DROP INDEX IF EXISTS idx_refs_name;
DROP INDEX IF EXISTS idx_refs_pos;
DROP INDEX IF EXISTS idx_calls_callee;
DROP INDEX IF EXISTS idx_calls_caller;
DROP INDEX IF EXISTS idx_locals_lookup;
DROP INDEX IF EXISTS idx_aliases_name;
`;

export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_refs_name    ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_pos     ON refs(file_id, line, col);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller);
CREATE INDEX IF NOT EXISTS idx_locals_lookup ON locals(file_id, func, name);
CREATE INDEX IF NOT EXISTS idx_aliases_name  ON typedef_aliases(name);
`;

export interface OpenOptions {
  readonly?: boolean;
}

function applyWritePragmas(db: DB, dbPath: string): void {
  // The indexing pool opens one writable connection per worker. WAL allows
  // exactly one writer at a time; busy_timeout makes the others wait for the
  // write lock (and for concurrent schema/pragma setup on first run) instead of
  // failing with SQLITE_BUSY. Set it first so everything below also waits.
  db.exec('PRAGMA busy_timeout = 15000');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA synchronous = OFF');
}

/**
 * Create/upgrade the on-disk schema before any worker connects. `schemaVersion`
 * is derived from the extension version (see `schemaVersionFor`). Returns whether
 * an existing DB was wiped because its `user_version` no longer matches. Run once
 * on the host so the pool workers don't race on schema creation or migration.
 */
export function ensureSchema(dbPath: string, schemaVersion: number): { recreated: boolean } {
  const existed = dbPath !== ':memory:' && fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    applyWritePragmas(db, dbPath);
    const row = db.prepare('PRAGMA user_version').get() as Row | undefined;
    const version = Number(row?.user_version ?? 0);
    const recreated = existed && version !== schemaVersion;
    if (recreated) {
      db.exec(DROP_SCHEMA);
    }
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
    return { recreated };
  } finally {
    db.close();
  }
}

export function openDb(dbPath: string, opts: OpenOptions = {}): DB {
  if (opts.readonly) {
    // readOnly open of a missing file throws (SQLITE_CANTOPEN); callers treat
    // that as "no index yet", matching the old fileMustExist behaviour.
    return new DatabaseSync(dbPath, { readOnly: true });
  }
  const db = new DatabaseSync(dbPath);
  applyWritePragmas(db, dbPath);
  db.exec(SCHEMA);
  return db;
}

// ---- writer (single instance per DB; prepares statements once) ----

export interface Writer {
  apply(fi: FileIndex, mtime: number): void;
  applyBatch(batch: { fi: FileIndex; mtime: number }[]): void;
  remove(path: string): void;
}

/** Wrap a function so it runs inside one BEGIN/COMMIT (ROLLBACK on throw). */
function transaction<A extends unknown[]>(db: DB, fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    db.exec('BEGIN');
    try {
      fn(...args);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore — surfacing the original error matters more
      }
      throw e;
    }
  };
}

export function createWriter(db: DB): Writer {
  const getFileId = db.prepare('SELECT id FROM files WHERE path = ?');
  const delFiles = db.prepare('DELETE FROM files WHERE id = ?');
  const delSym = db.prepare('DELETE FROM symbols WHERE file_id = ?');
  const delRef = db.prepare('DELETE FROM refs WHERE file_id = ?');
  const delCall = db.prepare('DELETE FROM calls WHERE file_id = ?');
  const delLocal = db.prepare('DELETE FROM locals WHERE file_id = ?');
  const delAlias = db.prepare('DELETE FROM typedef_aliases WHERE file_id = ?');
  const insFile = db.prepare(
    'INSERT INTO files (path, hash, mtime, parsed_by) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, parsed_by=excluded.parsed_by RETURNING id',
  );
  const insSym = db.prepare(
    'INSERT INTO symbols (name, kind, file_id, line, col, end_line, end_col, is_definition, source, scope, data_type, decl_type, signature, return_type, storage, arity, param_types) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insRef = db.prepare(
    'INSERT INTO refs (name, file_id, line, col, enclosing_func, is_local, role, owner, obj_chain, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insCall = db.prepare(
    'INSERT INTO calls (caller, callee, file_id, line, col, source) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insLocal = db.prepare(
    'INSERT INTO locals (name, kind, file_id, func, line, col, end_line, end_col, data_type, decl_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insAlias = db.prepare(
    'INSERT INTO typedef_aliases (name, target, file_id) VALUES (?, ?, ?)',
  );

  const clearById = (id: number): void => {
    delSym.run(id);
    delRef.run(id);
    delCall.run(id);
    delLocal.run(id);
    delAlias.run(id);
  };

  const applyOne = (fi: FileIndex, mtime: number) => {
    const row = insFile.get(fi.file, fi.hash, mtime, fi.parsedBy) as { id: number };
    const id = row.id;
    clearById(id);
    for (const s of fi.symbols) {
      insSym.run(s.name, s.kind, id, s.line, s.col, s.endLine, s.endCol, s.isDefinition ? 1 : 0, s.source, s.scope ?? '', s.dataType ?? '', s.declType ?? '', s.signature ?? '', s.returnType ?? '', s.storage ?? '', s.arity ?? null, s.paramTypes ?? '');
    }
    for (const r of fi.refs) {
      insRef.run(r.name, id, r.line, r.col, r.enclosingFunc, r.isLocal ? 1 : 0, r.role, r.owner ?? '', r.objChain ?? '', r.source);
    }
    for (const c of fi.calls) {
      insCall.run(c.caller, c.callee, id, c.line, c.col, c.source);
    }
    for (const l of fi.locals) {
      insLocal.run(l.name, l.kind, id, l.func, l.line, l.col, l.endLine, l.endCol, l.dataType ?? '', l.declType ?? '');
    }
    for (const a of fi.aliases) {
      insAlias.run(a.name, a.target, id);
    }
  };

  const applyTx = transaction(db, (fi: FileIndex, mtime: number) => {
    applyOne(fi, mtime);
  });

  const applyBatchTx = transaction(db, (batch: { fi: FileIndex; mtime: number }[]) => {
    for (const { fi, mtime } of batch) {
      applyOne(fi, mtime);
    }
  });

  const removeTx = transaction(db, (path: string) => {
    const row = getFileId.get(path) as { id: number } | undefined;
    if (row) {
      const id = row.id;
      delFiles.run(id);
      clearById(id);
    }
  });

  return {
    apply: (fi, mtime) => applyTx(fi, mtime),
    applyBatch: (batch) => applyBatchTx(batch),
    remove: (path) => removeTx(path),
  };
}

// ---- read queries (host) ----

export interface SymbolHit {
  /** Stable numeric symbol id (the SQLite rowid). */
  id: number;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  isDefinition: boolean;
  source: SourceKind;
  /** Owning aggregate tag for a field/member (`''` when none). */
  scope: string;
  /** A field's own declared aggregate type tag (`''` when none) — for chain walks. */
  dataType: string;
  /** Full declared type text for the Code Insight "Type" row (`''` when none). */
  declType: string;
  /** Function/method signature `name(params…)` (`''` when not a function). */
  signature: string;
  /** Function/method return-type text (`''` when not a function). */
  returnType: string;
  /** Storage-class/function specifiers (`static extern inline …`; `''` when none). */
  storage: string;
  /** Cross-file id of the owning aggregate/class/enum symbol (`null` when unresolved). */
  parentId: number | null;
  /** Fixed-parameter count for a function (`null` for non-functions / unspecified `()`). */
  arity: number | null;
  /** Per-parameter type list (`int,char`, trailing `...` if variadic; `''` otherwise). */
  paramTypes: string;
}

export interface RefHit {
  name: string;
  file: string;
  line: number;
  col: number;
  enclosingFunc: string | null;
  /** Owning aggregate tag for a `field` occurrence (`''` when unknown / non-field). */
  owner: string;
  /** Object base chain (space-joined) for a `field` use — for query-time owner resolution. */
  objChain: string;
  source: SourceKind;
}

export interface CallHit {
  caller: string | null;
  callee: string;
  file: string;
  line: number;
  col: number;
  source: SourceKind;
}

const SYMBOL_COLS =
  's.id AS id, s.name, s.kind, f.path AS file, s.line, s.col, s.end_line AS endLine, s.end_col AS endCol, s.is_definition AS isDef, s.source, s.scope AS scope, s.data_type AS dataType, s.decl_type AS declType, s.signature AS signature, s.return_type AS returnType, s.storage AS storage, s.parent_id AS parentId, s.arity AS arity, s.param_types AS paramTypes';

function toSymbolHit(r: Row): SymbolHit {
  return {
    id: Number(r.id),
    name: r.name as string,
    kind: r.kind as SymbolKind,
    file: r.file as string,
    line: Number(r.line),
    col: Number(r.col),
    endLine: Number(r.endLine),
    endCol: Number(r.endCol),
    isDefinition: Number(r.isDef) === 1,
    source: r.source as SourceKind,
    scope: (r.scope as string | null) ?? '',
    dataType: (r.dataType as string | null) ?? '',
    declType: (r.declType as string | null) ?? '',
    signature: (r.signature as string | null) ?? '',
    returnType: (r.returnType as string | null) ?? '',
    storage: (r.storage as string | null) ?? '',
    parentId: r.parentId == null ? null : Number(r.parentId),
    arity: r.arity == null ? null : Number(r.arity),
    paramTypes: (r.paramTypes as string | null) ?? '',
  };
}

export function findSymbols(db: DB, name: string): SymbolHit[] {
  const rows = db.prepare(`SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ?`).all(name) as Row[];
  return rows.map(toSymbolHit);
}

/** `AND s.kind IN (?, ?, …)` clause + bind values for an optional kind filter. */
function kindFilter(kinds?: readonly SymbolKind[]): { clause: string; params: string[] } {
  if (!kinds || kinds.length === 0) {
    return { clause: '', params: [] };
  }
  return { clause: ` AND s.kind IN (${kinds.map(() => '?').join(', ')})`, params: [...kinds] };
}

export function findDefinitions(db: DB, name: string, kinds?: readonly SymbolKind[]): SymbolHit[] {
  const { clause, params } = kindFilter(kinds);
  const rows = db
    .prepare(`SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? AND s.is_definition = 1${clause}`)
    .all(name, ...params) as Row[];
  return rows.map(toSymbolHit);
}

export function findDeclarations(db: DB, name: string, kinds?: readonly SymbolKind[]): SymbolHit[] {
  const { clause, params } = kindFilter(kinds);
  const rows = db
    .prepare(`SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? AND s.is_definition = 0${clause}`)
    .all(name, ...params) as Row[];
  return rows.map(toSymbolHit);
}

function toRefHit(r: Row): RefHit {
  return {
    name: r.name as string,
    file: r.file as string,
    line: Number(r.line),
    col: Number(r.col),
    enclosingFunc: (r.enclosingFunc as string | null) ?? null,
    owner: (r.owner as string | null) ?? '',
    objChain: (r.objChain as string | null) ?? '',
    source: r.source as SourceKind,
  };
}

/**
 * References of a GLOBAL symbol — excludes occurrences that bind to a local.
 * When a structural `role` is given (the tree-sitter cursor token's role), the
 * result is restricted to refs of that same role, so references of a `type` tag
 * and a same-named `value` use never mix — mirroring role-based Go-to-Definition.
 * grep-fallback refs carry no AST role (`role=''`) and are kept best-effort for
 * every role EXCEPT `field`: a field is reached via `.`/`->` (or a designated
 * initializer), which the grep scanner now tags `role='field'` too, so a field
 * cursor requires an exact field role and no longer re-admits ambiguous grep rows
 * — that is what kept listing same-named local variables (e.g. a `data2` local in
 * a grep-parsed file) under a struct field's references. With no role (cursor on a
 * grep row, or none recorded) the older name-only behavior stands.
 */
export function findReferences(db: DB, name: string, role?: RefRole): RefHit[] {
  // A field's refs carry role='field' on BOTH paths (tree-sitter field_identifier,
  // and the grep scanner's member-access detection), so match it exactly. Other
  // roles still keep ambiguous grep rows (role='') best-effort.
  const roleClause = role
    ? role === 'field'
      ? ' AND r.role = ?'
      : " AND (r.role = ? OR r.role = '')"
    : '';
  const params = role ? [name, role] : [name];
  const rows = db
    .prepare(`SELECT r.name, f.path AS file, r.line, r.col, r.enclosing_func AS enclosingFunc, r.owner AS owner, r.obj_chain AS objChain, r.source FROM refs r JOIN files f ON r.file_id = f.id WHERE r.name = ? AND r.is_local = 0${roleClause}`)
    .all(...params) as Row[];
  return rows.map(toRefHit);
}

/**
 * References of a parameter/local — only within its own function. No role filter
 * is needed: only a `value` token can be `is_local`, so this set is already
 * role-homogeneous (all `value`).
 */
export function findLocalReferences(db: DB, name: string, file: string, func: string): RefHit[] {
  const rows = db
    .prepare(
      'SELECT r.name, f.path AS file, r.line, r.col, r.enclosing_func AS enclosingFunc, r.owner AS owner, r.obj_chain AS objChain, r.source FROM refs r JOIN files f ON r.file_id = f.id WHERE r.name = ? AND f.path = ? AND r.enclosing_func = ? AND r.is_local = 1',
    )
    .all(name, file, func) as Row[];
  return rows.map(toRefHit);
}

function mapCalls(rows: Row[]): CallHit[] {
  return rows.map((r) => ({
    caller: (r.caller as string | null) ?? null,
    callee: r.callee as string,
    file: r.file as string,
    line: Number(r.line),
    col: Number(r.col),
    source: r.source as SourceKind,
  }));
}

/** Functions that call `name` (the "Called by" relation). */
export function findCallers(db: DB, name: string): CallHit[] {
  return mapCalls(db.prepare('SELECT c.caller, c.callee, f.path AS file, c.line, c.col, c.source FROM calls c JOIN files f ON c.file_id = f.id WHERE c.callee = ?').all(name) as Row[]);
}

/** Functions that `name` calls (the "Calls" relation). */
export function findCallees(db: DB, name: string): CallHit[] {
  return mapCalls(db.prepare('SELECT c.caller, c.callee, f.path AS file, c.line, c.col, c.source FROM calls c JOIN files f ON c.file_id = f.id WHERE c.caller = ?').all(name) as Row[]);
}

export interface LocalHit {
  name: string;
  kind: SymbolKind;
  file: string;
  func: string;
  line: number;
  col: number;
  /** Declared aggregate tag of this local/parameter (`''` when none). */
  dataType: string;
  /** Full declared type text for the Code Insight "Type" row (`''` when none). */
  declType: string;
}

/**
 * The enclosing function of the identifier occurrence at an exact position
 * (from the refs table) — lets definition resolution know which function scope
 * the cursor sits in without re-parsing.
 */
export function enclosingFuncAt(db: DB, file: string, name: string, line: number, col: number): string | null {
  const row = db
    .prepare('SELECT r.enclosing_func AS f FROM refs r JOIN files f ON r.file_id = f.id WHERE f.path = ? AND r.name = ? AND r.line = ? AND r.col = ? LIMIT 1')
    .get(file, name, line, col) as Row | undefined;
  return row ? ((row.f as string | null) ?? null) : null;
}

/**
 * The refs row at an exact cursor position: its enclosing function and whether
 * that specific occurrence binds to a parameter/local (`is_local`). This is what
 * lets resolution tell apart two same-named tokens on one line — e.g. the type
 * tag `struct folio` (is_local=0) from the local variable `*folio` (is_local=1)
 * in `struct folio *folio = …`. Returns undefined when no ref is recorded there
 * (e.g. grep-fallback files, or a position between tokens).
 */
export function refAt(
  db: DB,
  file: string,
  name: string,
  line: number,
  col: number,
): { enclosingFunc: string | null; isLocal: boolean; role: RefRole | ''; owner: string; objChain: string; source: SourceKind } | undefined {
  const row = db
    .prepare('SELECT r.enclosing_func AS f, r.is_local AS isLocal, r.role AS role, r.owner AS owner, r.obj_chain AS objChain, r.source AS source FROM refs r JOIN files f ON r.file_id = f.id WHERE f.path = ? AND r.name = ? AND r.line = ? AND r.col = ? LIMIT 1')
    .get(file, name, line, col) as Row | undefined;
  if (!row) {
    return undefined;
  }
  return {
    enclosingFunc: (row.f as string | null) ?? null,
    isLocal: Number(row.isLocal) === 1,
    role: (row.role as RefRole | '') ?? '',
    owner: (row.owner as string | null) ?? '',
    objChain: (row.objChain as string | null) ?? '',
    source: (row.source as SourceKind) ?? 'grep',
  };
}

/** Scope-local declarations (parameter / local variable) of `name` in `func`. */
export function findLocal(db: DB, name: string, file: string, func: string): LocalHit[] {
  const rows = db
    .prepare('SELECT l.name, l.kind, f.path AS file, l.func, l.line, l.col, l.data_type AS dataType, l.decl_type AS declType FROM locals l JOIN files f ON l.file_id = f.id WHERE l.name = ? AND f.path = ? AND l.func = ?')
    .all(name, file, func) as Row[];
  return rows.map((r) => ({
    name: r.name as string,
    kind: r.kind as SymbolKind,
    file: r.file as string,
    func: r.func as string,
    line: Number(r.line),
    col: Number(r.col),
    dataType: (r.dataType as string | null) ?? '',
    declType: (r.declType as string | null) ?? '',
  }));
}

/**
 * The typedef-alias target for a name, if any: `typedef struct rcu_state_s {…}
 * rcu_state_t;` records `rcu_state_t → rcu_state_s`, so a member access through an
 * object typed `rcu_state_t` can be narrowed to fields owned by `rcu_state_s`.
 */
export function findTypedefTarget(db: DB, name: string): string | undefined {
  const row = db
    .prepare('SELECT target FROM typedef_aliases WHERE name = ? LIMIT 1')
    .get(name) as Row | undefined;
  return row ? (row.target as string) : undefined;
}

/**
 * Resolve the cross-file numeric `parent_id` of every member (a `field`, whose
 * `scope` is its owning aggregate tag) to the id of the struct/union/class/enum/
 * typedef symbol of that name — a definition preferred over a typedef of the same
 * name. Run AFTER the bulk index rebuild (the `idx_symbols_name` index must exist
 * for the correlated lookup) and after an incremental file write (`file` scopes the
 * update to that file's symbols). Best-effort: the link can dangle until a rescan
 * when an incremental re-index gives the parent a new rowid (an accepted tradeoff).
 */
export function resolveParentIds(db: DB, file?: string): void {
  const sub =
    "(SELECT p.id FROM symbols p WHERE p.name = symbols.scope " +
    "AND p.kind IN ('struct','union','class','enum','typedef') AND p.is_definition = 1 " +
    "ORDER BY (p.kind = 'typedef'), p.id LIMIT 1)";
  if (file) {
    db.prepare(
      `UPDATE symbols SET parent_id = ${sub} WHERE scope != '' AND file_id = (SELECT id FROM files WHERE path = ?)`,
    ).run(file);
  } else {
    db.exec(`UPDATE symbols SET parent_id = ${sub} WHERE scope != ''`);
  }
}

export interface FileMeta {
  hash: string;
  mtime: number;
  parsedBy: SourceKind;
}

export function getFileMeta(db: DB): Map<string, FileMeta> {
  const rows = db.prepare('SELECT path, hash, mtime, parsed_by AS parsedBy FROM files').all() as Row[];
  const m = new Map<string, FileMeta>();
  for (const r of rows) {
    m.set(r.path as string, {
      hash: r.hash as string,
      mtime: Number(r.mtime),
      parsedBy: r.parsedBy as SourceKind,
    });
  }
  return m;
}

/** Escape a single char as a literal inside a LIKE pattern (ESCAPE '\'). */
function likeEscapeChar(ch: string): string {
  return ch === '%' || ch === '_' || ch === '\\' ? '\\' + ch : ch;
}

/**
 * Distinct (name, kind) whose name contains `term` as a case-insensitive
 * subsequence, bounded by `cap` (shortest names first so the cap keeps the most
 * relevant). Powers F10: SQLite does the candidate scan and the JS fzf ranker
 * (`fuzzyFilterSymbols`) orders the bounded result. The subsequence LIKE pattern
 * `%c1%c2%…%` is never stricter than the JS matcher, so no valid match is dropped
 * except by the cap. Empty `term` returns no candidates.
 */
export function searchSymbolNames(
  db: DB,
  term: string,
  opts?: { kinds?: readonly SymbolKind[]; cap?: number },
): { name: string; kind: SymbolKind; dataType: string; file: string; line: number; col: number }[] {
  if (term.length === 0) {
    return [];
  }
  const cap = opts?.cap ?? 2000;
  // Subsequence LIKE: %c1%c2%…% — matches names containing the chars in order
  // (LIKE is ASCII-case-insensitive, matching the JS fuzzy matcher).
  const pattern = '%' + [...term].map(likeEscapeChar).join('%') + '%';
  const { clause, params } = kindFilter(opts?.kinds);
  const sql =
    `SELECT s.name AS name, s.kind AS kind, s.data_type AS dataType, MAX(s.is_definition), f.path AS file, s.line AS line, s.col AS col FROM symbols s ` +
    `JOIN files f ON s.file_id = f.id ` +
    `WHERE s.name != '' AND s.name LIKE ? ESCAPE '\\'${clause} ` +
    `GROUP BY s.name, s.kind ` +
    `ORDER BY LENGTH(s.name) LIMIT ?`;
  const rows = db.prepare(sql).all(pattern, ...params, cap) as Row[];
  return rows.map((r) => ({
    name: r.name as string,
    kind: r.kind as SymbolKind,
    dataType: (r.dataType as string | null) ?? '',
    file: r.file as string,
    line: Number(r.line),
    col: Number(r.col),
  }));
}

export function countSymbolsForFile(db: DB, file: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = ?').get(file) as Row;
  return Number(row.n);
}

/** Total symbol rows across the whole index (for the status-bar indicator). */
export function countSymbols(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as Row;
  return Number(row.n);
}
