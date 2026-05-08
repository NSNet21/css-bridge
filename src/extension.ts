import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CssBridgeDefinitionProvider } from './providers/definition';
import { CssBridgeCodeActionProvider } from './providers/codeAction';
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

export const out = vscode.window.createOutputChannel('CSS Bridge');

export function activate(context: vscode.ExtensionContext) {
  out.appendLine('CSS Bridge activated');
  context.subscriptions.push(out);

  // F12 / Ctrl+Click — Go to Definition
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      DOC_SELECTOR,
      new CssBridgeDefinitionProvider()
    )
  );

  // CodeAction — create rule / create CSS file + import
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      DOC_SELECTOR,
      new CssBridgeCodeActionProvider()
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

  // Execute: append rule to existing CSS file + jump cursor into block
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cssBridge.createRule',
      async (cssFile: string, selector: string) => {
        const uri = vscode.Uri.file(cssFile);
        const doc = await vscode.workspace.openTextDocument(uri);

        // Insert via WorkspaceEdit so VS Code tracks exact position
        const endPos = doc.lineAt(doc.lineCount - 1).range.end;
        const rule = `\n${selector} {\n\t\n}\n`;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, endPos, rule);
        await vscode.workspace.applyEdit(edit);
        await doc.save();

        invalidateCache(cssFile);

        // Cursor inside braces: endPos.line + 1 = selector line, +2 = \t line
        const cursorPos = new vscode.Position(endPos.line + 2, 1);
        const config = vscode.workspace.getConfiguration('cssBridge');
        const openLocation = config.get<string>('openLocation', 'right');
        await openInLocation(uri, cursorPos, openLocation);
      }
    )
  );

  // Execute: create new CSS file + add import + append rule + jump
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cssBridge.createFileAndImport',
      async (jsxFile: string, cssFile: string, selector: string) => {
        // Create CSS file with initial rule
        const rule = `${selector} {\n\t\n}\n`;
        fs.writeFileSync(cssFile, rule, 'utf-8');

        // Add import to JSX file (after last existing import line)
        const jsxDoc = await vscode.workspace.openTextDocument(jsxFile);
        const jsxText = jsxDoc.getText();
        const lines = jsxText.split('\n');
        let lastImportLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trimStart().startsWith('import ')) lastImportLine = i;
        }
        const insertLine = lastImportLine + 1;
        const importStatement = `import './${path.basename(cssFile)}';\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          vscode.Uri.file(jsxFile),
          new vscode.Position(insertLine, 0),
          importStatement
        );
        await vscode.workspace.applyEdit(edit);

        // Open CSS file and place cursor inside the rule block
        const cssUri = vscode.Uri.file(cssFile);
        const cursorPos = new vscode.Position(1, 1); // inside selector { | }
        const config = vscode.workspace.getConfiguration('cssBridge');
        const openLocation = config.get<string>('openLocation', 'right');
        await openInLocation(cssUri, cursorPos, openLocation);
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

  const splitCommand: Record<string, string> = {
    left:  'workbench.action.splitEditorLeft',
    above: 'workbench.action.splitEditorUp',
    below: 'workbench.action.splitEditorDown',
  };

  await vscode.commands.executeCommand(splitCommand[location]);
  await vscode.window.showTextDocument(uri, { selection, viewColumn: vscode.ViewColumn.Active });
}

export function deactivate() {}
