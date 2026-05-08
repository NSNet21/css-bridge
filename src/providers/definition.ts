import * as vscode from 'vscode';
import { getAttributeAtCursor } from '../parsers/jsxParser';
import { findCssLocations } from '../utils/findLocations';

export class CssBridgeDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | null {
    const attr = getAttributeAtCursor(document, position);
    if (!attr) return null;

    const locations = findCssLocations(document, attr);
    if (locations.length === 0) return null;

    return locations;
  }
}
