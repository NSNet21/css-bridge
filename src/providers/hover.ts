import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';
import { logV } from '../extension';

/**
 * Hover preview — show the matching CSS rule body in a tooltip without
 * stealing focus or opening another tab. Reuses `findCssLocations`, so it
 * inherits direct-import-first / workspace-fallback behavior automatically.
 *
 * Multi-match: render every matching rule, headed with the source filename.
 */
export class CssBridgeHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const attr = getAttributeAtCursor(document, position);
    logV(`[hover] pos=${position.line}:${position.character} attr=${JSON.stringify(attr)}`);
    if (!attr) return null;

    const locations = findCssLocations(document, attr);
    logV(`[hover] found ${locations.length} location(s)`);
    if (locations.length === 0) return null;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    for (const loc of locations) {
      const body = readRuleBody(loc.uri.fsPath, loc.range.start.line);
      if (!body) continue;
      md.appendMarkdown(`**${path.basename(loc.uri.fsPath)}** &middot; line ${loc.range.start.line + 1}\n`);
      md.appendCodeblock(body, 'css');
    }
    if (md.value.length === 0) return null;

    return new vscode.Hover(md, attr.range);
  }
}

/**
 * Read the rule starting at `selectorLine` and return the full text including
 * selector and braces. Stops at the closing `}` (depth-tracked so nested rules
 * inside `@media`/`@supports` survive).
 */
function readRuleBody(filePath: string, selectorLine: number): string | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  } catch {
    return null;
  }
  if (selectorLine >= lines.length) return null;

  const collected: string[] = [];
  let depth = 0;
  let started = false;

  for (let i = selectorLine; i < lines.length; i++) {
    const line = lines[i];
    collected.push(line);
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started && depth === 0) break;
    // Safety: don't preview unreasonably long rules
    if (collected.length > 40) {
      collected.push('  /* ... truncated */');
      break;
    }
  }

  return collected.join('\n');
}
