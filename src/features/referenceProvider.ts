import * as vscode from 'vscode';
import type { Host } from '../core/host';
import { awaitFreshIndex, resolveReferences } from './resolve';

// Optional ReferenceProvider so the built-in Find All References (Shift+F12),
// Go to References, and the References side view all resolve through our index —
// scope-aware (a parameter/local lists only its in-function uses). Like the
// DefinitionProvider, VS Code merges providers, so this assumes the MS C/C++
// extension's IntelliSense is disabled (a project requirement); it is always registered.
export function registerReferenceProvider(context: vscode.ExtensionContext, host: Host): void {
  const provider: vscode.ReferenceProvider = {
    async provideReferences(document, position) {
      await awaitFreshIndex(host); // let a fast in-flight reindex settle first
      return resolveReferences(host, document, position);
    },
  };
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider([{ language: 'c' }, { language: 'cpp' }], provider),
  );
}
