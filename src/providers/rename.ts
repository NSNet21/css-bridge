import * as vscode from 'vscode';
import * as fs from 'fs';
import { findScopeBoundary, globFiles } from '../utils/scopeBoundary';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { indexJsxFile, buildLineOffsets, tokenToRange } from '../parsers/jsxClassIndex';
import { logV } from '../extension';

// Detect cursor position in a CSS selector (.foo or #foo) — returns token info or null
function getCssSelectorAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position
): { type: 'class' | 'id'; value: string; range: vscode.Range } | null {
  const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
  if (!wordRange) return null;
  const word = document.getText(wordRange);

  // Check character immediately before the word
  const charBefore = wordRange.start.character > 0
    ? document.getText(new vscode.Range(
        wordRange.start.translate(0, -1),
        wordRange.start
      ))
    : '';

  if (charBefore === '.') return { type: 'class', value: word, range: wordRange };
  if (charBefore === '#') return { type: 'id',    value: word, range: wordRange };
  return null;
}

// Find all occurrences of a class/id token in a JSX/TS file and return TextEdits.
// Uses the AST-based index so dynamic className expressions (template literals,
// ternaries, clsx() args) get renamed too — not just plain `className="..."`.
function editsInJsxFile(
  filePath: string,
  type: 'class' | 'id',
  oldName: string,
  newName: string
): vscode.TextEdit[] {
  const tokens = indexJsxFile(filePath);
  const matches = tokens.filter(t => t.type === type && t.value === oldName);
  if (matches.length === 0) return [];

  // Prefer the live document's positionAt when the file is open — keeps offsets
  // consistent with anything the user typed since the last disk write. Fallback
  // to a manual line table for files we'd otherwise have to read twice.
  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
  if (doc) {
    return matches.map(t =>
      vscode.TextEdit.replace(
        new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end)),
        newName,
      ),
    );
  }

  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const lineOffsets = buildLineOffsets(raw);
  return matches.map(t => vscode.TextEdit.replace(tokenToRange(t, lineOffsets), newName));
}

// Find all CSS selector occurrences and return TextEdits
function editsInCssFile(
  filePath: string,
  type: 'class' | 'id',
  oldName: string,
  newName: string
): vscode.TextEdit[] {
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const edits: vscode.TextEdit[] = [];
  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);

  // Build a regex to find each exact selector occurrence in the raw text
  // Escaped for special regex chars in selector names
  const escaped = oldName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const selectorPattern = new RegExp(
    (type === 'class' ? '\\.': '#') + escaped + '(?=[\\s,{:#.\\[)>~+]|$)',
    'g'
  );

  let match: RegExpExecArray | null;
  while ((match = selectorPattern.exec(content)) !== null) {
    // +1 to skip the '.' or '#'
    const nameOffset = match.index + 1;
    const startPos = offsetToPosition(content, nameOffset, doc);
    const endPos   = offsetToPosition(content, nameOffset + oldName.length, doc);
    edits.push(vscode.TextEdit.replace(new vscode.Range(startPos, endPos), newName));
  }

  return edits;
}

function offsetToPosition(
  text: string,
  offset: number,
  doc?: vscode.TextDocument
): vscode.Position {
  if (doc) {
    return doc.positionAt(offset);
  }
  // Manual conversion when document isn't open
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 0; } else { col++; }
  }
  return new vscode.Position(line, col);
}

export class CssBridgeRenameProvider implements vscode.RenameProvider {

  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Range | null {
    if (document.languageId === 'css') {
      const info = getCssSelectorAtCursor(document, position);
      return info ? info.range : null;
    }
    const attr = getAttributeAtCursor(document, position);
    return attr ? attr.range : null;
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): Promise<vscode.WorkspaceEdit | null> {
    logV(`[rename] doc=${document.languageId} pos=${position.line}:${position.character} newName="${newName}"`);
    let type: 'class' | 'id';
    let oldName: string;

    if (document.languageId === 'css') {
      const info = getCssSelectorAtCursor(document, position);
      if (!info) return null;
      ({ type, value: oldName } = info);
    } else {
      const attr = getAttributeAtCursor(document, position);
      if (!attr) return null;
      ({ type, value: oldName } = attr);
    }

    const scope = findScopeBoundary(document.fileName);
    const edit  = new vscode.WorkspaceEdit();
    const locations: vscode.Location[] = [];

    // CSS files
    const cssFiles = globFiles(scope, ['.css']);
    for (const file of cssFiles) {
      const fileEdits = editsInCssFile(file, type, oldName, newName);
      if (fileEdits.length > 0) {
        const uri = vscode.Uri.file(file);
        edit.set(uri, fileEdits);
        for (const e of fileEdits) locations.push(new vscode.Location(uri, e.range));
      }
    }

    // JSX/TSX/JS/TS files
    const jsxFiles = globFiles(scope, ['.js', '.ts', '.jsx', '.tsx']);
    for (const file of jsxFiles) {
      const fileEdits = editsInJsxFile(file, type, oldName, newName);
      if (fileEdits.length > 0) {
        const uri = vscode.Uri.file(file);
        const existing = edit.get(uri) ?? [];
        edit.set(uri, [...existing, ...fileEdits]);
        for (const e of fileEdits) locations.push(new vscode.Location(uri, e.range));
      }
    }

    logV(`[rename] type=${type} oldName="${oldName}" totalEdits=${locations.length}`);

    // Show References panel after edits are applied so content reflects new names
    if (locations.length > 0) {
      setTimeout(() => {
        vscode.commands.executeCommand(
          'editor.action.showReferences',
          document.uri,
          position,
          locations
        );
      }, 150);
    }

    return edit;
  }
}
