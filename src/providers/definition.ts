import * as vscode from 'vscode';
import * as fs from 'fs';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';
import { findScopeBoundary, globFiles } from '../utils/scopeBoundary';
import { out } from '../extension';

export function getCssTokenAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position
): { type: 'class' | 'id'; value: string } | null {
  // Case 1: cursor is on the word part (e.g. cursor on "card" in ".card")
  const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
  if (wordRange && wordRange.start.character > 0) {
    const word = document.getText(wordRange);
    const charBefore = document.getText(new vscode.Range(
      wordRange.start.translate(0, -1),
      wordRange.start
    ));
    if (charBefore === '.') return { type: 'class', value: word };
    if (charBefore === '#') return { type: 'id',    value: word };
  }

  // Case 2: cursor is on the prefix character itself ("." or "#")
  const charAtCursor = document.getText(new vscode.Range(position, position.translate(0, 1)));
  if (charAtCursor === '.' || charAtCursor === '#') {
    const nextWordRange = document.getWordRangeAtPosition(position.translate(0, 1), /[\w-]+/);
    if (nextWordRange) {
      const word = document.getText(nextWordRange);
      return { type: charAtCursor === '#' ? 'id' : 'class', value: word };
    }
  }

  return null;
}

function offsetToPosition(text: string, offset: number): vscode.Position {
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 0; } else { col++; }
  }
  return new vscode.Position(line, col);
}

export function findJsxLocationsForSelector(
  cssFilePath: string,
  type: 'class' | 'id',
  name: string
): vscode.Location[] {
  const scope = findScopeBoundary(cssFilePath);
  const files = globFiles(scope, ['.js', '.ts', '.jsx', '.tsx']);

  const locations: vscode.Location[] = [];
  const pattern = type === 'class'
    ? /className\s*=\s*["']([^"']*)["']/g
    : /\bid\s*=\s*["']([^"']*)["']/g;

  for (const filePath of files) {
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const tokens = match[1].split(/\s+/);
      if (!tokens.includes(name)) continue;

      const valueStartOffset = match.index + match[0].indexOf(match[1]);
      let tokenOffset = 0;
      for (const token of tokens) {
        if (token === name) {
          const abs = valueStartOffset + tokenOffset;
          const start = offsetToPosition(content, abs);
          const end   = offsetToPosition(content, abs + name.length);
          locations.push(new vscode.Location(vscode.Uri.file(filePath), new vscode.Range(start, end)));
        }
        tokenOffset += token.length + 1;
      }
    }
  }

  return locations;
}

export class CssBridgeDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | null {

    // CSS → JSX via Ctrl+Click (F12 uses jumpToRule command instead)
    if (document.languageId === 'css') {
      const token = getCssTokenAtCursor(document, position);
      if (!token) return null;
      out.appendLine(`[definition] CSS→JSX ${token.type}="${token.value}"`);
      const locs = findJsxLocationsForSelector(document.fileName, token.type, token.value);
      out.appendLine(`[definition] CSS→JSX found ${locs.length} location(s)`);
      return locs.length > 0 ? locs : null;
    }

    // JSX/TSX → CSS
    const attr = getAttributeAtCursor(document, position);
    out.appendLine(`[definition] pos=${position.line}:${position.character} attr=${JSON.stringify(attr)}`);
    if (!attr) return null;

    const locations = findCssLocations(document, attr);
    out.appendLine(`[definition] found ${locations.length} location(s)`);
    return locations.length > 0 ? locations : null;
  }
}
