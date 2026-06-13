# C/C++ Blitz

Source Insight–style C/C++ code navigation for VS Code, built for **embedded
codebases** where the Microsoft C/C++ extension's IntelliSense struggles (heavy
macros, non-standard ARM-family compilers).

It builds a **name-based** symbol index with [tree-sitter](https://tree-sitter.github.io/)
— no compiler, no preprocessor — so navigation keeps working even when code
doesn't compile in a standard toolchain. (Internal/package name: `sintra`.)

## Features

- **F12 — Go to Definition.** Jumps using our index only. The built-in **F12 /
  Ctrl+Click / Peek / right-click "Go to Definition"** all resolve through our index —
  so **disable the MS C/C++ extension's IntelliSense**, or VS Code merges its results
  with ours. A never-merging **C/C++ Blitz: Go to Definition** command is also available
  in the Command Palette. If a name has several definitions you get a picker (or a native
  peek).
- **F10 — Search Symbols.** Fuzzy search over every symbol, **including goto
  labels** (functions, prototypes, variables, macros, typedefs, struct/union/
  enum, enum constants, labels, and basic C++ class/namespace/method).
- **Code Insight view** (activity-bar). Follows the cursor and shows, for the
  symbol under it: **Symbol / Type / Definition / Declaration / Called by / Calls /
  References**. The **Symbol** summary expands into the symbol's kind, declared
  type or function signature, storage class, and jump-able definition/declaration
  locations. Click any entry to jump. References are grouped per file with a
  code-line snippet (like *Find All References*); empty categories are hidden by
  default (`cBlitz.codeInsight.hideEmptyCategories`), and each category can be
  toggled via `cBlitz.codeInsight.show.*`.

> F12 and F10 collide with VS Code defaults (Go to Definition / debug Step
> Over). The bindings are guarded (`!inDebugMode` for F10) and fully
> rebindable in your `keybindings.json`. For the cleanest F12, disable the MS
> C/C++ extension's IntelliSense.

## How it works

- A **pool of background worker threads** (default 8, `cBlitz.indexing.workerCount`)
  parses files with tree-sitter in parallel and writes to an **on-disk SQLite**
  database via Node's built-in `node:sqlite` (WAL — no native module to build or
  rebuild). The extension host only reads. The
  initial-index notification shows live progress — `done/total` files and elapsed
  time. References for a ~300 MB codebase can be tens of millions of rows — far too
  much for memory — so they live in SQLite and are fetched with indexed point
  queries; only the symbol-name list is held in memory (for F10).
- **Comments are never indexed.** `#if 0 … #endif` blocks **are** indexed (a
  known, intentional limitation — there's no preprocessor).
- **Fallback:** if tree-sitter fails or is low-confidence (parse error,
  unsupported file, timeout, very large file, or too many ERROR nodes), the file
  is indexed with a regex (grep) scanner instead — symbols are still found
  (refs/calls best-effort). Such rows are tagged `source = 'grep'`.
- The index is the cache: on restart only changed/new files are re-parsed
  (mtime diff) and deleted files are dropped.
- **Incremental indexing is visible.** Files added/changed/removed in the
  workspace reindex in the background behind a single coalesced notification
  (count + elapsed). Navigation queries (F12 / F10 / Code Insight) briefly wait
  for an in-flight reindex to settle (bounded by `cBlitz.indexing.deferQueriesMs`)
  so they reflect the latest edits.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `cBlitz.fileExtensions` | `.c .h .cpp .cc .cxx .hpp .hh .hxx .inc` | What to index |
| `cBlitz.exclude` | node_modules/.git/build/out/dist | Glob excludes |
| `cBlitz.codeInsight.debounceMs` | `200` | Cursor-follow delay |
| `cBlitz.codeInsight.hideEmptyCategories` | `true` | Hide categories with no entries for the current symbol |
| `cBlitz.codeInsight.show.*` | `true` | Per-category visibility (symbol/definition/declaration/calledBy/calls/references) |
| `cBlitz.fuzzy.maxResults` | `200` | F10 result cap |
| `cBlitz.parse.maxFileSizeKB` | `2048` | Bigger files use grep (not skipped) |
| `cBlitz.parse.errorRatioThreshold` | `0.25` | ERROR-byte ratio → grep |
| `cBlitz.parse.timeoutMs` | `5000` | Per-file parse timeout → grep |
| `cBlitz.indexing.workerCount` | `8` | Parallel worker threads for the bulk index |
| `cBlitz.indexing.deferQueriesMs` | `1500` | F12/F10/Code Insight wait this long for an in-flight reindex before querying (0 = off) |
| `cBlitz.db.location` | workspace storage | DB dir; absolute path allowed (e.g. a fast/large disk). On Remote-SSH this resolves on the remote host. |

## Develop

```bash
npm install
npm run build        # esbuild -> dist/ (extension.js, worker.js, wasm grammars)
npm test             # headless indexer/store/worker checks (no VS Code)
npm run watch        # rebuild on change
```

Press **F5** to launch an Extension Development Host and open a C/C++ workspace.

## Requirements / Distribution

Storage uses Node's built-in `node:sqlite`, so there is **no native module** —
the `.vsix` is platform-independent and works on Remote-SSH unchanged, with
nothing to rebuild per platform or VS Code version.

`node:sqlite` requires **Node ≥ 22.13**, so the minimum supported VS Code is
**1.99** (Electron 35+). Older VS Code (e.g. 1.98 / Electron 34 / Node 20) does
not ship `node:sqlite` and is not supported. The feature is still flagged
experimental in Node, so VS Code logs a harmless `ExperimentalWarning` on first use.

## Limitations

- Name-based, like Source Insight: no type/overload resolution and no macro
  expansion. Parameters and locals resolve within their function, but member
  access isn't type-resolved — `a->x` lists every struct field named `x`. C++ is
  matched by name only.
- `.h` headers are parsed as C by default (C++-only headers will fall back to
  grep).
- Unsaved-buffer edits re-index on a short debounce; saving is always indexed.
