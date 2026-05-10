import * as vscode from 'vscode';
import * as fs from 'fs';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';
import { findScopeBoundary, globFiles } from '../utils/scopeBoundary';
import { indexJsxFile, buildLineOffsets, tokenToRange } from '../parsers/jsxClassIndex';
import { logV } from '../extension';

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

export function findJsxLocationsForSelector(
  cssFilePath: string,
  type: 'class' | 'id',
  name: string
): vscode.Location[] {
  const scope = findScopeBoundary(cssFilePath);
  const files = globFiles(scope, ['.js', '.ts', '.jsx', '.tsx']);

  const locations: vscode.Location[] = [];

  for (const filePath of files) {
    const tokens = indexJsxFile(filePath);
    if (tokens.length === 0) continue;
    // Filter first so we only build the line table when we actually have hits.
    const matches = tokens.filter(t => t.type === type && t.value === name);
    if (matches.length === 0) continue;

    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lineOffsets = buildLineOffsets(raw);
    const uri = vscode.Uri.file(filePath);
    for (const t of matches) {
      locations.push(new vscode.Location(uri, tokenToRange(t, lineOffsets)));
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
      logV(`[definition] CSS→JSX ${token.type}="${token.value}"`);
      const locs = findJsxLocationsForSelector(document.fileName, token.type, token.value);
      logV(`[definition] CSS→JSX found ${locs.length} location(s)`);
      return locs.length > 0 ? locs : null;
    }

    // JSX/TSX → CSS
    const attr = getAttributeAtCursor(document, position);
    logV(`[definition] pos=${position.line}:${position.character} attr=${JSON.stringify(attr)}`);
    if (!attr) return null;

    const locations = findCssLocations(document, attr);
    logV(`[definition] found ${locations.length} location(s)`);
    return locations.length > 0 ? locations : null;
  }
}
