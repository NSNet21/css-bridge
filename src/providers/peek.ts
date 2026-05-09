import * as vscode from 'vscode';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';
import { getCssTokenAtCursor, findJsxLocationsForSelector } from './definition';

export async function peekCssRule(
  editor: vscode.TextEditor,
  position: vscode.Position
): Promise<void> {
  const doc = editor.document;
  let locations: vscode.Location[] = [];

  if (doc.languageId === 'css') {
    // CSS → JSX: peek the JSX usages of the selector under the cursor
    const token = getCssTokenAtCursor(doc, position);
    if (!token) return;
    locations = findJsxLocationsForSelector(doc.fileName, token.type, token.value);
  } else {
    // JSX/TSX → CSS: peek the CSS rule the className/id resolves to
    const attr = getAttributeAtCursor(doc, position);
    if (!attr) return;
    locations = findCssLocations(doc, attr);
  }

  if (locations.length === 0) return;

  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    doc.uri,
    position,
    locations,
    'peek'
  );
}
