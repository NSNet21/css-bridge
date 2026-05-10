import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface PickItem extends vscode.QuickPickItem {
  location: vscode.Location;
}

export interface DisambiguationPickOptions {
  /**
   * Where to read the preview line relative to the matched location:
   *
   *   - `'next'`  *(default)* — first line **after** the location. Right for
   *     **selectors**, where the location lands on `.foo {` and the body line
   *     below (`color: blue;`) is what users actually want to see.
   *   - `'same'` — the line **at** the location. Right for **CSS variables**
   *     where the location is the `--name` token itself, and the same-line
   *     content (`--primary: #0066cc;`) is the meaningful preview.
   */
  previewMode?: 'next' | 'same';
}

export async function showDisambiguationPick(
  locations: vscode.Location[],
  options: DisambiguationPickOptions = {}
): Promise<vscode.Location | undefined> {
  const previewMode = options.previewMode ?? 'next';

  const items: PickItem[] = locations.map(loc => {
    const filePath = loc.uri.fsPath;
    const line = loc.range.start.line;

    let preview = '';
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const previewLine = previewMode === 'same' ? line : line + 1;
      preview = lines[previewLine]?.trim() ?? '';
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
