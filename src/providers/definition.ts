import * as vscode from 'vscode';
import * as fs from 'fs';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';
import { findScopeBoundary, globFiles } from '../utils/scopeBoundary';
import { indexJsxFile, buildLineOffsets, tokenToRange } from '../parsers/jsxClassIndex';
import { parseVars } from '../parsers/cssParser';
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

// ───────────────────────────────────────────────────────────────────────────
// v1.3.0: CSS variable jump
// ───────────────────────────────────────────────────────────────────────────
// Detects whether the cursor sits on a `--name` token in CSS, classifying it
// as a *use* (`var(--name)`) or *definition* (`--name:`). Returning `null`
// lets the existing `.foo` / `#bar` selector branch (or the VS Code default)
// stay in charge — we only intercept when we positively recognize a var.

export function getCssVarAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position
): { type: 'var-use' | 'var-def'; name: string; range: vscode.Range } | null {
  // Anchor on the leading `--` so any cursor position from `-` through the
  // last name char resolves to the same range. Without `--` in the regex,
  // cursor on `primary` would shrink the match and we'd miss the prefix.
  const wordRange = document.getWordRangeAtPosition(position, /--[\w-]+/);
  if (!wordRange) return null;

  const word = document.getText(wordRange);
  if (!word.startsWith('--')) return null; // defensive — regex anchored on --
  const name = word.slice(2);
  if (!name) return null;

  const lineText = document.lineAt(position.line).text;
  const before = lineText.substring(0, wordRange.start.character);
  const after = lineText.substring(wordRange.end.character);

  // Use site: `var(  --name` — allow whitespace between `(` and `--`.
  // Multi-line `var(\n  --name` isn't covered (we only see the cursor's line);
  // that's an acceptable trade-off — virtually no CSS in the wild splits var()
  // across lines, and supporting it would require scanning backwards for `(`.
  if (/\bvar\(\s*$/.test(before)) {
    return { type: 'var-use', name, range: wordRange };
  }

  // Def site: `--name:` — `:` may follow whitespace. Don't require `--name` to
  // be at line start (selectors can have arbitrary whitespace before the decl).
  if (/^\s*:/.test(after)) {
    return { type: 'var-def', name, range: wordRange };
  }

  return null;
}

export function findVarDefLocations(
  cssFilePath: string,
  name: string
): vscode.Location[] {
  const scope = findScopeBoundary(cssFilePath);
  const files = globFiles(scope, ['.css']);
  const locations: vscode.Location[] = [];

  for (const filePath of files) {
    const { defs } = parseVars(filePath);
    for (const def of defs) {
      if (def.name !== name) continue;
      const range = makeVarRange(def.line, def.column, name);
      locations.push(new vscode.Location(vscode.Uri.file(filePath), range));
    }
  }
  return locations;
}

export function findVarUseLocations(
  cssFilePath: string,
  name: string
): vscode.Location[] {
  const scope = findScopeBoundary(cssFilePath);
  const files = globFiles(scope, ['.css']);
  const locations: vscode.Location[] = [];

  for (const filePath of files) {
    const { uses } = parseVars(filePath);
    for (const use of uses) {
      if (use.name !== name) continue;
      const range = makeVarRange(use.line, use.column, name);
      locations.push(new vscode.Location(vscode.Uri.file(filePath), range));
    }
  }
  return locations;
}

/**
 * Build a `vscode.Range` covering the `--name` slice. `line` is 1-based
 * (postcss / our offset helper convention), `column` is 0-based and points
 * to the first `-`. Length is always `2 + name.length` so the range matches
 * what the user actually clicked on.
 */
function makeVarRange(line: number, column: number, name: string): vscode.Range {
  const startLine = Math.max(0, line - 1);
  const endChar = column + 2 + name.length;
  return new vscode.Range(startLine, column, startLine, endChar);
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
      // v1.3.0: try `var(--foo)` / `--foo:` first. Selector detection runs
      // after so `.foo` and `--foo` don't fight over the cursor — they live
      // in disjoint syntactic contexts (selectors begin with `.`/`#`, vars
      // with `--`), so order is purely about which check we run first.
      const cssVar = getCssVarAtCursor(document, position);
      if (cssVar) {
        if (cssVar.type === 'var-use') {
          logV(`[definition] CSS-var use "--${cssVar.name}"`);
          const defs = findVarDefLocations(document.fileName, cssVar.name);
          logV(`[definition] CSS-var use found ${defs.length} definition(s)`);
          return defs.length > 0 ? defs : null;
        } else {
          logV(`[definition] CSS-var def "--${cssVar.name}"`);
          const uses = findVarUseLocations(document.fileName, cssVar.name);
          logV(`[definition] CSS-var def found ${uses.length} usage(s)`);
          return uses.length > 0 ? uses : null;
        }
      }

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
