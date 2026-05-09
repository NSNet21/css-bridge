import * as vscode from 'vscode';
import { AttributeInfo } from '../parsers/jsxParser';
import { resolveCssImports } from '../parsers/importResolver';
import { parseSelectors } from '../parsers/cssParser';
import { resolveWorkspaceCss } from './resolveWorkspaceCss';

/**
 * Find every CSS rule matching a className/id, with direct imports first and
 * project-wide CSS as a fallback.
 *
 * v1.1.0: child components no longer need to re-import CSS that a parent
 * already imports. We walk the current file's direct imports first (preserves
 * existing UX — direct match jumps without disambiguation), then fall back to
 * the union of every CSS imported anywhere in the project scope.
 *
 * Disable workspace fallback via `cssBridge.includeWorkspaceCss: false`.
 */
export function findCssLocations(
  document: vscode.TextDocument,
  attr: AttributeInfo
): vscode.Location[] {
  const direct = resolveCssImports(document.fileName);
  const directHits = collectMatches(direct, attr);
  if (directHits.length > 0) return directHits;

  const config = vscode.workspace.getConfiguration('cssBridge');
  if (config.get<boolean>('includeWorkspaceCss', true)) {
    const workspace = resolveWorkspaceCss(document.fileName)
      .filter(f => !direct.includes(f));
    return collectMatches(workspace, attr);
  }
  return [];
}

function collectMatches(
  cssFiles: string[],
  attr: AttributeInfo
): vscode.Location[] {
  const locations: vscode.Location[] = [];
  for (const cssFile of cssFiles) {
    for (const sel of parseSelectors(cssFile)) {
      if (sel.type === attr.type && sel.rawName === attr.value) {
        const pos = new vscode.Position(sel.line - 1, sel.column);
        locations.push(new vscode.Location(vscode.Uri.file(cssFile), pos));
      }
    }
  }
  return locations;
}
