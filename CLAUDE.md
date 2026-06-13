# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Greenfield. The repo is currently empty and being scaffolded per the agreed plan
(`~/.claude/plans/swift-enchanting-frost.md`). This file documents the **intended**
architecture and commands — update it as real code lands and verify commands against
`package.json` once it exists.

## What this is

**Sintra** is a VSCode extension that replaces Source Insight for navigating embedded
C/C++ code. It builds a **name-based** symbol index with tree-sitter — no compiler, no
preprocessor — so it works where the Microsoft C/C++ extension's IntelliSense fails:
heavy macros and non-standard ARM-family compilers.

User-facing features:
- **F12** → go to definition (uses our index only)
- **F10** → fuzzy symbol search (includes goto labels)
- **Relations** sidebar view: Symbol / Definition / Declaration / Called by / Calls / Reference

## Commands (intended — confirm against package.json)

- Build: `npm run build` (esbuild bundle) · Watch: `npm run watch`
- Lint: `npm run lint`
- Headless indexer tests: `npm test` · single test: filter by name (e.g. `npm test -- -t "<name>"`)
- Run the extension: press **F5** in VSCode → Extension Development Host
- Package a .vsix: `npx vsce package`

## Architecture (big picture)

The cardinal rule: **keep vscode-API code separate from the pure indexer** so the indexer
is headless-testable without launching VSCode.

- **Indexer** (`src/indexer`, pure, no vscode dependency): web-tree-sitter (WASM) parsing.
  A single `TreeCursor` walk over each file produces a `FileIndex { symbols, calls, references }`.
  - `comment` nodes are **skipped** — identifiers inside comments are NOT indexed.
  - `#if 0 ... #endif` is parsed as ordinary code, so symbols inside it **ARE** indexed.
    This is intentional (a known, accepted limitation).
  - The walk maintains an **enclosing-function stack** so every call/reference knows its
    owning function — this is what powers the "Called by" relation.
- **IndexStore** (`src/store`): global `Map<name, entries>` (definitions/declarations),
  reference and call-edge maps, plus a **per-file reverse index** so an incremental update
  replaces just one file's contributions. Persisted to workspace storage; invalidated by
  file mtime/hash so a restart only re-parses changed files.
- **Bulk initial indexing runs in a `worker_threads` worker** to keep the UI responsive;
  incremental single-file updates (file watcher / in-editor edits, debounced) run on the
  extension host.
- **Features** (`src/features`):
  - `definition` — F12 **dedicated command**, deliberately NOT a vscode `DefinitionProvider`.
  - `fuzzySearch` — F10 QuickPick with a custom fuzzy filter and result cap (large indexes).
  - `relationsView` — `TreeDataProvider` that follows the cursor with a debounce.

## Key design decisions / gotchas

- **Name-based, not semantic.** No type/scope/overload resolution, no macro expansion.
  This mirrors Source Insight's fuzzy DB and is exactly why it tolerates non-compilable
  embedded code. Do **not** add compiler-based resolution. C++ is supported by name only
  (no overload/namespace disambiguation).
- **F12 is a dedicated keybinding command, not a `DefinitionProvider`.** Registering a
  provider would make VSCode *merge* our results with the MS C/C++ extension's (the source
  of the original broken jumps). Users are advised to disable MS IntelliSense.
- **F12/F10 collide with VSCode defaults** (Go to Definition / debug Step Over + menu focus).
  `when` clauses exclude debug mode; both keys are user-rebindable in `keybindings.json`.
- **tree-sitter grammars ship as WASM** in `resources/grammars` (copied to `dist` at build
  time), not native node bindings — avoids per-platform/arch native compilation.
