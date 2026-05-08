import * as vscode from 'vscode';
import { CssBridgeDefinitionProvider } from './providers/definition';
import { peekCssRule } from './providers/peek';
import { getAttributeAtCursor } from './parsers/jsxParser';
import { findCssLocations } from './utils/findLocations';
import { showDisambiguationPick } from './utils/quickPick';
import { invalidateCache } from './parsers/cssParser';

const DOC_SELECTOR: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'typescript' },
  { language: 'javascriptreact' },
  { language: 'typescriptreact' },
];

export function activate(context: vscode.ExtensionContext) {
  // F12 / Ctrl+Click — Go to Definition
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      DOC_SELECTOR,
      new CssBridgeDefinitionProvider()
    )
  );

  // Peek CSS (Alt+F12 / Ctrl+K Ctrl+P)
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      'cssBridge.peekRule',
      (editor) => peekCssRule(editor, editor.selection.active)
    )
  );

  // Explicit Jump — respects openLocation setting + custom QuickPick for disambiguation
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      'cssBridge.jumpToRule',
      async (editor) => {
        const attr = getAttributeAtCursor(editor.document, editor.selection.active);
        if (!attr) return;

        const locations = findCssLocations(editor.document, attr);
        if (locations.length === 0) return;

        const target = locations.length === 1
          ? locations[0]
          : await showDisambiguationPick(locations);

        if (!target) return;

        const config = vscode.workspace.getConfiguration('cssBridge');
        const openLocation = config.get<string>('openLocation', 'right');
        await openInLocation(target.uri, target.range.start, openLocation);
      }
    )
  );

  // Invalidate CSS cache when files change
  const cssWatcher = vscode.workspace.createFileSystemWatcher('**/*.css');
  context.subscriptions.push(
    cssWatcher,
    cssWatcher.onDidChange(uri => invalidateCache(uri.fsPath)),
    cssWatcher.onDidDelete(uri => invalidateCache(uri.fsPath)),
  );
}

async function openInLocation(
  uri: vscode.Uri,
  position: vscode.Position,
  location: string
): Promise<void> {
  const selection = new vscode.Range(position, position);

  if (location === 'active') {
    await vscode.window.showTextDocument(uri, { selection, viewColumn: vscode.ViewColumn.Active });
    return;
  }

  if (location === 'right') {
    await vscode.window.showTextDocument(uri, { selection, viewColumn: vscode.ViewColumn.Beside });
    return;
  }

  // left / above / below — split current editor in the given direction, then open
  const splitCommand: Record<string, string> = {
    left:  'workbench.action.splitEditorLeft',
    above: 'workbench.action.splitEditorUp',
    below: 'workbench.action.splitEditorDown',
  };

  await vscode.commands.executeCommand(splitCommand[location]);
  await vscode.window.showTextDocument(uri, { selection, viewColumn: vscode.ViewColumn.Active });
}

export function deactivate() {}
