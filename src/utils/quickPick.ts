import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface PickItem extends vscode.QuickPickItem {
  location: vscode.Location;
}

export async function showDisambiguationPick(
  locations: vscode.Location[]
): Promise<vscode.Location | undefined> {
  const items: PickItem[] = locations.map(loc => {
    const filePath = loc.uri.fsPath;
    const line = loc.range.start.line;

    let preview = '';
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      // First non-empty line inside the rule body (line after selector)
      preview = lines[line + 1]?.trim() ?? '';
    } catch {
      preview = '';
    }

    return {
      label: `$(symbol-file) ${path.basename(filePath)}`,
      description: `line ${line + 1}`,
      detail: preview || undefined,
      location: loc,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Multiple matches — select one',
    matchOnDescription: true,
  });

  return picked?.location;
}
