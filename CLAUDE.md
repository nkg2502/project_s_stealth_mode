# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working agreement (test-first)

**Every change is test-driven.** Before modifying behavior, write a test case that
reproduces the problem and **confirm it actually fails** (red) against the current
code. Only then make the fix, and **confirm the same test now passes** (green). Do not
fix first and test afterward. New behavior, bug fixes, and regressions all follow this
red→green order. Run `npm test` (headless core) and `npm run test:unit` (the broader
live-path unit suite).

## Project status

Implemented: the build, the headless-tested indexing/store/worker core, and the
VS Code integration (F12/F10/Code Insight, worker pool, incremental indexing). Verified
by `npm test` (147 checks) plus `npm run test:unit` (573 pass / 63 skip) and esbuild bundling; `tsc --noEmit`
is clean. **Not yet runtime-verified inside VS Code** — launch with F5 to exercise the UI. See
`README.md` for user-facing docs.

## What this is

**Sintra** is a VSCode extension that replaces Source Insight for navigating embedded
C/C++ code. It uses **tree-sitter for best-effort structural parsing** — aiming to get as
close to a compiler's understanding of the code as possible **without** a compiler or
preprocessor — and **falls back to a name-based index only where heavy macros or
non-standard syntax defeat the parse**. That fallback is why it still works where the
Microsoft C/C++ extension's IntelliSense fails (heavy macros, non-standard ARM-family
compilers), but tree-sitter's parse — not a flat name match — is what we rely on first.

User-facing features:
- **F12** → go to definition (uses our index only)
- **F10** → fuzzy symbol search (includes goto labels)
- **Code Insight** sidebar view (view id `cBlitzRelations`): Symbol / Type / Definition / Declaration / Called by / Calls / References (the **Symbol** category expands into a rich summary — kind, declared type / signature, storage, locations)

## Commands

- Build: `npm run build` (esbuild → `dist/`) · Watch: `npm run watch` · Prod: `npm run package`
- Typecheck: `npm run typecheck` (`tsc --noEmit`)
- Headless tests: `npm test` (builds, then runs `dist/test.js`; vscode-free —
  indexer/store/worker). No name filter; edit `test/run.ts` to focus.
- Run the extension: press **F5** → Extension Development Host
- Package a .vsix: `npx vsce package` (platform-independent — no native module)

## Architecture (big picture)

The cardinal rule: **keep vscode-API code separate from the pure indexer** so the indexer
is headless-testable without launching VSCode.

Source layout: `src/core/` (vscode-free shared model — `types.ts`, `refRole.ts`, `host.ts`,
`indexGate.ts`, `serialIndexRunner.ts`, `indexPlan.ts`), `src/indexer/` (pure parsing +
`defaults.ts`/`exclusionEngine.ts`),
`src/store/` (SQLite + `fuzzyMatch.ts`), `src/features/` (vscode-facing features plus the
vscode-free resolution helpers `callContext.ts` / `typeTag.ts` / `memberAccess.ts` /
`fuzzyQuery.ts`), and `src/extension.ts` at the root (the only entry that wires vscode together).

- **Indexer** (`src/indexer`, pure, no vscode dependency): web-tree-sitter (WASM) parsing.
  A single recursive walk (`extract.ts`) produces a `FileIndex { symbols, refs, calls, locals }`
  plus an ERROR-byte ratio. `indexFile.ts` decides tree-sitter vs the `regexScanner.ts` grep
  fallback (size / parse-null / error-ratio / exception); fallback rows are `source='grep'`.
  - `comment` nodes are **skipped** — identifiers inside comments are NOT indexed.
  - `#if 0 ... #endif` is parsed as ordinary code, so symbols inside it **ARE** indexed.
    This is intentional (a known, accepted limitation).
  - The walk maintains an **enclosing-function stack** so every call/reference knows its
    owning function — this powers "Called by" *and* scope-local definition resolution.
    A **lexical recovery post-pass** (`src/indexer/enclosingFunc.ts`, run before the
    `is_local` classification) backfills calls/refs the walk left at file scope: a
    computed-goto / heavy-macro body (e.g. the eBPF interpreter `___bpf_prog_run`) can make
    tree-sitter close the `function_definition` node early and re-sync the body's tail as
    top-level `labeled_statement`s — not even ERROR nodes, so the error ratio stays low and
    no grep fallback fires — leaving those rows with a `null` caller/`enclosingFunc` (they
    surfaced under "(file scope)"). The function's *brace* boundary in the raw text is
    reliable where the AST node's end isn't, so the pass brace-matches each function body
    (anchored at the AST's reliable header line) and re-attributes any enclosed file-scope
    call/ref. It only fills nulls — an AST-resolved caller is always kept.
  - **Struct/union fields** are indexed as global `field` symbols (so `obj->field` jumps to
    the member declaration), each tagged with the **owning aggregate** (`SymbolRow.scope`, e.g.
    `struct rcu_state {…}` → `rcu_state`) via an enclosing-aggregate stack in `extract.ts`.
    A field also records **its own** declared aggregate type (`SymbolRow.dataType`, e.g.
    `struct Inner_s rtf` → `Inner_s`, pointer stripped) so member access can be walked across a
    multi-hop chain (`outer->rtf.x`) — the field's `dataType` is the next hop's tag.
    A field **use** records the owning aggregate of the object it qualifies, so References can
    narrow to one struct: an `obj->x`/`obj.x` use stores the object chain (`refs.obj_chain`,
    resolved to `refs.owner`); a **designated initializer** `struct T x = { .f = … }` has no
    object — per C §6.7.9 its owner is the *current object* (the aggregate being initialized), which
    `extract.ts:designatorObjectChain` recovers by walking up to the enclosing declaration /
    compound-literal type. It handles the **deterministic** designator cases — `.f`, `.a.b`, and
    nested designated braces `{ .inner = { .f } }` (each step an `initializer_pair` link, emitting
    an `@type:<T>` chain root) — and leaves **positional** nesting (`{ {…}, {…} }`, which needs
    member-ordering state) best-effort (`owner=''`). Without this, a foreign struct's `.data2 = …`
    leaked into an unrelated `raid6_recov_calls.data2`'s references.
    **Parameters and function-body locals** go to `FileIndex.locals` (kept OUT of the global
    `symbols` table) tagged with their enclosing function, so they resolve by name *within that
    function only* and never pollute fuzzy search / global lookups; each also records its declared
    aggregate **`dataType`** (`struct rcu_state *rsp` → `rcu_state`, `rcu_state_t *rsp` →
    `rcu_state_t`). A `typedef <named aggregate> Alias;` is recorded in `FileIndex.aliases`
    (`Alias → tag`). Together these power **type-based member narrowing** (see below).
  - **Every ref carries a structural `role`** (`src/core/refRole.ts` → `roleForNodeType`) taken
    straight from the tree-sitter node type: `value` (`identifier`), `type` (`type_identifier`),
    `field` (`field_identifier`), `label` (`statement_identifier`), `namespace`. This is the
    principled discriminator for resolution — a `value` use can never denote a struct tag or a
    field, a `type` use only an aggregate, etc. `is_local` is just the value-token subset that
    also matches a local. grep-fallback rows have `role=''` (no AST) **except** a member access
    (`obj->x` / `obj.x` / a `{ .x = … }` designator), which the grep scanner can spot from the
    preceding `.`/`->` and tags `role='field'` — the one structural fact text alone makes
    reliable. This lets a field's references exclude same-named plain identifiers in grep files
    (see `findReferences` below).
- **Store** (`src/store/db.ts`): **on-disk SQLite** via Node's built-in `node:sqlite`
  (`DatabaseSync`) — **no native module**, so the same code runs in Electron, on Remote-SSH,
  and under plain Node (headless tests) with nothing to rebuild per runtime. The pool workers
  are the only writers; the host opens a read-only connection. Each worker has its own writable
  WAL connection — WAL permits a single writer at a time, and `busy_timeout` makes the others
  contention is brief). `node:sqlite` has no `.transaction()` / `.pragma()` helpers, so `db.ts`
  wraps BEGIN/COMMIT itself and drives pragmas via `exec`/`prepare`. We use `PRAGMA synchronous = OFF`
  to maximize bulk insert speed since the DB is just a recreateable cache. An incremental update is one transaction — `DELETE … WHERE file=?`
  across files/symbols/refs/calls/**locals** then re-INSERT. The DB *is* the cache; restart re-parses
  only mtime-changed files. **F10 search queries SQLite directly** (no in-memory name list):
  `searchSymbolNames(db, term, {kinds, cap})` fetches a bounded candidate set via a subsequence
  `LIKE '%c1%c2%…%'` (the same set the JS fzf matcher accepts; `_`/`%` escaped), and
  `features/fuzzySearch.ts` ranks it with `fuzzyFilterSymbols` on a debounced keystroke.
  Resolution (`features/resolve.ts`, shared by the command, the
  providers, and the Code Insight view) is **role-based, then scope-aware**. `resolveDefinition`
  reads the `refs` row at the exact cursor position (`refAt` → `{enclosingFunc, isLocal, role}`):
  1. a `value` occurrence bound to a parameter/local (`is_local`) resolves to that local; then
  2. **`resolveByRole`** restricts the global lookup to the symbol kinds the token's `role` admits
     (`src/core/refRole.ts` → `kindsForRole`, pushed into the SQL `kinds` filter): a `value` use →
     {function, global_variable, enumerator, method, macro}; a `type` use → {struct, union, enum,
     class, typedef, macro}; a `field` use → {field, macro}; etc. (`macro` is admissible under
     every role so a macro is never hidden). This is what makes `struct folio *folio` resolve
     correctly **at any scope** — the type tag `folio` (role=type) goes to `struct folio`, the
     variable `folio` (role=value) to the variable — *without* relying on `is_local`, which is 0
     for both at file scope.
  - **Self-guard.** If a same-line declaration of the right kind sits under the cursor, F12 stays
    there instead of jumping to an unrelated same-named symbol elsewhere.
  - **Grep / no-role fallback (`resolveByText`).** When the cursor ref has `role=''` (grep file)
    or there is no recorded ref, structure is unavailable, so the older **name-based heuristics**
    apply: the elaborated type-tag keyword (`src/features/typeTag.ts` → `tagKindBefore`, e.g. `struct
    inode`), call-target narrowing (`src/features/callContext.ts` → `narrowCallTarget`, a bare `name(...)`
    drops same-named `field` hits), and member-access narrowing (`src/features/memberAccess.ts` →
    `narrowByMemberAccess`, `obj->x` prefers fields). On the tree-sitter path the `role` already
    subsumes all three structurally, so these run **only** as the grep fallback.
  - **References are scope-separated *and* role-filtered.** Each `refs` row carries `is_local`
    (set by `extract.ts` after the walk: an occurrence whose name is a parameter/local of its
    function binds to that local). A global symbol's references query `is_local=0`; a local's
    query `is_local=1 AND enclosing_func=?` — so a local `i` in one function never pollutes a
    global `i`'s references. grep-fallback rows are always `is_local=0` (no scope analysis).
    On top of scope, **`findReferences(db, name, role?)` filters by the cursor token's
    structural `role`** — mirroring role-based Go-to-Definition — so references of a `type` tag
    and a same-named `value` use never mix. For `value`/`type`/`label`/`namespace` it keeps
    ambiguous grep rows best-effort (`AND (r.role = ? OR r.role = '')`); but for **`field`** it
    matches the role **exactly** (`AND r.role = ?`, no `OR ''`), because a field is always
    reached via `.`/`->` and the grep scanner now tags those `role='field'` too. This is what
    stops a same-named *local variable* in a grep-parsed file (e.g. a `data2` local in the SiS
    `init301.c`, where every identifier is `role=''`) from polluting a struct field's references.
    `findLocalReferences` needs no role filter (only a `value` token can be `is_local`, so a
    local's refs are already role-homogeneous). NOTE: a grep member access carries `role='field'`
    only for *filtering* — Go-to-Definition still routes grep rows through the text-heuristic
    `resolveByText` (keyed on `source='grep'`, not the role), keeping the AST/grep split intact.
  - **Schema version follows the extension version.** `PRAGMA user_version` stores
    `schemaVersionFor(packageJSON.version)` (semver → int); the host runs `ensureSchema(dbPath, v)`
    once *before spawning the pool* and a mismatch drops/rebuilds the tables. So **bump the
    `version` in package.json** whenever the layout / extraction semantics change. Doing the
    migration on the host also avoids the workers racing on schema creation.
  - **Dev mode (F5) always reindexes:** when `extensionMode === Development`, activation deletes
    the DB file (+`-wal`/`-shm`) and runs a forced full index, so debugging starts clean.
- **Bulk initial indexing uses a Producer-Consumer Worker Architecture** (`workerPool.ts`,
  default 8 parsers, `cBlitz.indexing.workerCount`) to parallelize the CPU-bound tree-sitter parse
  while avoiding SQLite lock contention.
  - **Parser Workers (Producers):** The pool spawns up to the configured count. They round-robin
    files, run tree-sitter, and produce `FileIndex` objects.
  - **Writer Worker (Consumer):** A single dedicated writer thread receives the `FileIndex` payloads
    directly from the Parser Workers via `MessageChannel` (bypassing the Host to avoid UI blocking).
    The Writer Worker buffers incoming parses and performs bulk `BEGIN/COMMIT` inserts (`applyBatch`),
    which completely eliminates SQLite WAL lock thrashing.
  - **Drop/Create Index Strategy (conditional).** `indexAll(files, { rebuildIndexes })` selects the
    insert strategy. For a **from-scratch build** (first index / explicit full Rescan — `doRunIndex`
    passes `rebuildIndexes = forceAll || prevMeta.size === 0`) the non-primary name indexes (e.g.
    string indexes) are dropped before parsing and rebuilt once after, which dramatically improves
    bulk insert speed since indexes aren't updated per row. Integer indexes (like `idx_symbols_file`)
    are preserved so `DELETE FROM symbols WHERE file_id = ?` stays `O(1)`. The post-parse rebuild
    (`flush` + `createIndexes`, which also resolves parents table-wide) has no per-file progress and
    can take a while, so `WorkerPool.onPhase` surfaces a coarse label ("building search index…")
    that `doRunIndex` shows in place of the frozen "N/N files" count.
    For a **small incremental bulk** — notably an `include`/`exclude` change on a warm DB — the
    existing index is **reused**: `rebuildIndexes = false` keeps the name indexes LIVE (inserting a
    handful of files maintains them cheaply), skipping the multi-million-row rebuild that would make
    a tiny change feel like a full rescan. Parents are then re-pointed only for the touched files
    (`writer.resolveParentsFor`) instead of table-wide. Because the indexes stay live, **host reads
    stay available** during this path — only a rebuild run (`bulkDropsIndexes`) flips
    `host.bulkIndexing` to abstain reads (see `extension.ts:updateBusyIndicator`).
  - **Smooth status spinner.** The status-bar `$(sync~spin)` icon's CSS animation restarts on every
    `status.text` change, so a live count sharing the icon's entry would reset the spin on each
    update. Rather than split it into a second status entry (which looked disjointed), the count is
    refreshed on a timer whose period equals the spin's rotation (`SPIN_PERIOD_MS`) so each
    restart lands on a *completed* turn and is invisible; a shorter period snaps the icon back
    mid-rotation and looks janky. (`setBusyStatus(text, tooltip)` prepends the spin icon;
    `showIdleStatus` swaps to the static `$(database)` badge.) The notification's own progress bar —
    no spinning codicon — still updates on every event (`renderNotification`).
  - **Bulk runs are serialized + cancelable (latest wins).** Every bulk index goes through
    `SerialIndexRunner` (`src/core/serialIndexRunner.ts`, vscode-free): a new request (an
    `cBlitz.include`/`cBlitz.exclude` change, or Rescan) calls `pool.cancel()` — a fire-and-forget
    `cancel` message that makes each parser break its `indexAll` loop at the next file boundary —
    then waits for the in-flight run to settle before starting fresh, so the old run **stops**
    instead of running concurrently with the new one. A superseded *pending* request is skipped.
  - **Force-stop.** `cBlitz.stopIndexing` (status-bar menu entry, shown only while a bulk run is
    active) sets a `stopRequested` flag and calls `pool.cancel()`. Unlike a config-change/Rescan it
    does **not** start a fresh run — `doRunIndex` bails out of its remaining `remove`/`indexAll` work
    and keeps the partial index (the next Rescan/edit finishes it). The flag is cleared at the start
    of every `doRunIndex`, so a stray stop never sticks. Stopping a **rebuild** run still pays the
    post-parse index rebuild (the indexes were dropped, so they must be recreated for the partial
    index to be queryable) — that step is reframed as "finishing up — building search index…"
    so it reads as wrapping up, not ignoring the stop, and completes with an info toast ("partial
    index ready (N symbols). Run Rescan to finish."). A stopped **live-index** incremental run has no
    rebuild step, so it finalizes promptly.
  - **Incremental plan is pure + hash-aware.** The decision of what to (re)index vs remove lives in
    the vscode-free `computeIndexPlan` (`src/core/indexPlan.ts`): given the current post-include/exclude
    file set and the DB's per-file meta (`getFileMeta` → mtime + hash), it returns `{toIndex, toRemove}`.
    A new/changed file → `toIndex`; a file that left the set (now-excluded **or** deleted) → `toRemove`
    — this is what makes an `include`/`exclude` change incremental (removing an exclude re-admits its
    files via the absent-from-prev branch; a Rescan still drops vanished files because `prevMeta` is
    read even when `forceAll`). When `cBlitz.indexing.verifyContentHash` is on, an mtime-changed file
    is re-hashed (`indexFile.hashText`) and skipped if byte-identical (avoids re-parsing after a
    mtime-only bump, e.g. `git checkout`); off by default (mtime check only).
  - Incremental single-file updates (file watcher / in-editor edits, debounced) round-robin to a live parser worker.
    Watcher-driven updates surface a single coalesced progress notification (count + elapsed);
    in-editor edits stay status-bar-silent. A vscode-free **`IndexGate`** (`src/core/indexGate.ts`,
    held on `Host.indexing`) brackets every index op with `begin/end`; navigation queries
    (`features/resolve.ts:awaitFreshIndex` → F12 command + Definition/Reference providers + F10)
    `await indexing.whenIdle(cBlitz.indexing.deferQueriesMs)` so a fast in-flight reindex settles
    before they read — zero latency when idle, timeout-bounded when not.
- **Features** (`src/features`):
  - `definition` — the `cBlitz.goToDefinition` **dedicated command** (always registered,
    Command Palette only — no keybinding/menu). `definitionProvider` — an **always-registered**
    vscode `DefinitionProvider` so the built-in F12 / Ctrl+Click / Peek / right-click resolve
    through our index natively.
  - `referenceProvider` — an **always-registered** `ReferenceProvider` for built-in Find All
    References / the References view. The `cBlitz.findReferences`
    command opens the side view then restores editor focus (right-click "Find All References").
  - `fuzzySearch` — F10 QuickPick with a custom fuzzy filter (requires minimum 2 characters), empty name filtering, and result cap (large indexes).
  - `relationsView` — the **Code Insight** `TreeDataProvider` (file/class/view id keep the
    `relations`/`cBlitzRelations` names) following the cursor (debounced); scope-aware
    Definition/Reference, per-category counts, and a **pin** toggle
    (`cBlitz.relationsPinned` context key) that freezes the current symbol. The first
    category, **Symbol**, is a rich headline summary (it replaced the old single-line
    header): it resolves the cursor symbol like F12 (role + member narrowing + self-guard)
    via the vscode-free `features/symbolInfo.ts:resolveSymbolInfo` and expands into detail
    rows — humanized **Kind**, a function's **Signature** (storage + return + declarator),
    **Storage**, and jump-able **Defined in** / **Declared in** locations; it is always shown
    (never hidden by `hideEmptyCategories`) and reads `not found` when the word isn't indexed.
    A variable/field's declared **Type** is intentionally **not** a Symbol detail row — it is
    shown by the dedicated **Type** category just below (which also jumps to the type's
    definition), so duplicating it in the summary is avoided. **Calls /
    Called-by are recursive call trees** — each node lazily expands into its own
    callees/callers via the vscode-free `features/callGraph.ts` (deduped per level;
    a node terminates when its name loops back to an ancestor, i.e. a cycle).
    **References are grouped per file** (Find-All-References style) with a code-line
    snippet read lazily on expand (`features/refGroups.ts`, vscode-free). Each category
    can be shown/hidden live via `cBlitz.codeInsight.show.*`, and empty categories are
    hidden when `cBlitz.codeInsight.hideEmptyCategories` (default on); an
    `onDidChangeConfiguration` listener in `extension.ts` refreshes the view (no reload).
    A bulk/watcher index shows an "Indexing…" header row (`setIndexing`). **During a
    *bulk* scan the view also pauses all its DB reads** (`setIndexing(busy, /*suspendReads*/ bulkActive)`):
    the name indexes are dropped for the bulk insert, so a host-side point query would
    full-scan multi-million-row tables and block the synchronous host thread (up to
    `busy_timeout` = 15s) — which is what froze the progress clock. It shows an
    "Indexing… Code Insight paused" placeholder and resumes (with rebuilt indexes)
    when the scan finishes. `showMenu` likewise skips its `COUNT(*)` while `bulkActive`.
  - The status-bar item (`cBlitz.showMenu`, far-right) opens a quick menu (Stop indexing — only
    while a bulk run is active — / Rescan / Search / Show log; the Rescan entry shows the last scan's
    duration) and otherwise shows the live symbol count.

## Key design decisions / gotchas

- **tree-sitter structural best-effort, name-based fallback.** *(Direction — guidance for future
  work; supersedes the older "fundamentally name-based" framing.)* The index was originally treated
  as **fundamentally name-based** (mirroring Source Insight's fuzzy DB) because tree-sitter's
  reliability on gnarly embedded code was unproven. It has proven solid, so the **goal now is to get
  as close to a compiler's result as tree-sitter's AST allows** — lean on *structure* (a call site
  vs a struct field, a declaration vs a use, lexical scope, the enclosing function) instead of
  matching bare names — and fall back to the **name-based / grep index only where complex syntax or
  the preprocessor defeats the parse**. This is **not** license to add a real compiler, preprocessor,
  macro expansion, or type system: there is still none of that, and the code must keep tolerating
  non-compilable embedded sources. Two narrow, *heuristic* (non-compiler) refinements already follow
  this spirit and stay:
  - **Lexical scope-awareness:** a parameter/local resolves within its enclosing function (by
    name + function, via the `locals` table).
  - **Type-based member narrowing (live, headless):** for a `field`-role token reached via
    `obj->`/`obj.`, `features/resolve.ts:narrowFieldsByType` **walks the member chain**
    (`memberAccess.ts:extractMemberChain` → `outer->rtf.x` = `['outer','rtf']`) hop by hop: the
    root's type comes from its local/parameter `dataType` (`locals` table), and each intermediate
    field's type from that field's own `dataType` (`symbols.data_type`); the final hop keeps only
    the same-named `field` symbols whose owning tag (`symbols.scope`) matches. Each hop matches the
    tag by a direct match, a **typedef alias** (`typedef struct rcu_state_s {…} rcu_state_t;` →
    `findTypedefTarget('rcu_state_t')` = `rcu_state_s`), then the `_t`→`_s`/`_e`/`_u` suffix
    heuristic. When a hop cannot be resolved (or nothing matches) it **falls back to every field
    named `x`** — best-effort name/heuristic resolution, never type checking or overload
    resolution. This runs only on the tree-sitter path (it needs `scope`/`dataType`/aliases); the
    grep fallback uses the older kind-based `narrowByMemberAccess`.

  C++ is supported by name only (no overload disambiguation); scope/`qualifiedName` are captured
  for members, methods, namespaces and enumerators but used only as hints, not for semantic
  binding.
- **SQLite is the single source of truth.** All indexed content belongs in the SQLite store; the
  in-memory / live layer is a **thin presentation layer** over it (formatting, ordering, display
  niceties) — *not* a second, separately-maintained copy of the data or a parallel lookup path.
  The old in-memory fuzzy name list (`nameIndex.ts`) was the last such parallel structure and has
  been **retired**: F10 now queries SQLite directly (`searchSymbolNames`; see the Store section).
  Going forward: prefer querying SQLite (adding indexes as needed) over building parallel in-memory
  caches, and reach for an in-memory structure only when it is purely a view/format over what
  SQLite already holds.
- **Go to Definition: always-on provider + a palette fallback.** VSCode *merges* results across
  all `DefinitionProvider`s, so our provider is only sound once MS C/C++ IntelliSense is disabled
  — which is a project requirement. We therefore **always register** the `DefinitionProvider` (and
  `ReferenceProvider`) for native F12 / Ctrl+Click / Peek / right-click, and **also** keep the
  never-merging dedicated command `cBlitz.goToDefinition` available in the Command Palette (no
  keybinding/menu, so it can't duplicate the native F12). There is no longer a setting to toggle
  the providers off — they were `cBlitz.registerDefinitionProvider` / `registerReferenceProvider`,
  removed as redundant since disabling MS IntelliSense is already required.
- **F10 collides with a VSCode default** (debug Step Over + menu focus). Its `when` clause excludes
  debug mode; the key is user-rebindable in `keybindings.json`. (F12 has no custom keybinding —
  the always-on provider serves native Go to Definition.)
- **tree-sitter grammars ship as WASM** (prebuilt `.wasm` bundled inside the `tree-sitter-c` /
  `tree-sitter-cpp` packages → `dist/grammars/` at build time), not native bindings — portable
  across platforms. The grammar WASM ABI must match the runtime: `web-tree-sitter` ≥ 0.26 needs
  grammars built by a modern tree-sitter-cli (the old `tree-sitter-wasms` package built them with
  cli 0.20.x and fails to load under 0.26 — see tree-sitter#5171). The runtime wasm is
  `web-tree-sitter.wasm` in 0.26 (it was `tree-sitter.wasm` in 0.25). The CJS bundle needs an
  `import.meta.url` shim (esbuild `define` + `banner`) for web-tree-sitter to load.
- **No native modules.** Storage uses Node's built-in `node:sqlite` (the old `better-sqlite3`
  was removed: it's V8-ABI-coupled, has no prebuilt for recent Electron, and a single binary
  can't span VS Code versions). `node:sqlite` needs **Node ≥ 22.13**, which is why
  `engines.vscode` is `^1.99.0` — older VS Code (e.g. 1.98 / Electron 34 / Node 20) lacks it.
  The `.vsix` is platform-independent (no per-arch/per-Electron builds, no `@electron/rebuild`).
  `node:sqlite` is still flagged experimental: it prints an `ExperimentalWarning` (harmless) and
  its API could shift — pin behavior in `db.ts` if it does.
