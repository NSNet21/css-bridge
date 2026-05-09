import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { resolveCssImports } from '../parsers/importResolver';
import { parseSelectors } from '../parsers/cssParser';
import { resolveWorkspaceCss } from '../utils/resolveWorkspaceCss';
import { logV } from '../extension';

export class CssBridgeCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.CodeAction[] {
    const attr = getAttributeAtCursor(document, range.start);
    logV(`[codeAction] pos=${range.start.line}:${range.start.character} attr=${JSON.stringify(attr)}`);
    if (!attr) return [];

    const cssFiles = resolveCssImports(document.fileName);
    const actions: vscode.CodeAction[] = [];
    const config = vscode.workspace.getConfiguration('cssBridge');

    // v1.1.0: before offering to create a brand-new CSS file, check whether the
    // selector already exists in any project-wide CSS (e.g. parent's globals.css).
    // If so, suppress all CodeActions — the selector exists, just not in a file
    // this component directly imports.
    if (config.get<boolean>('includeWorkspaceCss', true)) {
      const workspace = resolveWorkspaceCss(document.fileName)
        .filter(f => !cssFiles.includes(f));
      const existsInWorkspace = workspace.some(f =>
        parseSelectors(f).some(s => s.type === attr.type && s.rawName === attr.value)
      );
      if (existsInWorkspace) return [];
    }

    if (cssFiles.length === 0) {
      // No CSS import at all — offer to create file + import
      if (config.get<boolean>('autoCreateImport', true)) {
        actions.push(createFileAction(document, attr.value, attr.type));
      }
      return actions;
    }

    // CSS imported but selector might be missing
    const allSelectors = cssFiles.flatMap(f => parseSelectors(f));
    const exists = allSelectors.some(
      s => s.type === attr.type && s.rawName === attr.value
    );

    if (!exists) {
      // Offer to create rule in each imported CSS file
      for (const cssFile of cssFiles) {
        actions.push(createRuleAction(attr.value, attr.type, cssFile));
      }
    }

    return actions;
  }
}

function createRuleAction(
  name: string,
  type: 'class' | 'id',
  cssFile: string
): vscode.CodeAction {
  const selector = type === 'class' ? `.${name}` : `#${name}`;
  const label = `Create rule \`${selector}\` in ${path.basename(cssFile)}`;
  const action = new vscode.CodeAction(label, vscode.CodeActionKind.QuickFix);

  action.command = {
    command: 'cssBridge.createRule',
    title: label,
    arguments: [cssFile, selector],
  };

  return action;
}

function createFileAction(
  document: vscode.TextDocument,
  name: string,
  type: 'class' | 'id'
): vscode.CodeAction {
  const baseName = path.basename(document.fileName, path.extname(document.fileName));
  const cssFileName = `${baseName}.css`;
  const cssFilePath = path.join(path.dirname(document.fileName), cssFileName);
  const selector = type === 'class' ? `.${name}` : `#${name}`;
  const label = `Create ${cssFileName} and import`;

  const action = new vscode.CodeAction(label, vscode.CodeActionKind.QuickFix);
  action.command = {
    command: 'cssBridge.createFileAndImport',
    title: label,
    arguments: [document.fileName, cssFilePath, selector],
  };

  return action;
}
