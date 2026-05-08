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

        const config = vscode.workspace.getConfiguration('cssBridge');
        const openBeside = config.get<string>('openLocation') === 'beside';
        const viewColumn = openBeside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;

        const target = locations.length === 1
          ? locations[0]
          : await showDisambiguationPick(locations);

        if (!target) return;

        await vscode.window.showTextDocument(target.uri, {
          selection: new vscode.Range(target.range.start, target.range.start),
          viewColumn,
        });
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

export function deactivate() {}
