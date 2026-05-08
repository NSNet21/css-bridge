import * as vscode from 'vscode';
import { AttributeInfo } from '../parsers/jsxParser';
import { resolveCssImports } from '../parsers/importResolver';
import { parseSelectors } from '../parsers/cssParser';

export function findCssLocations(
  document: vscode.TextDocument,
  attr: AttributeInfo
): vscode.Location[] {
  const cssFiles = resolveCssImports(document.fileName);
  const locations: vscode.Location[] = [];

  for (const cssFile of cssFiles) {
    const selectors = parseSelectors(cssFile);
    for (const sel of selectors) {
      if (sel.type === attr.type && sel.rawName === attr.value) {
        const pos = new vscode.Position(sel.line - 1, sel.column);
        locations.push(new vscode.Location(vscode.Uri.file(cssFile), pos));
      }
    }
  }

  return locations;
}
