import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Host } from './core/host';
import { SerialIndexRunner } from './core/serialIndexRunner';
import { computeIndexPlan } from './core/indexPlan';
import { hashText } from './indexer/indexFile';
import { WorkerPool } from './indexer/workerPool';
import type { Progress } from './indexer/workerClient';
import type { IndexOptions } from './indexer/indexFile';
import { countSymbols, ensureSchema, getFileMeta, openDb, schemaVersionFor } from './store/db';
import type { FileMeta } from './store/db';
import { registerDefinition } from './features/definition';
import { registerDefinitionProvider } from './features/definitionProvider';
import { registerReferenceProvider } from './features/referenceProvider';
import { registerFuzzySearch } from './features/fuzzySearch';
import { RelationsProvider } from './features/relationsView';
import { revealLocationBeside, wordRangeAt } from './features/nav';
import { symbolContextAt } from './features/memberAccess';
import { isHardKeyword } from './indexer/defaults';
import { ExclusionEngine } from './indexer/exclusionEngine';

// VS Code's $(sync~spin) codicon completes one rotation in this period. Refreshing
// the status text (which restarts the spin animation) on this exact cadence makes
// the restart coincide with a finished turn, so the icon never visibly snaps back
// mid-rotation. A shorter period resets the icon partway through and looks janky;
// nudge this if the spin still appears to stutter on a given VS Code build.
const SPIN_PERIOD_MS = 1000;

let host: Host | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('C/C++ Blitz');
  context.subscriptions.push(output);

  // Persistent indexing indicator. Unlike a notification toast (which other
  // extensions' notifications — e.g. Git — stack over and which vanishes the
  // moment the task ends), a status-bar item stays put for the whole run.
  // Far-right placement among left items: Left alignment with a low priority
  // keeps it at the very right edge among the left-aligned items.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -10000);
  status.name = 'C/C++ Blitz';
  status.command = 'cBlitz.showMenu';
  context.subscriptions.push(status);
  // Busy status: the $(sync~spin) icon shares this single entry with the live
  // count. VS Code restarts the icon's CSS spin animation on every text change, so
  // the count/elapsed is refreshed only on a timer whose period matches the spin's
  // rotation (see SPIN_PERIOD_MS) — restarting in step with a completed turn makes
  // the reset invisible, instead of snapping the icon back mid-rotation.
  function setBusyStatus(text: string, tooltip: string): void {
    status.text = `$(sync~spin) ${text}`;
    status.tooltip = tooltip;
    status.show();
  }
  let inflight = 0; // incremental reindex ops in flight
  let bulkActive = false; // a bulk/full index is running
  // True only while a bulk run that DROPS the name indexes is active (a from-scratch
  // build / full Rescan). That's the only time host reads are unsafe (they'd
  // full-scan the unindexed tables); a live-index incremental bulk keeps reads on.
  let bulkDropsIndexes = false;
  let stopRequested = false; // user asked to force-stop the in-flight bulk index
  let lastScanMs: number | undefined; // wall-clock time of the most recent scan
  // Coalesced progress for watcher-driven incremental indexing: a burst of file
  // events shares one notification rather than spawning one per file.
  let incTotal = 0;
  let incDone = 0;
  let incStart = 0;
  let incResolve: (() => void) | undefined;

  function currentSymbolCount(): number {
    try {
      const db = host?.getDb();
      return db ? countSymbols(db) : 0;
    } catch {
      return 0;
    }
  }

  // Idle state: keep the status bar visible showing the current symbol count
  // (or "no index"), so it's always obvious whether the index is populated.
  // Click reindexes the workspace.
  function showIdleStatus(): void {
    if (bulkActive || inflight > 0) {
      return; // an active spinner is showing; don't clobber it
    }
    const n = currentSymbolCount();
    if (n > 0) {
      status.text = `$(database) C/C++ Blitz: ${n.toLocaleString()} symbols`;
      status.tooltip = 'C/C++ Blitz index — click to reindex the workspace';
    } else {
      status.text = '$(database) C/C++ Blitz: no index';
      status.tooltip = 'No symbols indexed — click to index the workspace';
    }
    status.show();
  }

  const cfg = vscode.workspace.getConfiguration('cBlitz');
  const exts = cfg.get<string[]>('fileExtensions', [
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.inc',
  ]);

  const debounceMs = cfg.get<number>('codeInsight.debounceMs', 200);
  const workerCount = Math.max(1, Math.min(32, cfg.get<number>('indexing.workerCount', 8)));
  const options: Partial<IndexOptions> = {
    maxFileSizeBytes: cfg.get<number>('parse.maxFileSizeKB', 2048) * 1024,
    errorRatioThreshold: cfg.get<number>('parse.errorRatioThreshold', 0.25),
    parseTimeoutMicros: cfg.get<number>('parse.timeoutMs', 5000) * 1000,
  };

  const extGlob = `**/*.{${exts.map((e) => e.replace(/^\./, '')).join(',')}}`;

  const exclusionEngine = new ExclusionEngine();
  function updateExclusions() {
    const currentCfg = vscode.workspace.getConfiguration('cBlitz');
    const incRaw = currentCfg.get('include', []);
    const excRaw = currentCfg.get('exclude', []);
    const includePatterns = Array.isArray(incRaw) ? incRaw : (typeof incRaw === 'string' ? [incRaw] : []);
    const excludePatterns = Array.isArray(excRaw) ? excRaw : (typeof excRaw === 'string' ? [excRaw] : []);
    exclusionEngine.setIncludeExclude(includePatterns, excludePatterns);
  }
  updateExclusions();

  function isExcluded(fsPath: string): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return false;
    for (const folder of folders) {
      const rel = path.relative(folder.uri.fsPath, fsPath);
      // If rel does not start with '..' and is not absolute, fsPath is inside this folder.
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        // The engine tests both `rel` and a `<folderName>/rel` variant (so a
        // pattern like `**/linux-src/**` can match the workspace folder name),
        // evaluating the rule set once so the gitignore last-match precedence
        // (a later include re-admits an excluded path) is correct.
        if (exclusionEngine.isExcludedInFolder(rel, path.basename(folder.uri.fsPath))) {
          return true;
        }
      }
    }
    return false;
  }

  const dbPath = computeDbPath(context, cfg);
  output.appendLine(`[C/C++ Blitz] db: ${dbPath}`);

  // When debugging via F5 (Extension Development Host), always start clean:
  // delete any existing DB so every launch performs a full reindex.
  const devMode = context.extensionMode === vscode.ExtensionMode.Development;
  if (devMode) {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(dbPath + ext, { force: true });
      } catch {
        // ignore — best effort
      }
    }
    output.appendLine('[C/C++ Blitz] dev mode (F5): deleted existing DB, will fully reindex');
  }

  // Create/upgrade the schema up front. A version mismatch wipes the stale DB so
  // we rebuild rather than query an incompatible layout.
  try {
    const extVersion = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
    const { recreated } = ensureSchema(dbPath, schemaVersionFor(extVersion));
    if (recreated) {
      output.appendLine(`[C/C++ Blitz] schema/version changed (${extVersion}): rebuilt index from scratch`);
    }
  } catch (e) {
    output.appendLine(`[C/C++ Blitz] schema setup failed: ${(e as Error)?.message ?? e}`);
  }

  const extDir = context.extensionUri.fsPath;
  const assets = {
    runtimeWasmPath: path.join(extDir, 'dist', 'tree-sitter.wasm'),
    grammarPaths: {
      c: path.join(extDir, 'dist', 'grammars', 'tree-sitter-c.wasm'),
      cpp: path.join(extDir, 'dist', 'grammars', 'tree-sitter-cpp.wasm'),
    },
  };

  host = new Host(dbPath, output);
  const pool = new WorkerPool(path.join(extDir, 'dist', 'worker.js'), dbPath, assets, options, workerCount);
  host.worker = pool;
  const indexing = host.indexing; // barrier that lets queries wait out a reindex
  // Serialize bulk index runs: a new request (include/exclude change, rescan)
  // cancels the in-flight run and starts fresh instead of running concurrently.
  const indexRunner = new SerialIndexRunner(() => pool.cancel());

  const relations = new RelationsProvider(host);
  // Reflect indexing state (bulk + watcher incremental, NOT live typing) in the
  // view's "Indexing…" header.
  // The header shows for any index activity; `bulkActive` also pauses the view's
  // DB reads (a bulk scan drops the name indexes, so a query would full-scan).
  const updateBusyIndicator = (): void => {
    // Reads are only unsafe while a bulk run has the name indexes DROPPED — then a
    // host point query would full-scan the unindexed, write-locked tables and
    // freeze the UI, so F12/F10/Definition/Reference all abstain (see Host.getDb)
    // and the Code Insight view shows a "paused" placeholder via suspendReads. A
    // live-index incremental bulk (include/exclude tweak on a warm DB) keeps the
    // indexes, so reads stay available throughout.
    const readsUnsafe = bulkActive && bulkDropsIndexes;
    if (host) {
      host.bulkIndexing = readsUnsafe;
    }
    relations.setIndexing(bulkActive || inflight > 0, readsUnsafe);
  };
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('cBlitzRelations', relations),
  );
  // The dedicated command stays available in the Command Palette. The built-in
  // F12 / Ctrl+Click / Peek / right-click "Go to Definition" and Find All
  // References always resolve through our index via the providers below — this
  // assumes the Microsoft C/C++ extension's IntelliSense is disabled (a project
  // requirement), otherwise VS Code merges its results with ours.
  registerDefinition(context, host);
  registerDefinitionProvider(context, host);
  registerReferenceProvider(context, host);
  registerFuzzySearch(context, host);

  context.subscriptions.push(
    vscode.commands.registerCommand('cBlitz.openLocation', (file: string, line: number, col: number) =>
      revealLocationBeside(file, line, col),
    ),
    vscode.commands.registerCommand('cBlitz.refreshRelations', () => relations.refresh()),
    vscode.commands.registerCommand('cBlitz.reindexWorkspace', () => runIndex(true)),
    vscode.commands.registerCommand('cBlitz.stopIndexing', () => stopIndexing()),
    vscode.commands.registerCommand('cBlitz.showMenu', () => showMenu()),
    vscode.commands.registerCommand('cBlitz.pinRelations', () => relations.setPinned(true)),
    vscode.commands.registerCommand('cBlitz.unpinRelations', () => relations.setPinned(false)),
    vscode.commands.registerCommand('cBlitz.findReferences', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      const selection = ed.selection;
      const viewColumn = ed.viewColumn;
      // Populate the References side view, then return focus to the editor at
      // the original cursor position.
      await vscode.commands.executeCommand('references-view.findReferences');
      await vscode.window.showTextDocument(ed.document, { viewColumn, selection, preserveFocus: false });
    }),
  );
  relations.setPinned(false); // initialize the pin toggle context key

  // The status-bar item opens this quick menu; "Rescan" is a distinct entry.
  async function showMenu(): Promise<void> {
    // Don't run COUNT(*) on the host during a bulk scan — the name indexes are
    // dropped and the writer holds the DB, so it would block (exactly when the
    // user may be opening this menu to hit "Stop indexing").
    const symbols = bulkActive ? undefined : currentSymbolCount();
    const items: (vscode.QuickPickItem & { run: () => void })[] = [];
    if (bulkActive) {
      items.push({
        label: '$(stop-circle) Stop indexing',
        detail: 'Cancel the in-progress scan (the next Rescan finishes it)',
        run: () => stopIndexing(),
      });
    }
    items.push(
      {
        label: '$(sync) Rescan workspace',
        description: lastScanMs !== undefined ? `last scan ${fmtDuration(lastScanMs)}` : undefined,
        detail: 'Re-index every file from scratch',
        run: () => void runIndex(true),
      },
      {
        label: '$(search) Search symbols',
        detail: 'Fuzzy symbol search (F10)',
        run: () => void vscode.commands.executeCommand('cBlitz.fuzzySymbolSearch'),
      },
      {
        label: '$(output) Show log',
        detail: 'Open the C/C++ Blitz output channel',
        run: () => output.show(),
      },
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: symbols !== undefined
        ? `C/C++ Blitz — ${symbols.toLocaleString()} symbols indexed`
        : 'C/C++ Blitz — indexing…',
      placeHolder: 'Choose an action',
    });
    pick?.run();
  }

  // Relations follows the cursor (debounced).
  const followCursor = debounce(() => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isCcpp(ed.document)) {
      return;
    }
    const range = wordRangeAt(ed.document, ed.selection.active);
    if (range) {
      const word = ed.document.getText(range);
      // Use the HARD keyword set (real keywords + standard literal macros like NULL/
      // TRUE/FALSE/EOF + std types), matching memberAccess/indexing — so e.g. NULL is
      // treated as a keyword and not looked up as a user symbol. Soft type-macros
      // (BOOL, UINT, …) still pass through to the index.
      if (isHardKeyword(word)) {
        relations.setKeyword(word);
        return;
      }
      // Capture the member-access context (`node->head` → objectName/memberChain) so
      // the Code Insight Definition row resolves structurally, the same way F12 does.
      const member = symbolContextAt(ed.document, ed.selection.active);
      relations.setCurrent({
        name: word,
        file: ed.document.uri.fsPath,
        line: range.start.line,
        col: range.start.character,
        isMemberAccess: member.isMemberAccess,
        objectName: member.objectName,
        memberChain: member.memberChain,
        callArity: member.callArity,
      });
    } else {
      relations.setCurrent(undefined);
    }
  }, debounceMs);
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => followCursor()),
    vscode.window.onDidChangeActiveTextEditor(() => followCursor()),
  );

  // Code Insight category visibility / hide-empty takes effect immediately — no reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cBlitz.codeInsight')) {
        relations.refresh();
      }
      if (e.affectsConfiguration('cBlitz.include') || e.affectsConfiguration('cBlitz.exclude')) {
        updateExclusions();
        void runIndex(false);
      }
    }),
  );

  // Incremental indexing. SQLite is the source of truth (F10 queries it
  // directly), so after an index update we only refresh the Code Insight view.
  const refreshView = debounce(() => {
    relations.refresh();
  }, 500);
  // Status-bar spinner with a running count/elapsed while changed files reindex.
  function renderIncStatus(): void {
    setBusyStatus(
      `C/C++ Blitz: indexing ${incDone}/${incTotal} · ${fmtElapsed(Date.now() - incStart)}`,
      'Indexing changed files',
    );
  }
  // One coalesced notification for a burst of watcher events; it lives until the
  // incremental queue drains (inflight === 0).
  function ensureIncrementalNotification(): void {
    if (incResolve || bulkActive) {
      return; // already showing, or the bulk notification owns the screen
    }
    incStart = Date.now();
    const done = new Promise<void>((resolve) => {
      incResolve = resolve;
    });
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'C/C++ Blitz: indexing changed files', cancellable: false },
      async (progress) => {
        const tick = setInterval(() => {
          progress.report({ message: `${incDone}/${incTotal} files · ${fmtElapsed(Date.now() - incStart)}` });
        }, 250);
        progress.report({ message: `${incDone}/${incTotal} files` });
        try {
          await done;
        } finally {
          clearInterval(tick);
        }
      },
    );
  }
  function finishIncrementalNotification(): void {
    incResolve?.();
    incResolve = undefined;
  }
  // Track a watcher-driven incremental op: notification + status + the deferral
  // gate (so navigation queries wait it out and read fresh results).
  function trackIncremental<T>(p: Promise<T>): Promise<T> {
    indexing.begin();
    inflight++;
    incTotal++;
    updateBusyIndicator();
    if (!bulkActive) {
      ensureIncrementalNotification();
      renderIncStatus();
    }
    return p.finally(() => {
      inflight = Math.max(0, inflight - 1);
      incDone++;
      indexing.end();
      updateBusyIndicator();
      if (inflight === 0) {
        finishIncrementalNotification();
        incTotal = 0;
        incDone = 0;
        if (!bulkActive) {
          showIdleStatus();
        }
      } else if (!bulkActive) {
        renderIncStatus();
      }
    });
  }
  const watcher = vscode.workspace.createFileSystemWatcher(extGlob);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((u) => {
      if (!isExcluded(u.fsPath)) void trackIncremental(pool.reindex(u.fsPath)).then(refreshView);
    }),
    watcher.onDidChange((u) => {
      if (!isExcluded(u.fsPath)) void trackIncremental(pool.reindex(u.fsPath)).then(refreshView);
    }),
    // Deletes are applied unconditionally (no isExcluded gate): removing stale
    // rows for a now-gone file is always safe, even if it became excluded.
    watcher.onDidDelete((u) => void trackIncremental(pool.remove(u.fsPath)).then(refreshView)),
  );
  // In-editor edits run through the gate (so F12 after a keystroke reflects the
  // edit) but stay status-bar-silent — no notification per keystroke.
  const liveReindex = debounce((doc: vscode.TextDocument) => {
    if (isExcluded(doc.uri.fsPath)) return;
    void indexing.track(pool.reindexContent(doc.uri.fsPath, doc.getText(), Date.now())).then(refreshView);
  }, 600);
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isCcpp(e.document)) {
        liveReindex(e.document);
      }
    }),
  );

  // User-triggered force stop: cancel the in-flight bulk parse at the next file
  // boundary (pool.cancel) and tell doRunIndex to bail out of its remaining work.
  // Unlike a config-change/Rescan — which cancels then starts a fresh run — this
  // just stops; the partial index is completed by the next Rescan/edit. doRunIndex
  // clears the flag at the start of every run, so a stray stop never sticks.
  function stopIndexing(): void {
    if (!bulkActive) {
      return; // only the long bulk run is stoppable; incremental edits are tiny
    }
    stopRequested = true;
    pool.cancel();
    setBusyStatus('C/C++ Blitz: stopping…', 'Stopping — finishing up the current index');
  }

  // Route every bulk index through the serial runner so a new request supersedes
  // (and cancels) an in-flight one rather than running both at once.
  function runIndex(forceAll: boolean): Promise<void> {
    return indexRunner.request(() => doRunIndex(forceAll));
  }

  async function doRunIndex(forceAll: boolean): Promise<void> {
    stopRequested = false; // a fresh run never inherits a prior stop request
    const currentCfg = vscode.workspace.getConfiguration('cBlitz');
    const incRaw = currentCfg.get('include', []);
    const excRaw = currentCfg.get('exclude', []);
    const includeConfig = Array.isArray(incRaw) ? incRaw : (typeof incRaw === 'string' ? [incRaw] : []);
    const excludeConfig = Array.isArray(excRaw) ? excRaw : (typeof excRaw === 'string' ? [excRaw] : []);
    const excludeGlob = excludeConfig.length ? `{${excludeConfig.join(',')}}` : undefined;

    const scanStart = Date.now();
    // With any include set, an include may re-admit a path the native findFiles
    // exclude would drop, so we can't pre-filter — scan all matching files and let
    // isExcluded (the gitignore engine) decide. Without includes, the exclude glob
    // is exact, so hand it to findFiles to skip excluded files up front.
    const findExcludeGlob = includeConfig.length > 0 ? undefined : excludeGlob;
    const uris = await vscode.workspace.findFiles(extGlob, findExcludeGlob);
    const files = uris.map((u) => u.fsPath).filter((p) => !isExcluded(p));
    // The incremental plan: new/changed files → (re)index, vanished/now-excluded
    // files → remove. Read prevMeta even for a forced rescan so a full Rescan
    // also drops files deleted on disk. Optional content-hash verification skips
    // re-parsing a touched-but-identical file.
    const prevMeta = readPrevMeta(dbPath);
    const verifyHash = currentCfg.get<boolean>('indexing.verifyContentHash', false);
    const { toIndex, toRemove } = computeIndexPlan(files, prevMeta, mtimeOf, {
      forceAll,
      hashOf: verifyHash ? hashOfFile : undefined,
    });
    output.appendLine(
      `[C/C++ Blitz] scan: ${files.length} files matched · ${toIndex.length} to (re)index · ${toRemove.length} to remove`,
    );

    // Nothing changed since last run: don't flash a notification that instantly
    // closes — just refresh the idle indicator. (Common case on a warm index.)
    if (!toIndex.length && !toRemove.length) {
      output.appendLine(`[C/C++ Blitz] index up to date (${files.length} files)`);
      lastScanMs = Date.now() - scanStart;
      showIdleStatus();
      return;
    }

    // Only a from-scratch build (first index / explicit full Rescan) drops the
    // name indexes and rebuilds them once. Everything else — notably an
    // include/exclude change on a warm DB — reuses the existing index and keeps
    // the indexes live so the change stays incremental (no whole-table rebuild).
    const useBulkRebuild = forceAll || prevMeta.size === 0;

    bulkActive = true;
    bulkDropsIndexes = useBulkRebuild;
    indexing.begin();
    updateBusyIndicator();
    setBusyStatus(
      `C/C++ Blitz: indexing 0/${toIndex.length.toLocaleString()}`,
      'C/C++ Blitz is indexing the workspace',
    );
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'C/C++ Blitz: indexing', cancellable: false },
        async (progress) => {
          const start = Date.now();
          for (const p of toRemove) {
            if (stopRequested) {
              return;
            }
            await pool.remove(p);
          }
          if (stopRequested || !toIndex.length) {
            return;
          }
          let reported = 0;
          let cur: Progress = { done: 0, total: toIndex.length };
          // After parsing, the pool reports a coarse phase (index rebuild) that
          // has no per-file count — show it instead of a frozen "N/N files".
          let phase: string | undefined;
          // The shared message. While a stop is finalizing, prefix the phase so the
          // wait reads as "wrapping up because you stopped" rather than as the stop
          // being ignored. `forStatus` drops the "files" word to keep it compact.
          const fmtMsg = (forStatus: boolean): string => {
            const elapsed = fmtElapsed(Date.now() - start);
            if (phase) {
              return `${stopRequested ? 'finishing up — ' : ''}${phase} · ${elapsed}`;
            }
            const counts = `${cur.done.toLocaleString()}/${cur.total.toLocaleString()}`;
            return forStatus ? `${counts} · ${elapsed}` : `${counts} files · ${elapsed}`;
          };
          // The notification's progress bar has no spinning icon to stutter, so it
          // can update on every event — keeping the % bar smooth.
          const renderNotification = (): void => {
            const increment = !phase && cur.total > 0 ? ((cur.done - reported) / cur.total) * 100 : 0;
            if (!phase) {
              reported = cur.done;
            }
            progress.report({ increment, message: fmtMsg(false) });
          };
          // The $(sync~spin) icon shares this entry, so changing the text restarts
          // its spin. The timer below ticks at the spin's rotation period so each
          // restart lands on a completed turn (invisible) rather than snapping the
          // icon back mid-rotation.
          const renderStatus = (): void => {
            status.text = `$(sync~spin) C/C++ Blitz: ${fmtMsg(true)}`;
          };
          pool.onProgress = (p) => {
            cur = p;
            renderNotification();
          };
          pool.onPhase = (label) => {
            phase = label;
            renderNotification();
            renderStatus(); // a phase change is rare — updating the status now is fine
          };
          renderNotification();
          renderStatus();
          // Tick the elapsed clock and refresh the status text even while a slow
          // file parses or the index builds. The period matches the spinner's
          // rotation so each text change (which restarts the spin) lands on a
          // completed turn — keeping the icon visually smooth.
          const timer = setInterval(() => {
            renderNotification();
            renderStatus();
          }, SPIN_PERIOD_MS);
          try {
            await pool.indexAll(toIndex, { rebuildIndexes: useBulkRebuild });
          } finally {
            clearInterval(timer);
            pool.onProgress = undefined;
            pool.onPhase = undefined;
          }
        },
      );
      relations.refresh();
      if (stopRequested) {
        output.appendLine(
          `[C/C++ Blitz] indexing stopped by user — partial index kept; run Rescan to finish`,
        );
      } else {
        output.appendLine(
          `[C/C++ Blitz] indexed ${toIndex.length}, removed ${toRemove.length}, total ${files.length}`,
        );
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      output.appendLine(`[C/C++ Blitz] indexing FAILED: ${(e as Error)?.stack ?? msg}`);
      vscode.window.showErrorMessage(
        `C/C++ Blitz: indexing failed — ${msg}. See the "C/C++ Blitz" output channel.`,
      );
    } finally {
      const stopped = stopRequested;
      bulkActive = false;
      bulkDropsIndexes = false;
      indexing.end();
      updateBusyIndicator();
      lastScanMs = Date.now() - scanStart;
      showIdleStatus();
      // Friendly closure for a force-stop: the partial index is queryable now
      // (the search indexes were rebuilt during the finalize), so say so and how
      // to finish. Read the count after reads resume (above) so it isn't 0.
      if (stopped) {
        const n = currentSymbolCount();
        void vscode.window.showInformationMessage(
          `C/C++ Blitz: indexing stopped — partial index ready (${n.toLocaleString()} symbols). Run Rescan to finish.`,
        );
      }
    }
  }

  showIdleStatus();
  void runIndex(devMode);
}

export async function deactivate(): Promise<void> {
  await host?.worker?.dispose();
  host?.closeDb();
  host = undefined;
}

// ---- helpers ----

function isCcpp(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'c' || doc.languageId === 'cpp';
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

// Short human duration for the menu (sub-second precision, unlike fmtElapsed).
function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function mtimeOf(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return -1;
  }
}

// Content hash matching the worker's stored hash (indexFile.hashText), used by
// the optional `indexing.verifyContentHash` path to skip re-parsing a file whose
// mtime moved but whose contents are identical. Reads the file on the host, so
// it is opt-in. null on read failure → treated as changed (re-indexed).
function hashOfFile(file: string): string | null {
  try {
    return hashText(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readPrevMeta(dbPath: string): Map<string, FileMeta> {
  if (!fs.existsSync(dbPath)) {
    return new Map();
  }
  try {
    const rdb = openDb(dbPath, { readonly: true });
    const meta = getFileMeta(rdb);
    rdb.close();
    return meta;
  } catch {
    return new Map();
  }
}

function computeDbPath(context: vscode.ExtensionContext, cfg: vscode.WorkspaceConfiguration): string {
  const loc = (cfg.get<string>('db.location', '') ?? '').trim();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'noworkspace';
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const base = loc || context.storageUri?.fsPath || context.globalStorageUri.fsPath;
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `sintra-${hash}.db`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: Parameters<T>) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}
