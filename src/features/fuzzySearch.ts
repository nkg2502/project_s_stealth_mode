import * as vscode from 'vscode';
import type { Host } from '../core/host';
import { searchSymbolNames } from '../store/db';
import { fuzzyFilterSymbols } from '../store/fuzzyMatch';
import { revealLocation } from './nav';
import { literalFilter, parseQuery } from './fuzzyQuery';
import { displayTag } from '../core/objChain';

// F10: fuzzy symbol search backed by SQLite (includes goto labels). Each
// (debounced) keystroke fetches a bounded candidate set from SQLite
// (searchSymbolNames, subsequence LIKE) and ranks it with the JS fzf matcher —
// no parallel in-memory name list, and the heavy work never runs synchronously
// on the keystroke path, so the extension-host event loop stays responsive.

interface SymItem extends vscode.QuickPickItem {
  name: string;
  dataType?: string;
  file: string;
  line: number;
  col: number;
}

// Debounce keystrokes so a burst of typing collapses into one query instead of
// re-scanning per character (the cause of the old F10 hang / status-bar freeze).
const RENDER_DEBOUNCE_MS = 90;

export function registerFuzzySearch(context: vscode.ExtensionContext, host: Host): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('cBlitz.fuzzySymbolSearch', async () => {
      if (host.bulkIndexing) {
        void vscode.window.showInformationMessage(
          'C/C++ Blitz: indexing the workspace — symbol search is available once the scan finishes.',
        );
        return;
      }
      const db = host.getDb();
      if (!db) {
        void vscode.window.showInformationMessage('C/C++ Blitz: index not ready yet.');
        return;
      }
      const max = vscode.workspace.getConfiguration('cBlitz').get<number>('fuzzy.maxResults', 200);

      const qp = vscode.window.createQuickPick<SymItem>();
      qp.placeholder = 'Search C/C++ symbols — filter by kind: f:func v:var t:type m:member d:macro l:label n:namespace';
      qp.matchOnDescription = true;

      const runQuery = (query: string): void => {
        const pq = parseQuery(query);
        // The kind prefix (`f:`, `t:`, …) and mode markers don't count toward the
        // 2-char minimum — `t:io` is a valid two-letter type search.
        if (pq.term.trim().length < 2) {
          qp.items = [];
          return;
        }
        // SQLite returns a bounded candidate set; the JS ranker orders it.
        const candidates = searchSymbolNames(db, pq.term, { kinds: pq.kinds });
        const matched =
          pq.mode === 'fuzzy'
            ? fuzzyFilterSymbols(candidates, pq.term, max).map((h) => h.item)
            : literalFilter(candidates, pq.term, pq.mode, max);
        qp.items = matched.map((e) => {
          // A synthetic anonymous-aggregate tag (`@anon:…`) is internal — never show it.
          const shownType = displayTag(e.dataType);
          const kindType = shownType ? `${e.kind}, ${shownType}` : e.kind;
          return {
            label: e.name,
            description: `${kindType}  —  ${vscode.workspace.asRelativePath(e.file)}:${e.line}`,
            // We do our own filtering/ranking (parseQuery + searchSymbolNames +
            // fuzzyFilterSymbols). Without alwaysShow, VS Code re-filters these
            // items against the raw input — and a kind prefix like `d:` contains a
            // `:` that no symbol name has, so it would hide every result.
            alwaysShow: true,
            name: e.name,
            dataType: e.dataType,
            file: e.file,
            line: e.line,
            col: e.col,
          };
        });
      };

      let timer: NodeJS.Timeout | undefined;
      const render = (query: string): void => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => runQuery(query), RENDER_DEBOUNCE_MS);
      };

      runQuery('');
      qp.onDidChangeValue(render);
      qp.onDidAccept(async () => {
        const item = qp.selectedItems[0];
        qp.hide();
        if (!item) {
          return;
        }
        await revealLocation(item.file, item.line, item.col);
      });
      qp.onDidHide(() => {
        if (timer) {
          clearTimeout(timer);
        }
        qp.dispose();
      });
      qp.show();
    }),
  );
}
