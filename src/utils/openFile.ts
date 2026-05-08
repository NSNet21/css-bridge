import * as vscode from 'vscode';

export async function openInLocation(
  uri: vscode.Uri,
  position: vscode.Position,
  location: string
): Promise<void> {
  const selection = new vscode.Range(position, position);
  const viewColumn = location === 'active'
    ? vscode.ViewColumn.Active
    : vscode.ViewColumn.Beside;
  await vscode.window.showTextDocument(uri, { selection, viewColumn });
}
