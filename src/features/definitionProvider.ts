import * as vscode from 'vscode';
import type { Host } from '../core/host';
import type { openDb } from '../store/db';
import type { DocumentLike, PositionLike } from './memberAccess';
import { awaitFreshIndex, resolveDefinition } from './resolve';

type DB = ReturnType<typeof openDb>;

/**
 * Map the resolver's result to F12 locations. Three outcomes, matching how a
 * VS Code DefinitionProvider signals intent:
 *   - `vscode.Location[]` — the definition(s) to jump to;
 *   - `[]` — *block* the jump (cursor on an undefined config macro in a `#if`);
 *   - `null` — abstain (no word / unknown identifier), letting nothing navigate.
 * Pure over the DB so it is unit-testable without launching VS Code.
 */
export function provideDefinitionLocations(
  db: DB | undefined,
  document: DocumentLike,
  position: PositionLike,
): vscode.Location[] | null {
  const res = resolveDefinition(db, document, position);
  if (!res) {
    return null;
  }
  if (res.hits.length > 0) {
    return res.hits.map(
      (h) => new vscode.Location(vscode.Uri.file(h.file), new vscode.Position(h.line, Math.max(0, h.col))),
    );
  }
  return res.blocked ? [] : null;
}

// Optional DefinitionProvider: when registered, the built-in F12 / Ctrl+Click /
// Peek Definition / right-click "Go to Definition" all resolve through our
// tree-sitter index — exactly like a first-class language extension.
//
// VS Code MERGES results from every DefinitionProvider, so this is only sound
// when the MS C/C++ extension's IntelliSense (or any other C/C++ definition
// source) is disabled — otherwise our hits mix with theirs, which is the broken
// behaviour this project exists to avoid. This is always registered (disabling
// MS IntelliSense is a project requirement); the dedicated `cBlitz.goToDefinition`
// command stays available in the Command Palette as a never-merging fallback.
export function registerDefinitionProvider(context: vscode.ExtensionContext, host: Host): void {
  const provider: vscode.DefinitionProvider = {
    async provideDefinition(document, position) {
      await awaitFreshIndex(host); // let a fast in-flight reindex settle first
      // VS Code jumps for a single hit and shows a peek list for several.
      return provideDefinitionLocations(host.getDb(), document, position);
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider([{ language: 'c' }, { language: 'cpp' }], provider),
  );
}
