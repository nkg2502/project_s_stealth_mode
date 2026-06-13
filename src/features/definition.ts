import * as vscode from 'vscode';
import type { Host } from '../core/host';
import { revealLocation } from './nav';
import { awaitFreshIndex, resolveDefinition } from './resolve';
import type { DefHit } from './resolve';

// F12: jump to definition using only our tree-sitter index. Scope-aware
// (parameters / locals resolve within their function) via resolveDefinition.

interface DefItem extends vscode.QuickPickItem {
  hit: DefHit;
}

export function registerDefinition(context: vscode.ExtensionContext, host: Host): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('cBlitz.goToDefinition', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      if (host.bulkIndexing) {
        void vscode.window.showInformationMessage(
          'C/C++ Blitz: indexing the workspace — Go to Definition is available once the scan finishes.',
        );
        return;
      }
      if (!host.getDb()) {
        void vscode.window.showInformationMessage('C/C++ Blitz: index not ready yet.');
        return;
      }
      await awaitFreshIndex(host); // let a fast in-flight reindex settle first
      const res = resolveDefinition(host.getDb(), editor.document, editor.selection.active);
      if (!res) {
        return;
      }
      const { word, hits } = res;
      if (hits.length === 0) {
        void vscode.window.showInformationMessage(`C/C++ Blitz: no definition found for "${word}".`);
        return;
      }
      if (hits.length === 1) {
        await revealLocation(hits[0].file, hits[0].line, hits[0].col);
        return;
      }
      const items: DefItem[] = hits.map((h) => ({
        label: `${h.name}  ·  ${h.kind}`,
        description: `${vscode.workspace.asRelativePath(h.file)}:${h.line + 1}`,
        hit: h,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${hits.length} definitions of "${word}"`,
        matchOnDescription: true,
      });
      if (pick) {
        await revealLocation(pick.hit.file, pick.hit.line, pick.hit.col);
      }
    }),
  );
}
