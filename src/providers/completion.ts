import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveCssImports } from '../parsers/importResolver';
import { parseSelectors } from '../parsers/cssParser';
import { findScopeBoundary, globFiles } from '../utils/scopeBoundary';
import { stripComments } from '../utils/stripComments';

function getAttributeContext(
  document: vscode.TextDocument,
  position: vscode.Position
): { type: 'class' | 'id' } | null {
  // Strip comments on the full document so commented-out attributes don't
  // trigger autocomplete suggestions.
  const cursorOffset = document.offsetAt(position);
  const stripped = stripComments(document.getText());
  const searchStart = Math.max(0, position.line - 10);
  const startOffset = document.offsetAt(new vscode.Position(searchStart, 0));
  const textBefore = stripped.substring(startOffset, cursorOffset);
  // Lookbehind (?<![\w-]) avoids false-matching myClassName=, data-id=, aria-id=, etc.
  if (/(?<![\w-])className\s*=\s*["'][^"']*$/.test(textBefore)) return { type: 'class' };
  if (/(?<![\w-])id\s*=\s*["'][^"']*$/.test(textBefore)) return { type: 'id' };
  return null;
}

function extractNamesFromFile(filePath: string, type: 'class' | 'id'): string[] {
  try {
    // Blank-out comments — names mentioned in `// className="foo"` notes
    // shouldn't pollute the suggestion list.
    const content = stripComments(fs.readFileSync(filePath, 'utf-8'));
    const pattern = type === 'class'
      ? /(?<![\w-])className\s*=\s*["']([^"']+)["']/g
      : /(?<![\w-])id\s*=\s*["']([^"']+)["']/g;
    const names: string[] = [];
    let match;
    while ((match = pattern.exec(content)) !== null) {
      for (const v of match[1].trim().split(/\s+/)) {
        if (v) names.push(v);
      }
    }
    return names;
  } catch {
    return [];
  }
}

// 5.1 — JSX/TSX side: suggest selectors from imported CSS files
export class JsxCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const ctx = getAttributeContext(document, position);
    if (!ctx) return;

    const cssFiles = resolveCssImports(document.fileName);
    if (cssFiles.length === 0) return;

    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];

    for (const cssFile of cssFiles) {
      for (const sel of parseSelectors(cssFile)) {
        if (sel.type !== ctx.type) continue;
        if (seen.has(sel.rawName)) continue;
        seen.add(sel.rawName);

        const item = new vscode.CompletionItem(sel.rawName, vscode.CompletionItemKind.Value);
        item.detail = sel.selector;
        item.documentation = new vscode.MarkdownString(
          `Defined in \`${path.basename(cssFile)}\``
        );
        items.push(item);
      }
    }
    return items;
  }
}

// 5.2 — CSS side: suggest class/id names collected from JSX/TSX/JS/TS files in scope
export class CssCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // Detect selector position from line content (immune to VS Code color-picker interference).
    // Pattern: optional whitespace/commas, then '.' or '#', then partial name.
    const classMatch = /^[\s,]*\.[\w-]*$/.test(textBeforeCursor);
    const idMatch    = /^[\s,]*#[\w-]*$/.test(textBeforeCursor);
    if (!classMatch && !idMatch) return;

    const type = classMatch ? 'class' : 'id';
    const prefix = type === 'class' ? '.' : '#';
    const scope = findScopeBoundary(document.fileName);
    const files = globFiles(scope, ['.js', '.ts', '.jsx', '.tsx']);

    // Replace range covers the existing prefix + any partial name the user has typed,
    // so accepting an item produces e.g. `#main-nav` regardless of whether they typed
    // just `#` or `#mai`. Without this the `#` would either be dropped or duplicated.
    const partialMatch = textBeforeCursor.match(/[#.][\w-]*$/);
    const replaceStart = partialMatch
      ? new vscode.Position(position.line, position.character - partialMatch[0].length)
      : position;
    const replaceRange = new vscode.Range(replaceStart, position);

    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];

    for (const filePath of files) {
      for (const name of extractNamesFromFile(filePath, type)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Value);
        item.detail = `${prefix}${name}`;
        // VS Code filters by `filterText` against what the user typed at the
        // replace range. Including the prefix makes typing `#m` match `main-nav`.
        item.filterText = `${prefix}${name}`;
        item.insertText = `${prefix}${name}`;
        item.range = replaceRange;
        items.push(item);
      }
    }
    return items;
  }
}
