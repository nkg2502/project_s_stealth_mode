import * as vscode from 'vscode';

// Cursor/word helpers and location navigation shared by the features.

const IDENTIFIER = /[A-Za-z_]\w*/;

export function wordRangeAt(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  return doc.getWordRangeAtPosition(pos, IDENTIFIER);
}

export function wordAt(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
  const range = doc.getWordRangeAtPosition(pos, IDENTIFIER);
  return range ? doc.getText(range) : undefined;
}

export async function revealLocation(file: string, line: number, col: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  const pos = new vscode.Position(line, Math.max(0, col));
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * Open the target location in the editor group **beside** the current one
 * (or create a new column) and then restore focus to the original editor.
 * Used by the Relations view so clicking a row previews code on the side
 * without losing the user's cursor position.
 */
export async function revealLocationBeside(file: string, line: number, col: number): Promise<void> {
  const originalEditor = vscode.window.activeTextEditor;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const pos = new vscode.Position(line, Math.max(0, col));
  const beside = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    preserveFocus: true,          // don't steal focus
  });
  beside.selection = new vscode.Selection(pos, pos);
  beside.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

  // Restore focus to the original editor (if any) so the cursor stays put.
  if (originalEditor) {
    await vscode.window.showTextDocument(originalEditor.document, {
      viewColumn: originalEditor.viewColumn,
      preserveFocus: false,
    });
  }
}
