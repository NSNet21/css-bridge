import * as vscode from 'vscode';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';

export async function peekCssRule(
  editor: vscode.TextEditor,
  position: vscode.Position
): Promise<void> {
  const attr = getAttributeAtCursor(editor.document, position);
  if (!attr) return;

  const locations = findCssLocations(editor.document, attr);
  if (locations.length === 0) return;

  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    editor.document.uri,
    position,
    locations,
    'peek'
  );
}
